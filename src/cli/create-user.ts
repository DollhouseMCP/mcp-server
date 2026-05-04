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
    .description('Issue a one-time invite URL for a new local account.')
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

  const store = new InviteTokenStore(secret);
  const sub = `local_${opts.username}`;
  const token = store.issue({
    sub,
    email: opts.email,
    purpose: 'invite',
    ttlMs: ttlMin * 60 * 1000,
  });

  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const url = buildInviteUrl(baseUrl, token);

  process.stdout.write(`${url}\n`);
}

main().catch((err) => {
  process.stderr.write(`create-user failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
