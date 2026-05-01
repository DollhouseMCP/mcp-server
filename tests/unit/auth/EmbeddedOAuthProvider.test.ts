import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { EmbeddedOAuthProvider } from '../../../src/auth/EmbeddedOAuthProvider.js';
import { createUnifiedAuthMiddleware } from '../../../src/auth/authMiddleware.js';
import { assertSafePublicBaseUrl } from '../../../src/auth/oauth/url.js';

function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('EmbeddedOAuthProvider', () => {
  let tempDir: string;
  let keyFilePath: string;
  let stateFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-oauth-'));
    keyFilePath = path.join(tempDir, 'oauth-key.json');
    stateFilePath = path.join(tempDir, 'oauth-state.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createApp(): { app: express.Express; provider: EmbeddedOAuthProvider } {
    const provider = new EmbeddedOAuthProvider({
      publicBaseUrl: 'http://127.0.0.1:3939',
      mcpPath: '/mcp',
      keyFilePath,
      stateFilePath,
      defaultSubject: 'operator',
    });
    const app = express();
    app.use(provider.createRouter());
    app.use('/mcp', createUnifiedAuthMiddleware({
      provider,
      protectedResourceMetadataUrl: provider.getProtectedResourceMetadataUrl(),
    }));
    app.post('/mcp', (_req, res) => res.json({ ok: true, claims: res.locals.authClaims }));
    return { app, provider };
  }

  it('returns protected resource and authorization server metadata', async () => {
    const { app } = createApp();

    const resource = await request(app).get('/.well-known/oauth-protected-resource');
    expect(resource.status).toBe(200);
    expect(resource.body.resource).toBe('http://127.0.0.1:3939/mcp');
    expect(resource.body.authorization_servers).toEqual(['http://127.0.0.1:3939']);

    const authServer = await request(app).get('/.well-known/oauth-authorization-server');
    expect(authServer.status).toBe(200);
    expect(authServer.body.authorization_endpoint).toBe('http://127.0.0.1:3939/oauth/authorize');
    expect(authServer.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(authServer.body.registration_endpoint).toBe('http://127.0.0.1:3939/oauth/register');
  });

  it('rejects public HTTP base URLs', () => {
    expect(() => assertSafePublicBaseUrl('http://example.com')).toThrow(/HTTPS/);
    expect(assertSafePublicBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(assertSafePublicBaseUrl('https://example.com')).toBe('https://example.com');
  });

  it('supports dynamic client registration', async () => {
    const { app } = createApp();

    const res = await request(app)
      .post('/oauth/register')
      .send({
        client_name: 'Claude Test',
        redirect_uris: ['http://127.0.0.1:5555/callback'],
      });

    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^dh_/);
    expect(res.body.token_endpoint_auth_method).toBe('none');
  });

  it('persists dynamic clients across provider restarts', async () => {
    const first = createApp();
    const registration = await request(first.app)
      .post('/oauth/register')
      .send({
        client_name: 'Restarted Claude Test',
        redirect_uris: ['http://127.0.0.1:7777/callback'],
      });
    expect(registration.status).toBe(201);

    const restarted = createApp();
    const consent = await request(restarted.app)
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: registration.body.client_id,
        redirect_uri: 'http://127.0.0.1:7777/callback',
        code_challenge: pkceS256('persisted-client-verifier'),
        code_challenge_method: 'S256',
      });

    expect(consent.status).toBe(200);
    expect(consent.text).toContain('Approve Connector');
  });

  it('rejects missing and plain PKCE authorization requests', async () => {
    const { app } = createApp();

    const noPkce = await request(app)
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: 'dollhouse-claude-connector',
        redirect_uri: 'http://127.0.0.1/callback',
      });
    expect(noPkce.status).toBe(400);

    const plainPkce = await request(app)
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: 'dollhouse-claude-connector',
        redirect_uri: 'http://127.0.0.1/callback',
        code_challenge: 'abc',
        code_challenge_method: 'plain',
      });
    expect(plainPkce.status).toBe(400);
  });

  it('exchanges an authorization code once and validates the MCP access token', async () => {
    const { app, provider } = createApp();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = pkceS256(verifier);

    const consent = await request(app)
      .post('/oauth/authorize')
      .type('form')
      .send({
        response_type: 'code',
        client_id: 'dollhouse-claude-connector',
        redirect_uri: 'http://127.0.0.1/callback',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'http://127.0.0.1:3939/mcp',
        scope: 'mcp offline_access',
        state: 'state-1',
      });

    expect(consent.status).toBe(302);
    const redirectUrl = new URL(consent.headers.location);
    const code = redirectUrl.searchParams.get('code');
    expect(code).toBeTruthy();
    expect(redirectUrl.searchParams.get('state')).toBe('state-1');

    const token = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: 'dollhouse-claude-connector',
        redirect_uri: 'http://127.0.0.1/callback',
        code,
        code_verifier: verifier,
      });

    expect(token.status).toBe(200);
    expect(token.body.access_token).toBeTruthy();
    expect(token.body.refresh_token).toBeTruthy();
    await expect(provider.validate(token.body.access_token)).resolves.toMatchObject({
      ok: true,
      claims: { sub: 'operator' },
    });

    const protectedResponse = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${token.body.access_token}`)
      .send({});
    expect(protectedResponse.status).toBe(200);
    expect(protectedResponse.body.claims.sub).toBe('operator');

    const replay = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: 'dollhouse-claude-connector',
        redirect_uri: 'http://127.0.0.1/callback',
        code,
        code_verifier: verifier,
      });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
  });

  it('persists refresh tokens across provider restarts', async () => {
    const { app } = createApp();
    const verifier = randomBytes(32).toString('base64url');
    const consent = await request(app)
      .post('/oauth/authorize')
      .type('form')
      .send({
        response_type: 'code',
        client_id: 'dollhouse-claude-connector',
        redirect_uri: 'http://127.0.0.1/callback',
        code_challenge: pkceS256(verifier),
        code_challenge_method: 'S256',
        resource: 'http://127.0.0.1:3939/mcp',
        scope: 'mcp offline_access',
      });
    const code = new URL(consent.headers.location).searchParams.get('code');

    const token = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: 'dollhouse-claude-connector',
        redirect_uri: 'http://127.0.0.1/callback',
        code,
        code_verifier: verifier,
      });
    expect(token.status).toBe(200);

    const restarted = createApp();
    const refreshed = await request(restarted.app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: token.body.refresh_token,
      });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toBeTruthy();
  });

  it('returns a WWW-Authenticate discovery header for missing MCP tokens', async () => {
    const { app, provider } = createApp();

    const res = await request(app).post('/mcp').send({});
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${provider.getProtectedResourceMetadataUrl()}"`,
    );
  });
});
