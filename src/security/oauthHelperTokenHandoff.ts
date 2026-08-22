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
 * Key derivation is deliberately mode-independent. An explicitly configured
 * DOLLHOUSE_TOKEN_SECRET is accepted; otherwise a cryptographically random
 * per-user key is created once with 0600 permissions. A per-file random salt
 * and flow-bound HKDF context give every handoff a distinct AEAD key.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  durableAtomicWriteFile,
  syncFilesystemDirectory,
} from './durableFileOperations.js';
import { withFilesystemInterprocessGuard } from './filesystemInterprocessGuard.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 32;
const FORMAT_VERSION = 2;
export const MAX_OAUTH_HELPER_HANDOFF_LIFETIME_MS = 20 * 60 * 1000;

const HANDOFF_PREFIX = 'oauth-helper-token-';
const HANDOFF_SUFFIX = '.enc';
const HANDOFF_KEY_FILE = 'oauth-helper-handoff.key';
const FLOW_LOCK_FILE = 'oauth-helper-flow.lock';
const CANCELLATION_PREFIX = 'oauth-helper-cancelled-';
const CANCELLATION_SUFFIX = '.json';
const HANDOFF_TEMP_SUFFIX = '.tmp';
const HANDOFF_KEY_TEMP_RE = /^oauth-helper-handoff\.key\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/iu;

export interface OAuthHelperFlowLock {
  readonly flowId: string;
  readonly lockId: string;
  readonly expiresAt: number;
}

export interface OAuthHelperCancellationFence {
  readonly flowId: string;
  readonly generation: string;
  readonly cancelledAt: number;
  readonly expiresAt: number;
}

/** @internal Test-only synchronization seam for forced lock interleavings. */
export interface OAuthHelperFlowLockAcquireHooks {
  readonly beforePublish?: () => Promise<void>;
}

/** @internal Test-only synchronization seam for master-key publication failures. */
export interface OAuthHelperMasterKeyPublishHooks {
  readonly beforePublish?: (temporaryPath: string) => Promise<void>;
}

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

function cancellationFencePath(authDir: string, flowId: string): string {
  assertFlowId(flowId);
  return path.join(authDir, `${CANCELLATION_PREFIX}${flowId}${CANCELLATION_SUFFIX}`);
}

function cancellationGuardPath(authDir: string, flowId: string): string {
  return `${cancellationFencePath(authDir, flowId)}.guard`;
}

/** Serialize cancellation with the server-side canonical token import. */
export function withOAuthHelperCancellationGuard<T>(
  authDir: string,
  flowId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withFilesystemInterprocessGuard(cancellationGuardPath(authDir, flowId), operation);
}

/** Publish a durable, flow-specific fence that permanently rejects late completion. */
export async function cancelOAuthHelperFlow(
  authDir: string,
  flowId: string,
  expiresAt = Date.now() + MAX_OAUTH_HELPER_HANDOFF_LIFETIME_MS,
): Promise<OAuthHelperCancellationFence> {
  assertFlowId(flowId);
  await secureAuthDir(authDir);
  return withOAuthHelperCancellationGuard(authDir, flowId, async () => {
    const existing = await readOAuthHelperCancellationFence(authDir, flowId);
    if (existing) return existing;
    const cancelledAt = Date.now();
    const fence: OAuthHelperCancellationFence = {
      flowId,
      generation: crypto.randomUUID(),
      cancelledAt,
      expiresAt: Math.min(
        Math.max(expiresAt, cancelledAt + 1),
        cancelledAt + MAX_OAUTH_HELPER_HANDOFF_LIFETIME_MS,
      ),
    };
    await durableAtomicWriteFile(cancellationFencePath(authDir, flowId), JSON.stringify(fence));
    return fence;
  });
}

export async function isOAuthHelperFlowCancelled(authDir: string, flowId: string): Promise<boolean> {
  return (await readOAuthHelperCancellationFence(authDir, flowId)) !== null;
}

function deriveKey(masterKey: Buffer, salt: Buffer, flowId: string): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    masterKey,
    salt,
    Buffer.from(`DollhouseMCP-OAuthHandoff-v2:${flowId}`, 'utf8'),
    KEY_LENGTH,
  ));
}

async function readMasterKey(keyPath: string): Promise<Buffer> {
  const key = await fs.readFile(keyPath);
  if (key.length !== KEY_LENGTH) {
    key.fill(0);
    throw new Error('OAuth handoff key file has an invalid length');
  }
  await fs.chmod(keyPath, 0o600);
  return key;
}

async function loadMasterKey(
  authDir: string,
  hooks?: OAuthHelperMasterKeyPublishHooks,
): Promise<Buffer> {
  const configured = process.env.DOLLHOUSE_TOKEN_SECRET;
  if (configured) return crypto.createHash('sha256').update(configured, 'utf8').digest();

  await secureAuthDir(authDir);
  const keyPath = path.join(authDir, HANDOFF_KEY_FILE);
  try {
    return await readMasterKey(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const fresh = crypto.randomBytes(KEY_LENGTH);
  const temporaryPath = `${keyPath}.${crypto.randomUUID()}${HANDOFF_TEMP_SUFFIX}`;
  try {
    const handle = await fs.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(fresh);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await hooks?.beforePublish?.(temporaryPath);
    try {
      // Publish a fully written inode and atomically lose to any concurrent
      // creator. The final path is never visible with partial key material.
      await fs.link(temporaryPath, keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    // Remove the temporary hard link before the final directory sync. That
    // makes both publication of the canonical name and removal of the duplicate
    // secret-bearing name durable as one completed directory state.
    await fs.unlink(temporaryPath);
    // Sync even when another process won publication. This call must not return
    // a key that can be used for a durable handoff before its directory entry is
    // itself durable.
    await syncFilesystemDirectory(authDir);
    // Always read the published winner. This covers both our link and a
    // concurrent process that won while our temporary inode was being synced.
    return await readMasterKey(keyPath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
    fresh.fill(0);
  }
}

async function secureAuthDir(authDir: string): Promise<void> {
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  await fs.chmod(authDir, 0o700);
}

/**
 * Encrypt `token` and write it atomically to the flow-bound handoff file with
 * 0600 permissions inside the 0700 per-user auth dir. Overwrites any stale
 * handoff for the same flow id.
 */
export async function writeHandoffToken(
  authDir: string,
  flowId: string,
  token: string,
  expiresAt = Date.now() + MAX_OAUTH_HELPER_HANDOFF_LIFETIME_MS,
  masterKeyHooks?: OAuthHelperMasterKeyPublishHooks,
): Promise<void> {
  const tokenPath = handoffTokenPath(authDir, flowId);
  await secureAuthDir(authDir);
  if (await isOAuthHelperFlowCancelled(authDir, flowId)) {
    throw new Error('OAuth helper flow was cancelled');
  }
  const createdAt = Date.now();
  const boundedExpiresAt = Math.min(expiresAt, createdAt + MAX_OAUTH_HELPER_HANDOFF_LIFETIME_MS);

  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  let masterKey: Buffer | null = null;
  let key: Buffer | null = null;
  let plaintext: Buffer | null = null;
  try {
    masterKey = await loadMasterKey(authDir, masterKeyHooks);
    key = deriveKey(masterKey, salt, flowId);
    plaintext = Buffer.from(JSON.stringify({ token, createdAt, expiresAt: boundedExpiresAt }), 'utf8');
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(handoffAad(authDir, flowId));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const stored = JSON.stringify({
      version: FORMAT_VERSION,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: encrypted.toString('base64'),
    });

    // A successful helper result is published only after this durable 0600
    // handoff has reached both the file and containing-directory metadata.
    await durableAtomicWriteFile(tokenPath, stored);
    if (await isOAuthHelperFlowCancelled(authDir, flowId)) {
      await deleteHandoffToken(authDir, flowId);
      throw new Error('OAuth helper flow was cancelled');
    }
  } finally {
    plaintext?.fill(0);
    key?.fill(0);
    masterKey?.fill(0);
  }
}

/**
 * Read and decrypt the flow-bound handoff token. Returns null when the handoff
 * file is absent. Throws on a present-but-undecryptable file (tamper / wrong key).
 */
export async function readHandoffToken(authDir: string, flowId: string): Promise<string | null> {
  const tokenPath = handoffTokenPath(authDir, flowId);
  let serializedRecord: string;
  try {
    serializedRecord = await fs.readFile(tokenPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const record = parseHandoffRecord(serializedRecord);
  const salt = Buffer.from(record.salt, 'base64');
  const iv = Buffer.from(record.iv, 'base64');
  const tag = Buffer.from(record.tag, 'base64');
  const encrypted = Buffer.from(record.ciphertext, 'base64');
  let masterKey: Buffer | null = null;
  let key: Buffer | null = null;
  let plaintext: Buffer | null = null;
  try {
    masterKey = await loadMasterKey(authDir);
    key = deriveKey(masterKey, salt, flowId);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(handoffAad(authDir, flowId));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    let payload: { token?: unknown; createdAt?: unknown; expiresAt?: unknown };
    try {
      payload = JSON.parse(plaintext.toString('utf8')) as typeof payload;
    } catch {
      await deleteHandoffToken(authDir, flowId);
      throw new Error('OAuth handoff token is expired or malformed');
    }
    if (typeof payload.token !== 'string' || payload.token.length === 0 ||
        typeof payload.createdAt !== 'number' || !Number.isFinite(payload.createdAt) ||
        typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt) ||
        payload.expiresAt <= Date.now() || payload.expiresAt < payload.createdAt ||
        payload.expiresAt - payload.createdAt > MAX_OAUTH_HELPER_HANDOFF_LIFETIME_MS) {
      await deleteHandoffToken(authDir, flowId);
      throw new Error('OAuth handoff token is expired or malformed');
    }
    return payload.token;
  } finally {
    plaintext?.fill(0);
    key?.fill(0);
    masterKey?.fill(0);
  }
}

/** Delete the flow-bound handoff file if present. Never throws on absence. */
export async function deleteHandoffToken(authDir: string, flowId: string): Promise<void> {
  try {
    await fs.unlink(handoffTokenPath(authDir, flowId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw error;
  }
}

/**
 * Remove expired encrypted handoffs and the legacy plaintext pending_token.txt.
 * A still-live encrypted handoff is retained so a transient canonical-store
 * failure can retry without sending the user through GitHub again.
 */
export async function sweepHandoffArtifacts(authDir: string): Promise<void> {
  await fs.unlink(path.join(authDir, LEGACY_PLAINTEXT_TOKEN_FILE)).catch(() => {});
  let entries: string[];
  try {
    entries = await fs.readdir(authDir);
  } catch {
    return;
  }
  const masterKeyTemps = entries.filter(name => HANDOFF_KEY_TEMP_RE.test(name));
  await Promise.all(masterKeyTemps.map(name => fs.unlink(path.join(authDir, name)).catch(() => {})));
  const cutoff = Date.now() - MAX_OAUTH_HELPER_HANDOFF_LIFETIME_MS;
  await Promise.all(entries
    .filter(name => isHandoffArtifact(name))
    .map(async name => {
      const target = path.join(authDir, name);
      const stat = await fs.stat(target).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await fs.unlink(target).catch(() => {});
    }));
  await Promise.all(entries
    .filter(name => isCancellationArtifact(name))
    .map(async name => {
      const target = path.join(authDir, name);
      const fence = await readCancellationFenceFile(target);
      if (!fence || fence.expiresAt <= Date.now()) await fs.unlink(target).catch(() => {});
    }));
  if (masterKeyTemps.length > 0) await syncFilesystemDirectory(authDir);
}

export async function acquireOAuthHelperFlowLock(
  authDir: string,
  flowId: string,
  expiresAt: number,
  hooks?: OAuthHelperFlowLockAcquireHooks,
): Promise<OAuthHelperFlowLock | null> {
  assertFlowId(flowId);
  await secureAuthDir(authDir);
  const lockPath = path.join(authDir, FLOW_LOCK_FILE);
  const guardPath = `${lockPath}.guard`;
  const lock: OAuthHelperFlowLock = {
    flowId,
    lockId: crypto.randomUUID(),
    expiresAt,
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await withFilesystemInterprocessGuard(guardPath, async () => {
      try {
        await publishFlowLock(lockPath, lock, hooks);
        return lock;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const current = await readFlowLock(lockPath);
      if (current && current.expiresAt > Date.now()) return null;
      const claimedPath = `${lockPath}.${crypto.randomUUID()}.claim`;
      try {
        await fs.rename(lockPath, claimedPath);
      } catch (claimError) {
        if ((claimError as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw claimError;
      }
      const claimed = await readFlowLock(claimedPath);
      if (claimed && claimed.expiresAt > Date.now()) {
        await restoreClaimedFlowLock(claimedPath, lockPath);
        return null;
      }
      await fs.unlink(claimedPath).catch(() => {});
      await syncFilesystemDirectory(authDir);
      await publishFlowLock(lockPath, lock, hooks);
      return lock;
    });
    if (result !== undefined) return result;
  }
  return null;
}

/** Read the currently published helper-flow lease, if it is well formed. */
export async function readOAuthHelperFlowLock(
  authDir: string,
): Promise<OAuthHelperFlowLock | null> {
  return readFlowLock(path.join(authDir, FLOW_LOCK_FILE));
}

async function publishFlowLock(
  lockPath: string,
  lock: OAuthHelperFlowLock,
  hooks?: OAuthHelperFlowLockAcquireHooks,
): Promise<void> {
  const tmpPath = `${lockPath}.${lock.lockId}.tmp`;
  try {
    const handle = await fs.open(tmpPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(lock));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await hooks?.beforePublish?.();
    // A hard link publishes the already-complete inode and fails atomically if
    // another process has installed a lock first.
    await fs.link(tmpPath, lockPath);
    await syncFilesystemDirectory(path.dirname(lockPath));
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

export async function releaseOAuthHelperFlowLock(
  authDir: string,
  flowId: string,
  lockId: string,
): Promise<void> {
  assertFlowId(flowId);
  assertFlowId(lockId);
  const lockPath = path.join(authDir, FLOW_LOCK_FILE);
  await withFilesystemInterprocessGuard(`${lockPath}.guard`, async () => {
    const current = await readFlowLock(lockPath);
    if (!sameFlowLock(current, flowId, lockId)) return;

    const claimedPath = `${lockPath}.${crypto.randomUUID()}.release`;
    try {
      await fs.rename(lockPath, claimedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    const claimed = await readFlowLock(claimedPath);
    if (sameFlowLock(claimed, flowId, lockId)) {
      await fs.unlink(claimedPath).catch(() => {});
      await syncFilesystemDirectory(authDir);
      return;
    }
    await restoreClaimedFlowLock(claimedPath, lockPath);
  });
}

function handoffAad(authDir: string, flowId: string): Buffer {
  return Buffer.from(JSON.stringify({
    version: FORMAT_VERSION,
    flowId,
    authDir: path.resolve(authDir),
  }), 'utf8');
}

function parseHandoffRecord(value: string): {
  version: number; salt: string; iv: string; tag: string; ciphertext: string;
} {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (parsed.version !== FORMAT_VERSION ||
      typeof parsed.salt !== 'string' || typeof parsed.iv !== 'string' ||
      typeof parsed.tag !== 'string' || typeof parsed.ciphertext !== 'string') {
    throw new Error('Unsupported or malformed OAuth handoff record');
  }
  const salt = decodeCanonicalBase64(parsed.salt);
  const iv = decodeCanonicalBase64(parsed.iv);
  const tag = decodeCanonicalBase64(parsed.tag);
  const ciphertext = decodeCanonicalBase64(parsed.ciphertext);
  if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH || tag.length !== 16 ||
      ciphertext.length === 0) {
    throw new Error('Unsupported or malformed OAuth handoff record');
  }
  return parsed as { version: number; salt: string; iv: string; tag: string; ciphertext: string };
}

function decodeCanonicalBase64(value: string): Buffer {
  if (value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Unsupported or malformed OAuth handoff record');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('Unsupported or malformed OAuth handoff record');
  }
  return decoded;
}

async function readFlowLock(lockPath: string): Promise<OAuthHelperFlowLock | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Record<string, unknown>;
    return typeof parsed.flowId === 'string' && FLOW_ID_RE.test(parsed.flowId) &&
      typeof parsed.lockId === 'string' && FLOW_ID_RE.test(parsed.lockId) &&
      typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)
      ? { flowId: parsed.flowId, lockId: parsed.lockId, expiresAt: parsed.expiresAt }
      : null;
  } catch {
    return null;
  }
}

function sameFlowLock(
  lock: OAuthHelperFlowLock | null,
  flowId: string,
  lockId: string,
): boolean {
  return lock?.flowId === flowId && lock.lockId === lockId;
}

async function restoreClaimedFlowLock(claimedPath: string, lockPath: string): Promise<void> {
  let restoredOrSuperseded = false;
  try {
    await fs.link(claimedPath, lockPath);
    restoredOrSuperseded = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    restoredOrSuperseded = true;
  } finally {
    if (restoredOrSuperseded) await fs.unlink(claimedPath).catch(() => {});
  }
  if (restoredOrSuperseded) await syncFilesystemDirectory(path.dirname(lockPath));
}

function isHandoffArtifact(name: string): boolean {
  if (!name.startsWith(HANDOFF_PREFIX)) return false;
  if (name.endsWith(HANDOFF_SUFFIX)) return FLOW_ID_RE.test(
    name.slice(HANDOFF_PREFIX.length, -HANDOFF_SUFFIX.length),
  );
  const tempMarker = `${HANDOFF_SUFFIX}.`;
  const markerIndex = name.indexOf(tempMarker, HANDOFF_PREFIX.length);
  if (markerIndex < 0 || !name.endsWith(HANDOFF_TEMP_SUFFIX)) return false;
  const flowId = name.slice(HANDOFF_PREFIX.length, markerIndex);
  const tempId = name.slice(markerIndex + tempMarker.length, -HANDOFF_TEMP_SUFFIX.length);
  return FLOW_ID_RE.test(flowId) && (FLOW_ID_RE.test(tempId) || /^\d+$/.test(tempId));
}

function isCancellationArtifact(name: string): boolean {
  if (!name.startsWith(CANCELLATION_PREFIX) || !name.endsWith(CANCELLATION_SUFFIX)) return false;
  return FLOW_ID_RE.test(name.slice(CANCELLATION_PREFIX.length, -CANCELLATION_SUFFIX.length));
}

async function readOAuthHelperCancellationFence(
  authDir: string,
  flowId: string,
): Promise<OAuthHelperCancellationFence | null> {
  const fencePath = cancellationFencePath(authDir, flowId);
  const fence = await readCancellationFenceFile(fencePath);
  if (!fence) return null;
  if (fence.flowId !== flowId || fence.expiresAt <= Date.now()) {
    await fs.unlink(fencePath).catch(() => {});
    return null;
  }
  return fence;
}

async function readCancellationFenceFile(filePath: string): Promise<OAuthHelperCancellationFence | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
    if (typeof parsed.flowId !== 'string' || !FLOW_ID_RE.test(parsed.flowId)
        || typeof parsed.generation !== 'string' || !FLOW_ID_RE.test(parsed.generation)
        || typeof parsed.cancelledAt !== 'number' || !Number.isFinite(parsed.cancelledAt)
        || typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)
        || parsed.expiresAt <= parsed.cancelledAt
        || parsed.expiresAt - parsed.cancelledAt > MAX_OAUTH_HELPER_HANDOFF_LIFETIME_MS) return null;
    return {
      flowId: parsed.flowId,
      generation: parsed.generation,
      cancelledAt: parsed.cancelledAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}
