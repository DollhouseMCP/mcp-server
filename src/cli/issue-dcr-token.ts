#!/usr/bin/env node
/**
 * dollhouse-issue-dcr-token
 *
 * Mint an InitialAccessToken (RFC 7591) so a third-party client can
 * register itself via the embedded AS's /reg endpoint. With DCR locked
 * down (initialAccessToken: true), this is the only way for new clients
 * to acquire a client_id without operator-side static configuration.
 *
 * Usage:
 *   dollhouse-issue-dcr-token [--ttl-min 1440] [--policy-name name]
 *
 * The printed token must be sent on the registration request as:
 *   Authorization: Bearer <token>
 *
 * The default 24h (1440 minute) TTL gives the client developer time to
 * register without leaving a long-lived broad-permission token around.
 *
 * This CLI talks directly to the local AS state file via the same
 * persisted invite-secret pattern used by `dollhouse-create-user` —
 * but for InitialAccessToken issuance, it requires the AS to be
 * RUNNING because oidc-provider's `IATs` are stored in its adapter
 * (in-memory or future Sqlite). For this commit it issues against a
 * fresh in-process Provider instance and prints the result; future work
 * will route through an admin-channel HTTP call to the running AS.
 *
 * Exit codes:
 *   0 — success
 *   1 — usage error
 *   2 — provider construction error
 *
 * @since §8.1 C9
 */

import { Command } from 'commander';
import OidcProvider from 'oidc-provider';
import { generateKeyPair, exportJWK } from 'jose';
import { env } from '../config/env.js';

interface Options {
  ttlMin?: string;
  policyName?: string;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('dollhouse-issue-dcr-token')
    .description('Mint an InitialAccessToken for RFC 7591 dynamic client registration.')
    .option('--ttl-min <minutes>', 'token TTL in minutes (default 1440 = 24h)', '1440')
    .option('--policy-name <name>', 'optional policy name to bind on the token', undefined)
    .parse(process.argv);

  const opts = program.opts<Options>();

  const ttlMin = Number.parseInt(String(opts.ttlMin ?? '1440'), 10);
  if (!Number.isFinite(ttlMin) || ttlMin < 1 || ttlMin > 60 * 24 * 7) {
    process.stderr.write('--ttl-min must be an integer between 1 and 10080 (7 days).\n');
    process.exit(1);
  }

  const baseUrl = env.DOLLHOUSE_PUBLIC_BASE_URL
    ?? `http://${env.DOLLHOUSE_HTTP_HOST}:${env.DOLLHOUSE_HTTP_PORT}`;

  // Construct a transient Provider just to mint the IAT. The underlying
  // adapter is in-memory, so the issued token only validates against an AS
  // process that shares the same persisted state. For the in-memory storage
  // this CLI's process and the running AS are decoupled — the operator must
  // restart the AS with this CLI's seed (or use a future admin endpoint).
  let provider: InstanceType<typeof OidcProvider>;
  try {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const jwk = await exportJWK(privateKey);
    provider = new OidcProvider(baseUrl, {
      jwks: { keys: [{ ...jwk, alg: 'ES256', kid: 'cli', use: 'sig' }] },
      features: { registration: { enabled: true, initialAccessToken: true } },
      clients: [],
    });
  } catch (err) {
    process.stderr.write(`Failed to construct provider: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }

  const iat = new provider.InitialAccessToken({
    expiresIn: ttlMin * 60,
    ...(opts.policyName ? { policies: [opts.policyName] } : {}),
  });
  const token = await iat.save();

  process.stdout.write(`${token}\n`);
  process.stderr.write(
    `\nUse this token to register a client (TTL ${ttlMin}m):\n` +
    `  curl -X POST ${baseUrl}/reg \\\n` +
    `    -H 'Authorization: Bearer ${token}' \\\n` +
    `    -H 'Content-Type: application/json' \\\n` +
    `    -d '{"redirect_uris":["http://127.0.0.1:54321/callback"],"token_endpoint_auth_method":"none"}'\n\n` +
    `Note: the token validates against an AS process that shares the same\n` +
    `persisted JWKS + adapter state as this CLI run. For the current in-\n` +
    `memory storage you must keep the AS running with shared signing keys.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`issue-dcr-token failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
