/**
 * Encrypted, flow-bound token handoff between the detached OAuth device-flow
 * helper and the session-owned server process (Issue #2329 / #2334 merge).
 *
 * Why this exists:
 * The OAuth helper (oauth-helper.mjs) runs detached, outside the server's
 * dependency-injection/session context. It therefore cannot resolve the
 * session's ITokenStore — in database mode it has no DB pool, master key, or
 * RLS user context, and even in file mode it must not race the server's own
 * writes. Writing the final token from the helper is unsafe.
 *
 * Instead the helper writes the freshly obtained token to a dedicated, encrypted,
 * per-user, flow-bound handoff file. The server validates the matching terminal
 * result and flow id, reads the handoff through this module, stores the token
 * through the session's normal TokenManager/ITokenStore (file OR database),
 * verifies retrieval, then deletes the handoff. The handoff is a transport, never
 * the canonical token — it is distinct from FileTokenStore's github_token.enc so
 * that importing then deleting it can never delete a real credential.
 *
 * Key derivation is deliberately mode-independent: it uses the same passphrase
 * source as FileTokenStore (DOLLHOUSE_TOKEN_SECRET, else a machine-derived
 * passphrase). The helper inherits the server's environment on spawn, so both
 * sides derive the same key regardless of whether the final store is file or
 * database backed. A per-file random salt means each handoff derives a distinct
 * key even from the same passphrase.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const ITERATIONS = 100000;

const HANDOFF_PREFIX = 'oauth-helper-token-';
const HANDOFF_SUFFIX = '.enc';

/** Legacy plaintext artifact from the pre-#2334 helper; removed on sight. */
export const LEGACY_PLAINTEXT_TOKEN_FILE = 'pending_token.txt';

const FLOW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reject any flow id that is not a UUID. The flow id becomes part of the handoff
 * file name, so an unvalidated value would allow path traversal / arbitrary file
 * targeting from either side of the handoff.
 */
function assertFlowId(flowId: string): void {
  if (typeof flowId !== 'string' || !FLOW_ID_RE.test(flowId)) {
    throw new Error('oauthHelperTokenHandoff: flowId must be a UUID');
  }
}

/** Absolute path of the handoff file for a given per-user auth dir and flow id. */
export function handoffTokenPath(authDir: string, flowId: string): string {
  assertFlowId(flowId);
  return path.join(authDir, `${HANDOFF_PREFIX}${flowId}${HANDOFF_SUFFIX}`);
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_LENGTH, 'sha256');
}

function getPassphrase(): string {
  return process.env.DOLLHOUSE_TOKEN_SECRET || getMachinePassphrase();
}

function getMachinePassphrase(): string {
  const hostname = crypto.createHash('sha256').update(homedir()).digest('hex').substring(0, 16);
  const username = crypto.createHash('sha256').update(process.env.USER || 'default').digest('hex').substring(0, 16);
  const appId = 'DollhouseMCP-OAuthHandoff-v1';
  return `${appId}-${hostname}-${username}`;
}

/**
 * Encrypt `token` and write it atomically to the flow-bound handoff file with
 * 0600 permissions inside the 0700 per-user auth dir. Overwrites any stale
 * handoff for the same flow id.
 */
export async function writeHandoffToken(authDir: string, flowId: string, token: string): Promise<void> {
  const tokenPath = handoffTokenPath(authDir, flowId);

  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  await fs.chmod(authDir, 0o700).catch(() => {});

  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(getPassphrase(), salt);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const stored = Buffer.concat([salt, iv, tag, encrypted]).toString('base64');

  // Write to a temp file then rename so a reader never observes a partial file.
  const tmpPath = `${tokenPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, stored, { mode: 0o600 });
  await fs.chmod(tmpPath, 0o600).catch(() => {});
  await fs.rename(tmpPath, tokenPath);
}

/**
 * Read and decrypt the flow-bound handoff token. Returns null when the handoff
 * file is absent. Throws on a present-but-undecryptable file (tamper / wrong key).
 */
export async function readHandoffToken(authDir: string, flowId: string): Promise<string | null> {
  const tokenPath = handoffTokenPath(authDir, flowId);
  let base64Content: string;
  try {
    base64Content = await fs.readFile(tokenPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const stored = Buffer.from(base64Content, 'base64');
  const salt = stored.subarray(0, SALT_LENGTH);
  const iv = stored.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = stored.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encrypted = stored.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  const key = deriveKey(getPassphrase(), salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Delete the flow-bound handoff file if present. Never throws on absence. */
export async function deleteHandoffToken(authDir: string, flowId: string): Promise<void> {
  await fs.unlink(handoffTokenPath(authDir, flowId)).catch(() => {});
}

/**
 * Remove stray handoff artifacts from a per-user auth dir: any leftover
 * encrypted handoff files and the legacy plaintext pending_token.txt. Called on
 * server startup/cleanup so a crashed flow cannot leave a token at rest.
 */
export async function sweepHandoffArtifacts(authDir: string): Promise<void> {
  await fs.unlink(path.join(authDir, LEGACY_PLAINTEXT_TOKEN_FILE)).catch(() => {});
  let entries: string[];
  try {
    entries = await fs.readdir(authDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter(name => name.startsWith(HANDOFF_PREFIX) && name.endsWith(HANDOFF_SUFFIX))
      .map(name => fs.unlink(path.join(authDir, name)).catch(() => {})),
  );
}
