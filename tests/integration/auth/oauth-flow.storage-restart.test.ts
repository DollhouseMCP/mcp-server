/**
 * Storage durability across AS restart (Phase 6.6).
 *
 * Phase 1 introduced FilesystemAuthStorageLayer + PostgresAuthStorageLayer
 * so AS state survives a process restart. This test proves the durability
 * end-to-end against the filesystem backend by:
 *
 *   1. Booting AS-1 with a real filesystem rootDir
 *   2. Driving a LocalAccount flow (invite + set-password) → access_token
 *   3. Tearing down AS-1 (server.close, drop AS instance)
 *   4. Booting AS-2 against the SAME filesystem rootDir + key file
 *   5. Asserting:
 *      - The account row is still in storage (accounts.json persisted)
 *      - The access_token issued by AS-1 validates against AS-2 (proves
 *        the JWKS signing key file persisted — without it, the at+jwt
 *        signature won't verify on AS-2)
 *      - A fresh OAuth flow on AS-2 succeeds with the password set on
 *        AS-1 (proves the argon2 password hash round-tripped through
 *        the filesystem)
 *
 * The Postgres parity for the same APIs is covered by storage-parity tests;
 * the durability story for filesystem (which has the more complex
 * atomic-write + lock semantics) is what this test pins.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalAccountMethod } from '../../../src/auth/embedded-as/methods/LocalAccountMethod.js';
import { LocalLoginRateLimiter } from '../../../src/auth/embedded-as/rateLimit.js';
import { InviteTokenStore, loadOrGenerateInviteSecret } from '../../../src/auth/embedded-as/inviteTokens.js';
import { FilesystemAuthStorageLayer } from '../../../src/auth/embedded-as/storage/FilesystemAuthStorageLayer.js';
import { InMemoryRateLimitStore } from '../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import {
  type ASHarness,
  approveClientConsentPage,
  CookieJar,
  followToCodeRedirect,
  getFreePort,
  startAuthorizeFlow,
  startASHarness,
} from './oauth-flow-helpers.js';

const REDIRECT_URI = 'http://127.0.0.1/callback';
const CLIENT_ID = 'dollhouse-claude-connector';

async function fetchAuthServerMetadata(baseUrl: string) {
  const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  return res.json() as Promise<{
    authorization_endpoint: string;
    token_endpoint: string;
    issuer: string;
  }>;
}

async function postConsentForm(
  interactionUrl: string,
  jar: CookieJar,
  body: Record<string, string>,
): Promise<Response> {
  const consent = await fetch(interactionUrl, {
    method: 'GET', redirect: 'manual',
    headers: { Cookie: jar.header() },
  });
  jar.ingest(consent.headers);
  const html = await consent.text();
  const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(html);
  if (!csrfMatch) throw new Error('CSRF token not found in interaction render');
  return fetch(interactionUrl, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar.header(),
    },
    body: new URLSearchParams({ csrf_token: csrfMatch[1], ...body }),
  });
}

describe('Filesystem storage — AS restart durability', () => {
  let tmpDir: string;
  let storageDir: string;
  let port: number;
  let publicBaseUrl: string;
  let harness: ASHarness | null = null;

  beforeEach(async () => {
    // Stable tmpDir across restart: caller-owned (not auto-cleaned by harness).
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-restart-'));
    storageDir = path.join(tmpDir, 'auth-storage');
    await fs.mkdir(storageDir, { recursive: true, mode: 0o700 });
    // Stable port across restart so the OAuth resource indicator
    // (`<publicBaseUrl>/mcp`) stays consistent — token aud must match
    // across the restart for validation to succeed.
    port = await getFreePort();
    publicBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (harness) await harness.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build a fresh AS instance pointing at the same persisted storage + key.
   * The invite-token HMAC secret is loaded from a file under tmpDir so it
   * survives the restart — without that, an invite issued by AS-1 would
   * be HMAC-invalid on AS-2 (different key) and the restart test wouldn't
   * model production behavior, where loadOrGenerateInviteSecret() reads
   * the persisted secret from disk on every boot.
   */
  async function bootAS(): Promise<{ harness: ASHarness; method: LocalAccountMethod }> {
    const storage = new FilesystemAuthStorageLayer({ rootDir: storageDir });
    const inviteSecretFile = path.join(tmpDir, 'invite-secret.bin');
    const invites = new InviteTokenStore(loadOrGenerateInviteSecret(inviteSecretFile), storage);
    const rateLimiter = new LocalLoginRateLimiter({ storage, store: new InMemoryRateLimitStore(), storeBackend: 'memory' });
    const method = new LocalAccountMethod({ storage, invites, rateLimiter });
    const h = await startASHarness({
      methods: [method],
      storage,
      publicBaseUrl,
      port,
      tmpDir,
    });
    return { harness: h, method };
  }

  it('account + JWKS key + password hash survive an AS restart', async () => {
    // ─── AS-1: drive a LocalAccount flow + capture the access_token. ───
    const boot1 = await bootAS();
    harness = boot1.harness;
    const authServer = await fetchAuthServerMetadata(harness.baseUrl);

    const inviteUrl = boot1.method.issueInvite('local_persisted', 'persist@example.com', REDIRECT_URI);
    const inviteToken = new URL(inviteUrl).searchParams.get('invite')!;

    const flow1 = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${publicBaseUrl}/mcp`,
      scope: 'mcp',
    });

    const consentPost = await postConsentForm(flow1.interactionUrl, flow1.jar, {
      action: 'set-password',
      invite: inviteToken,
      password: 'a-very-long-password',
    });
    expect(consentPost.status).toBe(200);

    const approvePost = await approveClientConsentPage({
      baseUrl: harness.baseUrl,
      response: consentPost,
      jar: flow1.jar,
    });
    expect([302, 303]).toContain(approvePost.status);
    flow1.jar.ingest(approvePost.headers);

    const code = await followToCodeRedirect({
      baseUrl: harness.baseUrl,
      start: approvePost.headers.get('location'),
      jar: flow1.jar,
      redirectUriPrefix: REDIRECT_URI,
    });

    const tokenResp = await fetch(authServer.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code,
        code_verifier: flow1.verifier,
        resource: `${publicBaseUrl}/mcp`,
      }),
    });
    expect(tokenResp.status).toBe(200);
    const tokenBody = await tokenResp.json() as { access_token: string };
    const tokenIssuedByAS1 = tokenBody.access_token;

    // Sanity: the durable storage actually wrote files.
    expect(await fs.stat(path.join(storageDir, 'accounts.json'))).toBeTruthy();
    // Signing key file should exist where the harness puts it (tmpDir/key.json).
    expect(await fs.stat(path.join(tmpDir, 'key.json'))).toBeTruthy();

    // ─── Restart: tear down AS-1, boot AS-2 against the same dir/port/key. ───
    await harness.close();
    const boot2 = await bootAS();
    harness = boot2.harness;

    // 1) Account row survived the restart with its argon2 hash intact.
    const restartedStorage = new FilesystemAuthStorageLayer({ rootDir: storageDir });
    const account = await restartedStorage.getAccount('local_persisted');
    expect(account).not.toBeNull();
    expect(account?.credentials?.passwordHash).toMatch(/^\$argon2id\$/);

    // 2) The access_token issued by AS-1 validates against AS-2 — proves the
    //    JWKS signing key file persisted across restart. Without persistence
    //    AS-2 would generate a new key and the token's `kid` wouldn't match.
    const validation = await harness.as.validate(tokenIssuedByAS1);
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(validation.claims.sub).toBe('local_persisted');

    // 3) A fresh OAuth flow on AS-2 succeeds via login (NOT invite) using the
    //    password set on AS-1 — proves argon2 hash round-tripped through the
    //    filesystem AND the rate-limiter state is consistent post-restart.
    const flow2 = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: authServer,
      clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      resource: `${publicBaseUrl}/mcp`, scope: 'mcp',
    });
    const loginPost = await postConsentForm(flow2.interactionUrl, flow2.jar, {
      action: 'login',
      username: 'persisted',
      password: 'a-very-long-password',
    });
    expect(loginPost.status).toBe(200);

    const approveLoginPost = await approveClientConsentPage({
      baseUrl: harness.baseUrl,
      response: loginPost,
      jar: flow2.jar,
    });
    expect([302, 303]).toContain(approveLoginPost.status);
    flow2.jar.ingest(approveLoginPost.headers);

    const code2 = await followToCodeRedirect({
      baseUrl: harness.baseUrl,
      start: approveLoginPost.headers.get('location'),
      jar: flow2.jar,
      redirectUriPrefix: REDIRECT_URI,
    });

    const tokenResp2 = await fetch(authServer.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code: code2,
        code_verifier: flow2.verifier,
        resource: `${publicBaseUrl}/mcp`,
      }),
    });
    expect(tokenResp2.status).toBe(200);
    const tokenBody2 = await tokenResp2.json() as { access_token: string };
    expect(tokenBody2.access_token).toBeTruthy();
    const validation2 = await harness.as.validate(tokenBody2.access_token);
    expect(validation2.ok).toBe(true);
    if (validation2.ok) expect(validation2.claims.sub).toBe('local_persisted');
  }, 60_000);
});
