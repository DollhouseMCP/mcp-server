#!/usr/bin/env node
/**
 * dollhouse-create-user
 *
 * Operator CLI for issuing local-account invite tokens (must-fix #17).
 * The operator runs this on the host where the AS lives; the printed URL
 * is hand-delivered (Slack DM, encrypted message, in-person) to the user,
 * who clicks it and sets their own argon2id password on first visit.
 *
 * The operator never sees a password.
 *
 * Usage:
 *   dollhouse-create-user --username alice --email alice@example.com [--base-url URL] [--ttl-min 15]
 *
 * Configuration:
 *   - Reads the same DOLLHOUSE_INVITE_TOKEN_SECRET / persisted secret file
 *     the running AS uses, so issued tokens verify against the runtime.
 *   - Reads DOLLHOUSE_PUBLIC_BASE_URL or DOLLHOUSE_HTTP_HOST/PORT for the
 *     URL the user clicks. Override with --base-url for tunneled deployments.
 *
 * Exit codes:
 *   0 — success, URL printed to stdout
 *   1 — usage error (missing args, invalid email)
 *   2 — secret/storage error (cannot read invite secret)
 *
 * @since §8.1 (Stage C)
 */

import { Command } from 'commander';
import { env } from '../config/env.js';
import {
  InviteTokenStore,
  loadOrGenerateInviteSecret,
} from '../auth/embedded-as/inviteTokens.js';
import { openCliAuthStorage } from './cliAuthStorage.js';
import { recordBootstrapCompleted } from '../auth/embedded-as/bootstrapAdmin.js';

interface CreateUserOptions {
  username: string;
  email: string;
  baseUrl?: string;
  ttlMin?: string;
}

function resolveBaseUrl(override?: string): string {
  if (override) return override;
  if (env.DOLLHOUSE_PUBLIC_BASE_URL) return env.DOLLHOUSE_PUBLIC_BASE_URL;
  return `http://${env.DOLLHOUSE_HTTP_HOST}:${env.DOLLHOUSE_HTTP_PORT}`;
}

function buildInviteUrl(baseUrl: string, token: string): string {
  // Land on the AS's interaction page; LocalAccountMethod's render-html
  // shows the password-set form prefilled with the invite token.
  const url = new URL('/auth/local/invite', baseUrl);
  url.searchParams.set('invite', token);
  return url.toString();
}

function isValidEmail(value: string): boolean {
  // Relaxed shape check — full RFC 5322 validation is the user's email
  // server's job. We just want to catch obvious typos.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidUsername(value: string): boolean {
  // Same constraint as the userId regex elsewhere in the project.
  return /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(value);
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('dollhouse-create-user')
    .description(
      'Issue a one-time invite URL for a new local account.\n\n' +
      'IMPORTANT — implicit admin bootstrap:\n' +
      '  When the embedded AS is in multi-user mode and bootstrap has not yet\n' +
      '  been completed, the FIRST invocation of this command auto-claims the\n' +
      '  invited user as the admin (must-fix #22 / spec L923). This is by\n' +
      '  design — the operator running the CLI from the AS host is by\n' +
      '  definition trusted, so the first invite IS the admin invite. Once\n' +
      '  bootstrap is complete, subsequent invites issue normal user accounts.\n\n' +
      'Example — admin first invite:\n' +
      '  dollhouse-create-user --username admin --email admin@example.com\n\n' +
      'Example — regular user invite (after admin bootstrap):\n' +
      '  dollhouse-create-user --username alice --email alice@example.com',
    )
    .requiredOption('--username <username>', 'username (alphanumeric + _ -, max 64)')
    .requiredOption('--email <email>', 'user email address')
    .option('--base-url <url>', 'public base URL of the running AS (default: env)')
    .option('--ttl-min <minutes>', 'token TTL in minutes (1-60, default 15)', '15')
    .parse(process.argv);

  const opts = program.opts<CreateUserOptions>();

  if (!isValidUsername(opts.username)) {
    process.stderr.write(
      `Invalid username '${opts.username}'. ` +
      `Must match /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.\n`,
    );
    process.exit(1);
  }

  if (!isValidEmail(opts.email)) {
    process.stderr.write(`Invalid email '${opts.email}'.\n`);
    process.exit(1);
  }

  const ttlMin = Number.parseInt(String(opts.ttlMin ?? '15'), 10);
  if (!Number.isFinite(ttlMin) || ttlMin < 1 || ttlMin > 60) {
    process.stderr.write('--ttl-min must be an integer between 1 and 60.\n');
    process.exit(1);
  }

  let secret: Buffer;
  try {
    secret = loadOrGenerateInviteSecret();
  } catch (err) {
    process.stderr.write(
      `Failed to load invite-token secret: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }

  // Connect to the same storage the AS uses so the bootstrap-state
  // pre-claim (must-fix #22) is durable. The CLI is talking to the same
  // backend the running AS reads from at startup; on next request, the
  // gate sees state.completed === true.
  //
  // Round 5 post-triage HIGH-1: openCliAuthStorage handles all three
  // backends including postgres. The previous direct createAuthStorage
  // call could not — postgres requires an injected DatabaseInstance.
  let handle;
  try {
    handle = await openCliAuthStorage({ methods: ['local-password'] });
  } catch (err) {
    process.stderr.write(
      `Failed to initialize auth storage: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }

  try {
    const sub = `local_${opts.username}`;

    // Bootstrap pre-claim (must-fix #22 / spec L923): if the AS hasn't
    // been bootstrapped yet, this first invite IS the admin invite.
    // Mark the bootstrap state with this sub BEFORE issuing the token
    // so a crash between the two doesn't leave the operator with an
    // unbootstrap-able invite they can't replace.
    const bootstrap = await handle.storage.getBootstrapState();
    if (!bootstrap.completed) {
      await handle.storage.markBootstrapComplete(sub, 'local-password');
      // Cycle 19 / test-M1 + cycle 22: emit via the shared
      // `recordBootstrapCompleted` helper so both CLI entry points
      // (this one and dollhouse-admin-bootstrap) share a single
      // tested code path. Sibling-fix sweep across the two CLIs.
      try {
        await recordBootstrapCompleted(
          handle.storage,
          sub,
          'local-password',
          'implicit-create-user',
        );
      } catch (err) {
        // Don't fail the create-user flow on audit emission failure —
        // the bootstrap state is already persisted.
        process.stderr.write(
          `[create-user] warning: failed to emit auth.bootstrap.completed audit event: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      process.stderr.write(
        `[create-user] Bootstrap pre-claim recorded — '${opts.username}' will be granted admin role on first sign-in.\n`,
      );
    }

    const store = new InviteTokenStore(secret, handle.storage);
    const token = store.issue({
      sub,
      email: opts.email,
      purpose: 'invite',
      ttlMs: ttlMin * 60 * 1000,
    });

    const baseUrl = resolveBaseUrl(opts.baseUrl);
    const url = buildInviteUrl(baseUrl, token);

    process.stdout.write(`${url}\n`);
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  process.stderr.write(`create-user failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
