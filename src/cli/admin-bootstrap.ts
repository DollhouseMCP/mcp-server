#!/usr/bin/env node
/**
 * dollhouse-admin-bootstrap
 *
 * Pre-claims the admin identity for multi-user AS deployments that use
 * magic-link or GitHub for sign-in (must-fix #22 / spec L923). For
 * local-account deployments, the `dollhouse-create-user` CLI does
 * this implicitly — the first invite issued IS the admin's.
 *
 * Why pre-claim? Without it, an attacker who reaches the AS first
 * after the gate opens could authenticate via GitHub/magic-link
 * before the legitimate operator and become the admin. Recording the
 * admin's identity at CLI time eliminates the race entirely — the
 * sub stored here is the ONLY one that gets `roles: ['admin']` when
 * it authenticates. Other identities authenticate as regular users.
 *
 * Usage:
 *   dollhouse-admin-bootstrap --method github --github-username todd
 *   dollhouse-admin-bootstrap --method github --github-id 12345
 *   dollhouse-admin-bootstrap --method magic-link --email todd@example.com
 *
 * Exit codes:
 *   0 — bootstrap recorded
 *   1 — usage error / invalid arguments
 *   2 — storage error / GitHub API error
 *   3 — bootstrap already complete with a different admin (transfer rejected)
 *
 * @since §8.1 Phase R2 (must-fix #22)
 */

import { Command } from 'commander';
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { openCliAuthStorage, type CliAuthStorageHandle } from './cliAuthStorage.js';
import { recordBootstrapCompleted, type BootstrapAdminMethod } from '../auth/embedded-as/bootstrapAdmin.js';

interface BootstrapOptions {
  method: string;
  githubUsername?: string;
  githubId?: string;
  email?: string;
}

interface GithubUser {
  id: number;
  login: string;
}

interface BootstrapIdentity {
  adminSub: string;
  adminMethod: 'magic-link' | 'github';
}

/**
 * Resolve a GitHub username to its numeric ID via the public API. We
 * record the numeric ID rather than the username because GitHub allows
 * username changes — the ID is the stable identity that
 * GithubSocialMethod stores as `externalSub`.
 */
async function resolveGithubUserId(username: string): Promise<number> {
  const url = `https://api.github.com/users/${encodeURIComponent(username)}`;
  // Round 5 / M6: bound the network call so a flaky link doesn't hang
  // the operator's CLI indefinitely. Honour GITHUB_TOKEN if present —
  // bumps the unauthenticated 60/hr rate limit to 5000/hr and avoids
  // the noisy 403 path during bursty bootstrap workflows.
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  // Cycle 24 / cycle-23 security MEDIUM-2: route through env.X
  // (Zod-validated) instead of raw process.env. Same sibling-fix-miss
  // class as cycle 21's env-routing sweep.
  const githubToken = env.GITHUB_TOKEN;
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }
  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 404) {
    throw new Error(`GitHub user '${username}' not found.`);
  }
  if (resp.status === 403 || resp.status === 429) {
    throw new Error(
      `GitHub API rate-limited (${resp.status}). If you have the numeric GitHub user ID, ` +
      `pass --github-id <id> to skip this lookup. Or set GITHUB_TOKEN for a higher rate limit.`,
    );
  }
  if (!resp.ok) {
    throw new Error(
      `GitHub API returned ${resp.status} ${resp.statusText} when looking up user '${username}'.`,
    );
  }
  const user = await resp.json() as GithubUser;
  if (typeof user.id !== 'number') {
    throw new Error(`GitHub API response missing numeric 'id' for user '${username}'.`);
  }
  return user.id;
}

/**
 * Email → magic-link sub. Mirrors the SHA-256 hashEmail used by
 * MagicLinkMethod (must-fix #18 / B5) so the pre-claim sub matches the
 * sub that consumeMagicLink generates when the admin signs in.
 */
function magicLinkSubFromEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const hash = createHash('sha256').update(normalized).digest('base64url');
  return `magic-link_${hash}`;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/.test(value); // NOSONAR — anchored email regex; quantifiers separated by literal anchors (@ and .); CLI input bounded by operator-typed length
}

function parseAndValidateOptions(): BootstrapOptions {
  const program = new Command();
  program
    .name('dollhouse-admin-bootstrap')
    .description('Pre-claim the admin identity for a multi-user AS deployment.')
    .requiredOption(
      '--method <method>',
      "auth method that owns the admin identity: 'github' or 'magic-link' " +
      "(local-password is bootstrapped implicitly via 'dollhouse-create-user')",
    )
    .option('--github-username <username>', 'GitHub username (resolved to numeric ID)')
    .option('--github-id <id>', 'GitHub numeric user ID (skip lookup)')
    .option('--email <email>', 'admin email address (for magic-link method)')
    .parse(process.argv);

  return program.opts<BootstrapOptions>();
}

async function resolveBootstrapIdentity(opts: BootstrapOptions): Promise<BootstrapIdentity> {
  if (opts.method === 'github') return bootstrapGithubAdmin(opts);
  if (opts.method === 'magic-link') return bootstrapMagicLinkAdmin(opts);
  if (opts.method === 'local-password' || opts.method === 'local-account') {
    process.stderr.write(
      "Local-account deployments bootstrap implicitly via 'dollhouse-create-user'. " +
      "Run that command instead — the first invite issued is automatically the admin invite.\n",
    );
    process.exit(1);
  } else {
    process.stderr.write(
      `Unknown --method '${opts.method}'. Valid: github, magic-link.\n`,
    );
    process.exit(1);
  }
}

async function bootstrapGithubAdmin(opts: BootstrapOptions): Promise<BootstrapIdentity> {
  const id = await resolveBootstrapGithubId(opts);
  return { adminSub: `github_${id}`, adminMethod: 'github' };
}

async function resolveBootstrapGithubId(opts: BootstrapOptions): Promise<number> {
  if (opts.githubId) return parseGithubId(opts.githubId);
  if (opts.githubUsername) return resolveBootstrapGithubUsername(opts.githubUsername);

  process.stderr.write('--method github requires either --github-username or --github-id.\n');
  process.exit(1);
}

function parseGithubId(githubId: string): number {
  const parsed = Number.parseInt(githubId, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    process.stderr.write(`Invalid --github-id '${githubId}': must be a positive integer.\n`);
    process.exit(1);
  }
  return parsed;
}

async function resolveBootstrapGithubUsername(githubUsername: string): Promise<number> {
  try {
    const id = await resolveGithubUserId(githubUsername);
    process.stderr.write(`[admin bootstrap] Resolved GitHub user '${githubUsername}' to id=${id}.\n`);
    return id;
  } catch (err) {
    process.stderr.write(
      `Failed to resolve GitHub username: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}

function bootstrapMagicLinkAdmin(opts: BootstrapOptions): BootstrapIdentity {
  if (!opts.email || !isValidEmail(opts.email)) {
    process.stderr.write(`--method magic-link requires a valid --email '<addr>'.\n`);
    process.exit(1);
  }
  return { adminSub: magicLinkSubFromEmail(opts.email), adminMethod: 'magic-link' };
}

async function openStorageOrExit(adminMethod: BootstrapIdentity['adminMethod']): Promise<CliAuthStorageHandle> {
  // Round 5 post-triage HIGH-1: openCliAuthStorage handles all three backends
  // including postgres (which the previous direct createAuthStorage call could
  // not — it requires an injected DatabaseInstance from the DI container).
  try {
    return await openCliAuthStorage({ methods: [adminMethod] });
  } catch (err) {
    process.stderr.write(`Failed to initialize auth storage: ${describeBootstrapError(err)}\n`);
    return process.exit(2);
  }
}

async function markBootstrapOrExit(
  handle: CliAuthStorageHandle,
  adminSub: string,
  adminMethod: BootstrapIdentity['adminMethod'],
): Promise<void> {
  try {
    await handle.storage.markBootstrapComplete(adminSub, adminMethod);
  } catch (err) {
    const msg = describeBootstrapError(err);
    await handle.close();
    if (msg.includes('admin transfer is a separate operation')) {
      process.stderr.write(`${msg}\n`);
      process.exit(3);
    }
    process.stderr.write(`Failed to mark bootstrap complete: ${msg}\n`);
    process.exit(2);
  }
}

async function emitBootstrapAudit(
  handle: CliAuthStorageHandle,
  adminSub: string,
  adminMethod: BootstrapIdentity['adminMethod'],
): Promise<void> {
  // Cycle 19 / test-M1 + cycle 22: route through the shared
  // `recordBootstrapCompleted` helper so the assertion lives at the helper level
  // and the CLI invocation can be tested by spying on the helper. An audit
  // emission failure must NOT fail the bootstrap — the state is already persisted.
  try {
    await recordBootstrapCompleted(handle.storage, adminSub, adminMethod as BootstrapAdminMethod, 'admin-bootstrap-cli');
  } catch (err) {
    process.stderr.write(
      `[admin bootstrap] warning: failed to emit auth.bootstrap.completed audit event: ${describeBootstrapError(err)}\n`,
    );
  }
}

async function provisionConsoleAdminRole(handle: CliAuthStorageHandle, adminSub: string): Promise<void> {
  // DB mode only: the operator designates the admin at setup, so the role is
  // granted up front (the credential is still set by the user/IdP on first
  // login, at which point the account auto-links to this user row by sub).
  // Non-DB backends have no console role store — admin there is the stdio operator.
  if (!handle.db) return;
  try {
    const { provisionConsoleAdmin } = await import('../web-console/identity/provisionConsoleAdmin.js');
    const result = await provisionConsoleAdmin(handle.db, adminSub);
    process.stdout.write(`Console admin provisioned in user_admin_roles (user ${result.userId}).\n`);
  } catch (err) {
    process.stderr.write(`[admin bootstrap] warning: failed to provision console admin role: ${describeBootstrapError(err)}\n`);
  }
}

function describeBootstrapError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  const opts = parseAndValidateOptions();
  const { adminSub, adminMethod } = await resolveBootstrapIdentity(opts);

  const handle = await openStorageOrExit(adminMethod);
  await markBootstrapOrExit(handle, adminSub, adminMethod);
  await emitBootstrapAudit(handle, adminSub, adminMethod);
  await provisionConsoleAdminRole(handle, adminSub);

  process.stdout.write(
    `Bootstrap recorded. Admin sub: ${adminSub} (method: ${adminMethod}).\n` +
    (handle.db
      ? `Admin role is set now; ${adminSub} has admin the moment they log in (login only establishes their credential).\n`
      : `When this user authenticates, they will be granted admin role.\n`),
  );
  await handle.close();
}

main().catch((err) => { // NOSONAR — top-level await breaks the Jest CJS transform; .catch() is required here
  process.stderr.write(
    `admin bootstrap failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(2);
});
