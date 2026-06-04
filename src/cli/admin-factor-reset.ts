#!/usr/bin/env node
/**
 * dollhouse-admin-factor-reset — break-glass admin MFA reset.
 *
 * Disables a user's active admin TOTP factor directly against the database,
 * WITHOUT requiring console admin elevation. This is the recovery path for the
 * lockout case where the only admin's authenticator can no longer be verified
 * (e.g. the web-console secret encryption key was rotated without retaining the
 * old key, so `prove` fails with "Secret ciphertext authentication failed") —
 * the in-console reset route itself requires elevation, which a locked-out sole
 * admin cannot obtain. After this runs, the user re-enrolls a fresh factor.
 *
 * Identify the user by exactly one of:
 *   --user-id <uuid>            the users.id
 *   --username <name>           the users.username
 *   --sub <provider_subject>    an auth_accounts.sub linked to the user
 *
 * Usage:
 *   dollhouse-admin-factor-reset --username todd
 *   dollhouse-admin-factor-reset --sub github_12345
 *
 * Requires DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres + DOLLHOUSE_DATABASE_URL
 * (admin TOTP only exists in DB mode).
 *
 * Exit codes: 0 reset (or nothing to reset) · 1 usage error · 2 storage/db error · 4 user not found.
 */

import { Command } from 'commander';
import { and, eq, isNull } from 'drizzle-orm';

import { withSystemContext } from '../database/admin.js';
import { authAccounts, users } from '../database/schema/index.js';
import { PostgresConsoleFactorStore } from '../web-console/stores/PostgresConsoleFactorStore.js';
import { openCliAuthStorage } from './cliAuthStorage.js';

interface FactorResetOptions {
  userId?: string;
  username?: string;
  sub?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseOptions(): FactorResetOptions {
  const program = new Command();
  program
    .name('dollhouse-admin-factor-reset')
    .description('Break-glass: disable a user\'s admin TOTP factor without console elevation.')
    .option('--user-id <uuid>', 'the users.id to reset')
    .option('--username <name>', 'the users.username to reset')
    .option('--sub <subject>', 'an auth_accounts.sub linked to the user')
    .parse(process.argv);
  return program.opts<FactorResetOptions>();
}

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function resolveUserId(
  db: NonNullable<Awaited<ReturnType<typeof openCliAuthStorage>>['db']>,
  opts: FactorResetOptions,
): Promise<string> {
  const provided = [opts.userId, opts.username, opts.sub].filter(value => value !== undefined);
  if (provided.length !== 1) {
    fail('Provide exactly one of --user-id, --username, or --sub.', 1);
  }
  if (opts.userId) {
    if (!UUID_PATTERN.test(opts.userId)) fail(`Invalid --user-id '${opts.userId}': must be a UUID.`, 1);
    return opts.userId;
  }
  const username = opts.username;
  const sub = opts.sub;
  return withSystemContext(db, async tx => {
    if (username) {
      const rows = await tx.select({ id: users.id }).from(users)
        .where(and(eq(users.username, username), isNull(users.deletedAt))).limit(1);
      if (rows.length === 0) fail(`No active user with username '${username}'.`, 4);
      return rows[0].id;
    }
    if (sub) {
      const rows = await tx.select({ userId: authAccounts.userId }).from(authAccounts)
        .where(eq(authAccounts.sub, sub)).limit(1);
      if (rows.length === 0 || !rows[0].userId) fail(`No user linked to sub '${sub}'.`, 4);
      return rows[0].userId;
    }
    return fail('Provide exactly one of --user-id, --username, or --sub.', 1);
  });
}

async function main(): Promise<void> {
  const opts = parseOptions();

  let handle;
  try {
    handle = await openCliAuthStorage({ methods: ['local-password'] });
  } catch (err) {
    fail(`Failed to initialize auth storage: ${err instanceof Error ? err.message : String(err)}`, 2);
  }
  if (!handle.db) {
    await handle.close();
    fail('Admin TOTP exists only in DB mode. Set DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres + DOLLHOUSE_DATABASE_URL.', 2);
  }

  try {
    const userId = await resolveUserId(handle.db, opts);
    const factorStore = new PostgresConsoleFactorStore(handle.db);
    const disabled = await factorStore.disableActiveTotp(userId);
    process.stdout.write(
      disabled
        ? `Admin TOTP factor disabled for user ${userId}. The user must re-enroll an authenticator ` +
          `before they can elevate. Existing admin elevations are NOT cleared by this tool — ` +
          `restart the server or revoke their sessions if the account may be compromised.\n`
        : `No active admin TOTP factor for user ${userId}; nothing to reset.\n`,
    );
  } catch (err) {
    await handle.close();
    fail(`Factor reset failed: ${err instanceof Error ? err.message : String(err)}`, 2);
  }
  await handle.close();
}

main().catch((err) => { // NOSONAR — top-level await breaks the Jest CJS transform; .catch() is required here
  process.stderr.write(`admin factor reset failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
