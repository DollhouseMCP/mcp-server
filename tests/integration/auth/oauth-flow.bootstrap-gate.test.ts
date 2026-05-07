/**
 * Bootstrap gate (must-fix #22 / spec L923).
 *
 * Pins the contract that multi-user methods (local-password, magic-link,
 * github) refuse to accept authentication traffic until the operator
 * has run the admin-bootstrap CLI. Trivial-consent (single-user) is
 * exempt and never gated.
 *
 * Asserted invariants:
 *   - Multi-user mode + fresh storage → /authorize returns 503
 *     bootstrap_required with an actionable next_step body.
 *   - Multi-user mode + post-bootstrap → /authorize returns the normal
 *     303 redirect to /interaction/<uid>.
 *   - Trivial-consent mode → /authorize works without bootstrap.
 *   - /.well-known/* and /jwks ALWAYS work — clients need discovery
 *     even when the AS is closed.
 *   - Method-specific actionable hints in the 503 body match the
 *     configured methods.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { LocalAccountMethod } from '../../../src/auth/embedded-as/methods/LocalAccountMethod.js';
import { LocalLoginRateLimiter } from '../../../src/auth/embedded-as/rateLimit.js';
import { InviteTokenStore } from '../../../src/auth/embedded-as/inviteTokens.js';
import { TrivialConsentMethod } from '../../../src/auth/embedded-as/methods/TrivialConsentMethod.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import {
  type ASHarness,
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

describe('Bootstrap gate (must-fix #22)', () => {
  let harness: ASHarness | null = null;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = null;
  });

  function buildLocalMethod(storage: InMemoryAuthStorageLayer): LocalAccountMethod {
    const invites = new InviteTokenStore(randomBytes(32), storage);
    const rateLimiter = new LocalLoginRateLimiter({ storage });
    return new LocalAccountMethod({ storage, invites, rateLimiter });
  }

  it('multi-user mode + no bootstrap → /authorize returns 503 bootstrap_required', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const method = buildLocalMethod(storage);
    harness = await startASHarness({
      methods: [method],
      storage,
      skipAutoBootstrap: true,
    });

    const meta = await fetchAuthServerMetadata(harness.baseUrl);
    // Hit /authorize — should be gated.
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: 'unused',
      code_challenge_method: 'S256',
      resource: `${harness.publicBaseUrl}/mcp`,
      scope: 'mcp',
    });
    const resp = await fetch(`${meta.authorization_endpoint}?${params}`, {
      redirect: 'manual',
    });
    expect(resp.status).toBe(503);
    const body = await resp.json() as {
      error?: string;
      error_description?: string;
      next_step?: string;
    };
    expect(body.error).toBe('bootstrap_required');
    expect(body.next_step).toMatch(/dollhouse-create-user/);
  });

  it('multi-user mode + post-bootstrap → /authorize works normally', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const method = buildLocalMethod(storage);
    harness = await startASHarness({
      methods: [method],
      storage,
      skipAutoBootstrap: true,
    });

    // Operator runs the bootstrap CLI → flag flips.
    await storage.markBootstrapComplete('local_admin', 'local-password');

    const meta = await fetchAuthServerMetadata(harness.baseUrl);
    const flow = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: meta,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`,
      scope: 'mcp',
    });
    // startAuthorizeFlow throws if /authorize doesn't 302/303. Reaching
    // here means the gate let it through.
    expect(flow.interactionUrl).toMatch(/\/interaction\//);
  });

  it('trivial-consent mode → no gate, /authorize works without bootstrap', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const method = new TrivialConsentMethod({ defaultSubject: 'todd', storage });
    harness = await startASHarness({
      methods: [method],
      storage,
      // Even with skipAutoBootstrap, trivial-consent should work because
      // the gate is unconditionally open for non-multi-user methods.
      skipAutoBootstrap: true,
    });

    const meta = await fetchAuthServerMetadata(harness.baseUrl);
    const flow = await startAuthorizeFlow({
      baseUrl: harness.baseUrl,
      authServerMetadata: meta,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      resource: `${harness.publicBaseUrl}/mcp`,
      scope: 'mcp',
    });
    expect(flow.interactionUrl).toMatch(/\/interaction\//);
  });

  it('public discovery routes always work — even when gated', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const method = buildLocalMethod(storage);
    harness = await startASHarness({
      methods: [method],
      storage,
      skipAutoBootstrap: true,
    });

    // /.well-known/oauth-authorization-server
    const oauthMeta = await fetch(
      `${harness.baseUrl}/.well-known/oauth-authorization-server`,
    );
    expect(oauthMeta.status).toBe(200);

    // /.well-known/oauth-protected-resource
    const resourceMeta = await fetch(
      `${harness.baseUrl}/.well-known/oauth-protected-resource`,
    );
    expect(resourceMeta.status).toBe(200);

    // /jwks — must be public so token verifiers can fetch keys
    const jwks = await fetch(`${harness.baseUrl}/jwks`);
    expect(jwks.status).toBe(200);
  });

  it('503 body lists every configured multi-user method as a bootstrap option', async () => {
    // Multi-method deployment: local-password + magic-link + github.
    const storage = new InMemoryAuthStorageLayer();
    const local = buildLocalMethod(storage);
    // Magic-link / github don't strictly need to be functional for this
    // test — we just need their `id` in the methods array so the gate
    // surfaces them in the bootstrapHint.
    const fakeMagicLink = { id: 'magic-link' as const, displayName: 'Email magic link' };
    const fakeGithub = { id: 'github' as const, displayName: 'GitHub' };
    harness = await startASHarness({
      // The gate only reads `.id` off each method to render the hint.
      // beginInteraction etc. are never called in this test.
      methods: [local, fakeMagicLink, fakeGithub] as never,
      storage,
      skipAutoBootstrap: true,
    });

    const meta = await fetchAuthServerMetadata(harness.baseUrl);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: 'unused',
      code_challenge_method: 'S256',
      resource: `${harness.publicBaseUrl}/mcp`,
      scope: 'mcp',
    });
    const resp = await fetch(`${meta.authorization_endpoint}?${params}`, {
      redirect: 'manual',
    });
    expect(resp.status).toBe(503);
    const body = await resp.json() as { next_step?: string };
    expect(body.next_step).toMatch(/dollhouse-create-user/);
    expect(body.next_step).toMatch(/dollhouse-admin-bootstrap.*magic-link/);
    expect(body.next_step).toMatch(/dollhouse-admin-bootstrap.*github/);
  });

  it('gate caches positive completion — flips from closed to open without restart', async () => {
    const storage = new InMemoryAuthStorageLayer();
    const method = buildLocalMethod(storage);
    harness = await startASHarness({
      methods: [method],
      storage,
      skipAutoBootstrap: true,
    });

    const meta = await fetchAuthServerMetadata(harness.baseUrl);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: 'unused',
      code_challenge_method: 'S256',
      resource: `${harness.publicBaseUrl}/mcp`,
      scope: 'mcp',
    });

    // First call: gate closed.
    const closed = await fetch(`${meta.authorization_endpoint}?${params}`, {
      redirect: 'manual',
    });
    expect(closed.status).toBe(503);

    // Operator runs the bootstrap CLI.
    await storage.markBootstrapComplete('local_admin', 'local-password');

    // Subsequent call: gate open. No restart required.
    const open = await fetch(`${meta.authorization_endpoint}?${params}`, {
      redirect: 'manual',
    });
    expect(open.status).not.toBe(503);
  });
});
