import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import {
  AeadSecretEncryptionService,
  assembleSecuredConsoleRouter,
  ConsoleModuleRegistry,
  createConsoleBffAuthModule,
  HmacConsoleOpaqueValueService,
  InMemoryAdminAuditWriter,
  InMemoryConsoleIdentityResolver,
  InMemoryConsoleSessionStore,
  InMemoryIdempotencyStore,
  InMemoryLoginTransactionStore,
  InMemoryRuntimeSessionControlStore,
  type ConsoleLoginFlowKind,
  type ConsolePrincipalSecurityState,
  type ConsoleOAuthCodeExchangeRequest,
  type ConsoleOAuthIdentityClaims,
  type ConsoleAuthorizationUrlRequest,
  type IConsoleOAuthClient,
  type ISecretEncryptionService,
} from '../../../../src/web-console/index.js';
import {
  CONSOLE_CSRF_COOKIE,
  CONSOLE_LOGIN_STATE_COOKIE,
  CONSOLE_SESSION_COOKIE,
} from '../../../../src/web-console/middleware/ConsoleCookies.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const AUTH_SUB = 'github_user-7';
const NOW = new Date('2026-05-26T12:00:00.000Z');
const ORIGIN = 'https://console.example.test';
const OPAQUE_KEY = Buffer.alloc(32, 11);
const SECRET_KEY = Buffer.alloc(32, 9);
const LOGIN_PATH = '/api/v1/auth/login';
const CALLBACK_PATH = '/api/v1/auth/callback';
const STEP_UP_PATH = '/api/v1/auth/step-up';
const STEP_UP_CALLBACK_PATH = '/api/v1/auth/step-up/callback';
const STEP_DOWN_PATH = '/api/v1/auth/step-down';
const AUTH_CODE = 'auth-code-1';
const FAILED_CALLBACK_LOCATION = LOGIN_PATH;
const ADMIN_ACR = 'urn:dollhouse:acr:admin-stepup';
const SELF_CAPABILITY = 'console:self';
const ADMIN_CAPABILITY = 'console:admin:accounts';
const CSRF_HEADER = 'X-CSRF-Token';
const ME_PATH = '/api/v1/auth/me';

class FakeConsoleOAuthClient implements IConsoleOAuthClient {
  readonly authorizationRequests: ConsoleAuthorizationUrlRequest[] = [];
  readonly exchangeRequests: ConsoleOAuthCodeExchangeRequest[] = [];
  claims: ConsoleOAuthIdentityClaims = { sub: AUTH_SUB, displayName: 'Alice', email: 'alice@example.test' };
  rejectExchange = false;

  createAuthorizationUrl(request: ConsoleAuthorizationUrlRequest): string {
    this.authorizationRequests.push(request);
    const url = new URL('https://as.example.test/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', request.state);
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', request.codeChallengeMethod);
    url.searchParams.set('redirect_uri', request.redirectUri);
    if (request.prompt) url.searchParams.set('prompt', request.prompt);
    if (request.maxAgeSeconds !== undefined) url.searchParams.set('max_age', String(request.maxAgeSeconds));
    if (request.acrValues) url.searchParams.set('acr_values', request.acrValues);
    return url.toString();
  }

  async exchangeAuthorizationCode(request: ConsoleOAuthCodeExchangeRequest): Promise<ConsoleOAuthIdentityClaims> {
    await Promise.resolve();
    if (this.rejectExchange) {
      throw new Error('authorization server exchange failed');
    }
    this.exchangeRequests.push(request);
    return this.claims;
  }
}

interface FixtureOptions {
  readonly now?: () => Date;
  readonly principals?: readonly ConsolePrincipalSecurityState[];
  readonly secretEncryption?: ISecretEncryptionService;
}

function buildFixture(options: FixtureOptions = {}): {
  readonly app: express.Express;
  readonly oauthClient: FakeConsoleOAuthClient;
  readonly sessionStore: InMemoryConsoleSessionStore;
  readonly loginTransactions: InMemoryLoginTransactionStore;
  readonly opaqueValues: HmacConsoleOpaqueValueService;
} {
  const oauthClient = new FakeConsoleOAuthClient();
  const opaqueValues = new HmacConsoleOpaqueValueService(OPAQUE_KEY);
  const loginTransactions = new InMemoryLoginTransactionStore();
  const sessionStore = new InMemoryConsoleSessionStore();
  const principals = options.principals ?? [{
    sub: AUTH_SUB,
    userId: USER_ID,
    disabledAt: null,
    authzVersion: 3,
  }];
  const identityResolver = new InMemoryConsoleIdentityResolver(principals);
  const secretEncryption = options.secretEncryption ?? new AeadSecretEncryptionService({
    keyId: 'test-key',
    key: SECRET_KEY,
  });
  const registry = new ConsoleModuleRegistry();
  registry.register(createConsoleBffAuthModule({
    oauthClient,
    loginTransactions,
    sessionStore,
    identityResolver,
    opaqueValues,
    secretEncryption,
    publicBaseUrl: ORIGIN,
    now: options.now ?? (() => NOW),
  }));
  const app = express();
  app.use(assembleSecuredConsoleRouter(registry, {
    sessionStore,
    identityResolver,
    opaqueValues,
    consoleOrigin: ORIGIN,
    adminAuditWriter: new InMemoryAdminAuditWriter(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    runtimeStore: new InMemoryRuntimeSessionControlStore(),
    idleTimeoutMs: 60 * 60 * 1000,
    now: options.now ?? (() => NOW),
  }));
  return { app, oauthClient, sessionStore, loginTransactions, opaqueValues };
}

describe('ConsoleBffAuthModule', () => {
  it('starts a login transaction and redirects to the authorization server without requiring a session', async () => {
    const { app, oauthClient } = buildFixture();

    const response = await request(app).get(`${LOGIN_PATH}?return_to=/console`);

    expect(response.status).toBe(302);
    expect(response.headers.location).toMatch(/^https:\/\/as\.example\.test\/authorize\?/);
    expect(cookieValue(response.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE)).toBeTruthy();
    expect(oauthClient.authorizationRequests).toHaveLength(1);
    expect(oauthClient.authorizationRequests[0].redirectUri).toBe('https://console.example.test/api/v1/auth/callback');
    expect(oauthClient.authorizationRequests[0].codeChallengeMethod).toBe('S256');
    expect(oauthClient.authorizationRequests[0].codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('consumes the callback transaction once and establishes opaque session and CSRF cookies', async () => {
    const { app, oauthClient, sessionStore } = buildFixture();
    const login = await request(app).get(`${LOGIN_PATH}?return_to=/console`);
    const state = new URL(login.headers.location).searchParams.get('state');
    const loginCookie = cookieHeader(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE);

    const callback = await request(app)
      .get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', loginCookie);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/console');
    expect(cookieValue(callback.headers['set-cookie'], CONSOLE_SESSION_COOKIE)).toBeTruthy();
    expect(cookieValue(callback.headers['set-cookie'], CONSOLE_CSRF_COOKIE)).toBeTruthy();
    expect(oauthClient.exchangeRequests).toEqual([{
      code: AUTH_CODE,
      codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown as string,
      redirectUri: 'https://console.example.test/api/v1/auth/callback',
    }]);

    const sessionCookie = cookieHeader(callback.headers['set-cookie'], CONSOLE_SESSION_COOKIE);
    const sessionValue = cookieValue(callback.headers['set-cookie'], CONSOLE_SESSION_COOKIE);
    const session = await sessionStore.findActiveByIdHash(
      new HmacConsoleOpaqueValueService(OPAQUE_KEY).hashOpaqueValue(sessionValue ?? ''),
      NOW,
    );
    expect(session?.userId).toBe(USER_ID);
    expect(session?.authSub).toBe(AUTH_SUB);

    const me = await request(app).get(ME_PATH).set('Cookie', sessionCookie);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      user_id: USER_ID,
      auth_sub: AUTH_SUB,
      granted_capabilities: [SELF_CAPABILITY],
      available_admin_capabilities: [],
      elevation: { active: false, expires_at: null, acr: null },
    });
  });

  it('reports the role-entitled admin capabilities a principal can step up into', async () => {
    const { app } = buildFixture({
      principals: [{
        sub: AUTH_SUB,
        userId: USER_ID,
        disabledAt: null,
        authzVersion: 3,
        roles: ['operator'],
      }],
    });
    const login = await request(app).get(LOGIN_PATH);
    const state = new URL(login.headers.location).searchParams.get('state');
    const loginCookie = cookieHeader(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE);
    const callback = await request(app)
      .get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', loginCookie);
    const sessionCookie = cookieHeader(callback.headers['set-cookie'], CONSOLE_SESSION_COOKIE);

    const me = await request(app).get(ME_PATH).set('Cookie', sessionCookie);
    expect(me.status).toBe(200);
    // Not elevated: only console:self is *granted*, but operate is *available*
    // to step up into — so the UI can offer elevation without elevating yet.
    expect(me.body.granted_capabilities).toEqual([SELF_CAPABILITY]);
    expect(me.body.available_admin_capabilities).toEqual(['console:admin:operate']);
    expect(me.body.elevation).toEqual({ active: false, expires_at: null, acr: null });
  });

  it('rejects callback replay without exchanging the code again', async () => {
    const { app, oauthClient } = buildFixture();
    const login = await request(app).get(LOGIN_PATH);
    const state = new URL(login.headers.location).searchParams.get('state');
    const loginCookie = cookieHeader(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE);
    const callbackPath = `${CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`;

    await request(app).get(callbackPath).set('Cookie', loginCookie);
    const replay = await request(app).get(callbackPath).set('Cookie', loginCookie);

    expect(replay.status).toBe(302);
    expect(replay.headers.location).toBe(FAILED_CALLBACK_LOCATION);
    expect(oauthClient.exchangeRequests).toHaveLength(1);
  });

  it('rejects a callback with a tampered state while holding the transaction cookie', async () => {
    const { app, oauthClient } = buildFixture();
    const login = await request(app).get(LOGIN_PATH);

    const response = await request(app)
      .get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=tampered-state`)
      .set('Cookie', cookieHeader(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE));

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(FAILED_CALLBACK_LOCATION);
    expect(oauthClient.exchangeRequests).toHaveLength(0);
  });

  it.each([
    ['missing transient cookie', false, AUTH_CODE, 'state-from-login'],
    ['missing authorization code', true, null, 'state-from-login'],
    ['missing state', true, AUTH_CODE, null],
  ])('rejects callback with %s before exchanging the code', async (_label, includeCookie, code, stateOverride) => {
    const { app, oauthClient } = buildFixture();
    const login = await request(app).get(LOGIN_PATH);
    const state = stateOverride === 'state-from-login'
      ? new URL(login.headers.location).searchParams.get('state')
      : stateOverride;
    const params = new URLSearchParams();
    if (code) params.set('code', code);
    if (state) params.set('state', state);
    const call = request(app).get(`${CALLBACK_PATH}?${params.toString()}`);
    if (includeCookie) {
      call.set('Cookie', cookieHeader(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE));
    }

    const response = await call;

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(FAILED_CALLBACK_LOCATION);
    expect(oauthClient.exchangeRequests).toHaveLength(0);
  });

  it('rejects a callback bound to a non-login flow transaction', async () => {
    const { app, oauthClient, loginTransactions, opaqueValues } = buildFixture();
    const transactionId = 'non-login-transaction';
    const state = 'non-login-state';
    await loginTransactions.create(loginTransactionFixture({
      flowKind: 'step_up',
      idHash: opaqueValues.hashOpaqueValue(transactionId),
      stateHash: opaqueValues.hashOpaqueValue(state),
      pkceVerifierEnc: new AeadSecretEncryptionService({
        keyId: 'test-key',
        key: SECRET_KEY,
      }).encrypt(Buffer.from('step-up-verifier'), {
        secretClass: 'pkce_verifier',
        ownerId: `login:${transactionId}`,
      }),
      userId: USER_ID,
      consoleSessionIdHash: Buffer.alloc(32, 4),
      requestedCapability: 'console:admin:accounts',
    }));

    const response = await request(app)
      .get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state)}`)
      .set('Cookie', `${CONSOLE_LOGIN_STATE_COOKIE}=${encodeURIComponent(transactionId)}`);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(FAILED_CALLBACK_LOCATION);
    expect(oauthClient.exchangeRequests).toHaveLength(0);
  });

  it('rejects callbacks for disabled or unknown principals without creating a session', async () => {
    const { app, oauthClient } = buildFixture({
      principals: [{
        sub: AUTH_SUB,
        userId: USER_ID,
        disabledAt: new Date('2026-05-26T11:00:00.000Z'),
        authzVersion: 3,
      }],
    });
    const login = await request(app).get(LOGIN_PATH);
    const state = new URL(login.headers.location).searchParams.get('state');

    const response = await request(app)
      .get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', cookieHeader(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE));

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(FAILED_CALLBACK_LOCATION);
    expect(oauthClient.exchangeRequests).toHaveLength(1);
  });

  it('collapses OAuth exchange failures to the same failed callback redirect', async () => {
    const { app, oauthClient } = buildFixture();
    oauthClient.rejectExchange = true;
    const login = await request(app).get(LOGIN_PATH);
    const state = new URL(login.headers.location).searchParams.get('state');

    const response = await request(app)
      .get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', cookieHeader(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE));

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(FAILED_CALLBACK_LOCATION);
    expect(oauthClient.exchangeRequests).toHaveLength(0);
  });

  it('decrypts the exact PKCE verifier bytes bound to the login transaction context', async () => {
    const expectedVerifier = 'known-pkce-verifier';
    const secretEncryption = new KnownPkceEncryption(expectedVerifier);
    const { app, oauthClient } = buildFixture({ secretEncryption });
    const login = await request(app).get(LOGIN_PATH);
    const state = new URL(login.headers.location).searchParams.get('state');

    await request(app)
      .get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', cookieHeader(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE));

    expect(oauthClient.exchangeRequests[0]?.codeVerifier).toBe(expectedVerifier);
    expect(secretEncryption.decryptContexts[0]?.ownerId).toBe(
      `login:${cookieValue(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE) ?? ''}`,
    );
  });

  it('revokes the current session and clears browser cookies on logout', async () => {
    const { app, sessionStore } = buildFixture();
    const login = await request(app).get(LOGIN_PATH);
    const state = new URL(login.headers.location).searchParams.get('state');
    const callback = await request(app)
      .get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', cookieHeader(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE));
    const sessionValue = cookieValue(callback.headers['set-cookie'], CONSOLE_SESSION_COOKIE) ?? '';
    const csrfValue = cookieValue(callback.headers['set-cookie'], CONSOLE_CSRF_COOKIE) ?? '';
    const sessionHash = new HmacConsoleOpaqueValueService(OPAQUE_KEY).hashOpaqueValue(sessionValue);

    const logout = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', [
        `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(sessionValue)}`,
        `${CONSOLE_CSRF_COOKIE}=${encodeURIComponent(csrfValue)}`,
      ].join('; '))
      .set('Origin', ORIGIN)
      .set('X-Console-Request', '1')
      .set('X-CSRF-Token', csrfValue);

    expect(logout.status).toBe(204);
    expect(logout.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringContaining('dh_session=; Path=/; Max-Age=0; Secure; SameSite=Lax; HttpOnly'),
      expect.stringContaining('dh_csrf=; Path=/; Max-Age=0; Secure; SameSite=Lax'),
    ]));
    await expect(sessionStore.findActiveByIdHash(sessionHash, NOW)).resolves.toBeNull();
  });

  it('normalizes unsafe login return paths to the application root', async () => {
    const { app } = buildFixture();
    const login = await request(app).get(String.raw`${LOGIN_PATH}?return_to=/\evil.example`);
    const state = new URL(login.headers.location).searchParams.get('state');
    const callback = await request(app)
      .get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', cookieHeader(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE));

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/');
  });

  it('normalizes protocol-relative login return paths to the application root', async () => {
    const { app } = buildFixture();
    const login = await request(app).get(`${LOGIN_PATH}?return_to=//evil.example`);
    const state = new URL(login.headers.location).searchParams.get('state');
    const callback = await request(app)
      .get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', cookieHeader(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE));

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/');
  });

  it('serializes a non-null elevation in the current-session projection', async () => {
    const { app, sessionStore, opaqueValues } = buildFixture();
    const sessionValue = 'elevated-session';
    const csrfValue = 'elevated-csrf';
    await sessionStore.create({
      idHash: opaqueValues.hashOpaqueValue(sessionValue),
      userId: USER_ID,
      authSub: AUTH_SUB,
      csrfTokenHash: opaqueValues.hashOpaqueValue(csrfValue),
      grantedCapabilities: [SELF_CAPABILITY, ADMIN_CAPABILITY],
      elevation: {
        capabilities: ['console:admin:accounts'],
        expiresAt: new Date('2026-05-26T12:30:00.000Z'),
        acr: 'urn:dollhouse:acr:admin-stepup',
        amr: ['otp'],
        authTime: new Date('2026-05-26T12:05:00.000Z'),
      },
      createdAt: NOW,
      lastUsedAt: NOW,
      idleExpiresAt: new Date('2026-05-26T13:00:00.000Z'),
      absoluteExpiresAt: new Date('2026-05-27T12:00:00.000Z'),
      revokedAt: null,
      lastIp: null,
      userAgent: null,
    });

    const response = await request(app)
      .get(ME_PATH)
      .set('Cookie', `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(sessionValue)}`);

    expect(response.status).toBe(200);
    expect(response.body.elevation).toEqual({
      active: true,
      expires_at: '2026-05-26T12:30:00.000Z',
      acr: 'urn:dollhouse:acr:admin-stepup',
    });
  });

  it('starts a session-bound administrative step-up transaction with AS freshness parameters', async () => {
    const fixture = buildFixture();
    const session = await loginSession(fixture);

    const response = await request(fixture.app)
      .get(`${STEP_UP_PATH}?capability=${encodeURIComponent(ADMIN_CAPABILITY)}&return_to=/admin/accounts`)
      .set('Cookie', session.sessionCookie);

    expect(response.status).toBe(302);
    expect(cookieValue(response.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE)).toBeTruthy();
    const redirect = new URL(response.headers.location);
    expect(redirect.searchParams.get('prompt')).toBe('login');
    expect(redirect.searchParams.get('max_age')).toBe('0');
    expect(redirect.searchParams.get('acr_values')).toBe(ADMIN_ACR);
    expect(redirect.searchParams.get('code_challenge_method')).toBe('S256');
    expect(redirect.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${STEP_UP_CALLBACK_PATH}`);
  });

  it('completes step-up once and attaches TOTP-backed elevation to the current session', async () => {
    const fixture = buildFixture();
    fixture.oauthClient.claims = {
      sub: AUTH_SUB,
      acr: ADMIN_ACR,
      amr: ['pwd', 'otp'],
      authTime: NOW,
    };
    const session = await loginSession(fixture);
    const start = await request(fixture.app)
      .get(`${STEP_UP_PATH}?capability=${encodeURIComponent(ADMIN_CAPABILITY)}&return_to=/admin/accounts`)
      .set('Cookie', session.sessionCookie);
    const state = new URL(start.headers.location).searchParams.get('state');
    const loginStateCookie = cookieHeader(start.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE);

    const callback = await request(fixture.app)
      .get(`${STEP_UP_CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', `${session.sessionCookie}; ${loginStateCookie}`);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/admin/accounts');
    expect(callback.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringContaining('dh_login_state=; Path=/api/v1/auth; Max-Age=0'),
    ]));

    const me = await request(fixture.app).get(ME_PATH).set('Cookie', session.sessionCookie);
    expect(me.body.granted_capabilities).toEqual([SELF_CAPABILITY, ADMIN_CAPABILITY]);
    expect(me.body.elevation).toEqual({
      active: true,
      expires_at: '2026-05-26T12:30:00.000Z',
      acr: ADMIN_ACR,
    });
  });

  it('rejects step-up callback replay without extending elevation', async () => {
    const fixture = buildFixture();
    fixture.oauthClient.claims = {
      sub: AUTH_SUB,
      acr: ADMIN_ACR,
      amr: ['otp'],
      authTime: NOW,
    };
    const session = await loginSession(fixture);
    const start = await request(fixture.app)
      .get(`${STEP_UP_PATH}?capability=${encodeURIComponent(ADMIN_CAPABILITY)}`)
      .set('Cookie', session.sessionCookie);
    const state = new URL(start.headers.location).searchParams.get('state');
    const callbackPath = `${STEP_UP_CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`;
    const cookies = `${session.sessionCookie}; ${cookieHeader(start.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE)}`;

    await request(fixture.app).get(callbackPath).set('Cookie', cookies);
    const replay = await request(fixture.app).get(callbackPath).set('Cookie', cookies);

    expect(replay.status).toBe(302);
    expect(replay.headers.location).toBe(FAILED_CALLBACK_LOCATION);
    expect(fixture.oauthClient.exchangeRequests).toHaveLength(2);
  });

  it('rejects a step-up callback with a login transaction cookie', async () => {
    const fixture = buildFixture();
    const session = await loginSession(fixture);
    const login = await request(fixture.app).get(LOGIN_PATH);
    const state = new URL(login.headers.location).searchParams.get('state');

    const response = await request(fixture.app)
      .get(`${STEP_UP_CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', `${session.sessionCookie}; ${cookieHeader(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE)}`);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(FAILED_CALLBACK_LOCATION);
    expect(fixture.oauthClient.exchangeRequests).toHaveLength(1);
  });

  it.each([
    ['missing transient cookie', false, AUTH_CODE, 'state-from-step-up'],
    ['missing authorization code', true, null, 'state-from-step-up'],
    ['missing state', true, AUTH_CODE, null],
    ['tampered state', true, AUTH_CODE, 'tampered-state'],
  ])('rejects step-up callback with %s before exchanging the code', async (_label, includeCookie, code, stateOverride) => {
    const fixture = buildFixture();
    const session = await loginSession(fixture);
    const start = await request(fixture.app)
      .get(`${STEP_UP_PATH}?capability=${encodeURIComponent(ADMIN_CAPABILITY)}`)
      .set('Cookie', session.sessionCookie);
    const state = stateOverride === 'state-from-step-up'
      ? new URL(start.headers.location).searchParams.get('state')
      : stateOverride;
    const params = new URLSearchParams();
    if (code) params.set('code', code);
    if (state) params.set('state', state);
    const call = request(fixture.app).get(`${STEP_UP_CALLBACK_PATH}?${params.toString()}`)
      .set('Cookie', session.sessionCookie);
    if (includeCookie) {
      call.set('Cookie', `${session.sessionCookie}; ${cookieHeader(start.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE)}`);
    }

    const response = await call;

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(FAILED_CALLBACK_LOCATION);
    expect(fixture.oauthClient.exchangeRequests).toHaveLength(1);
  });

  it('collapses step-up OAuth exchange failures to the same failed callback redirect', async () => {
    const fixture = buildFixture();
    const session = await loginSession(fixture);
    fixture.oauthClient.rejectExchange = true;
    const start = await request(fixture.app)
      .get(`${STEP_UP_PATH}?capability=${encodeURIComponent(ADMIN_CAPABILITY)}`)
      .set('Cookie', session.sessionCookie);
    const state = new URL(start.headers.location).searchParams.get('state');

    const response = await request(fixture.app)
      .get(`${STEP_UP_CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', `${session.sessionCookie}; ${cookieHeader(start.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE)}`);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(FAILED_CALLBACK_LOCATION);
    expect(fixture.oauthClient.exchangeRequests).toHaveLength(1);
  });

  it('rejects step-up callback when elevation attachment loses the session race', async () => {
    const fixture = buildFixture();
    fixture.oauthClient.claims = { sub: AUTH_SUB, acr: ADMIN_ACR, amr: ['otp'], authTime: NOW };
    const session = await loginSession(fixture);
    const start = await request(fixture.app)
      .get(`${STEP_UP_PATH}?capability=${encodeURIComponent(ADMIN_CAPABILITY)}`)
      .set('Cookie', session.sessionCookie);
    const state = new URL(start.headers.location).searchParams.get('state');
    fixture.sessionStore.setElevation = () => Promise.resolve(false);

    const response = await request(fixture.app)
      .get(`${STEP_UP_CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', `${session.sessionCookie}; ${cookieHeader(start.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE)}`);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(FAILED_CALLBACK_LOCATION);
  });

  it.each([
    ['missing admin ACR', { sub: AUTH_SUB, amr: ['otp'], authTime: NOW }],
    ['missing OTP AMR', { sub: AUTH_SUB, acr: ADMIN_ACR, amr: ['pwd'], authTime: NOW }],
    ['missing auth_time', { sub: AUTH_SUB, acr: ADMIN_ACR, amr: ['otp'] }],
    ['future auth_time', {
      sub: AUTH_SUB,
      acr: ADMIN_ACR,
      amr: ['otp'],
      authTime: new Date('2026-05-26T12:01:00.000Z'),
    }],
    ['stale auth_time', {
      sub: AUTH_SUB,
      acr: ADMIN_ACR,
      amr: ['otp'],
      authTime: new Date('2026-05-26T11:20:00.000Z'),
    }],
    ['different principal', {
      sub: 'github_other',
      acr: ADMIN_ACR,
      amr: ['otp'],
      authTime: NOW,
    }],
  ])('rejects step-up callback with %s', async (_label, claims) => {
    const fixture = buildFixture({
      principals: [{
        sub: AUTH_SUB,
        userId: USER_ID,
        disabledAt: null,
        authzVersion: 3,
      }, {
        sub: 'github_other',
        userId: '118f3d47-73ae-7f10-a0de-0742618d4fb1',
        disabledAt: null,
        authzVersion: 1,
      }],
    });
    const session = await loginSession(fixture);
    fixture.oauthClient.claims = claims;
    const start = await request(fixture.app)
      .get(`${STEP_UP_PATH}?capability=${encodeURIComponent(ADMIN_CAPABILITY)}`)
      .set('Cookie', session.sessionCookie);
    const state = new URL(start.headers.location).searchParams.get('state');

    const response = await request(fixture.app)
      .get(`${STEP_UP_CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', `${session.sessionCookie}; ${cookieHeader(start.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE)}`);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(FAILED_CALLBACK_LOCATION);
    const me = await request(fixture.app).get(ME_PATH).set('Cookie', session.sessionCookie);
    expect(me.body.elevation).toEqual({ active: false, expires_at: null, acr: null });
  });

  it('rejects step-up callback bound to a different browser session', async () => {
    const fixture = buildFixture();
    fixture.oauthClient.claims = { sub: AUTH_SUB, acr: ADMIN_ACR, amr: ['otp'], authTime: NOW };
    const first = await loginSession(fixture);
    const second = await loginSession(fixture);
    const start = await request(fixture.app)
      .get(`${STEP_UP_PATH}?capability=${encodeURIComponent(ADMIN_CAPABILITY)}`)
      .set('Cookie', first.sessionCookie);
    const state = new URL(start.headers.location).searchParams.get('state');

    const response = await request(fixture.app)
      .get(`${STEP_UP_CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', `${second.sessionCookie}; ${cookieHeader(start.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE)}`);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(FAILED_CALLBACK_LOCATION);
  });

  it('rejects invalid requested step-up capabilities before creating a transaction', async () => {
    const fixture = buildFixture();
    const session = await loginSession(fixture);

    const response = await request(fixture.app)
      .get(`${STEP_UP_PATH}?capability=${encodeURIComponent(SELF_CAPABILITY)}`)
      .set('Cookie', session.sessionCookie);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 'invalid_capability',
      detail: 'Step-up requires a valid administrative console capability.',
    });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects missing requested step-up capability before creating a transaction', async () => {
    const fixture = buildFixture();
    const session = await loginSession(fixture);

    const response = await request(fixture.app)
      .get(STEP_UP_PATH)
      .set('Cookie', session.sessionCookie);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_capability');
  });

  it('rejects step-down without the session-bound CSRF header', async () => {
    const fixture = buildFixture();
    const session = await loginSession(fixture);

    const response = await request(fixture.app)
      .post(STEP_DOWN_PATH)
      .set('Cookie', session.allCookies)
      .set('Origin', ORIGIN)
      .set('X-Console-Request', '1');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('csrf_failed');
  });

  it('clears active elevation on step-down without revoking the session', async () => {
    const fixture = buildFixture();
    fixture.oauthClient.claims = { sub: AUTH_SUB, acr: ADMIN_ACR, amr: ['otp'], authTime: NOW };
    const session = await loginSession(fixture);
    const start = await request(fixture.app)
      .get(`${STEP_UP_PATH}?capability=${encodeURIComponent(ADMIN_CAPABILITY)}`)
      .set('Cookie', session.sessionCookie);
    const state = new URL(start.headers.location).searchParams.get('state');
    await request(fixture.app)
      .get(`${STEP_UP_CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
      .set('Cookie', `${session.sessionCookie}; ${cookieHeader(start.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE)}`);

    const response = await request(fixture.app)
      .post(STEP_DOWN_PATH)
      .set('Cookie', session.allCookies)
      .set('Origin', ORIGIN)
      .set('X-Console-Request', '1')
      .set(CSRF_HEADER, session.csrfValue);

    expect(response.status).toBe(204);
    const me = await request(fixture.app).get(ME_PATH).set('Cookie', session.sessionCookie);
    expect(me.body.granted_capabilities).toEqual([SELF_CAPABILITY]);
    expect(me.body.elevation).toEqual({ active: false, expires_at: null, acr: null });
  });
});

async function loginSession(fixture: ReturnType<typeof buildFixture>): Promise<{
  readonly sessionCookie: string;
  readonly allCookies: string;
  readonly csrfValue: string;
  readonly cookieValues: {
    readonly session: string;
    readonly csrf: string;
  };
}> {
  const login = await request(fixture.app).get(LOGIN_PATH);
  const state = new URL(login.headers.location).searchParams.get('state');
  const callback = await request(fixture.app)
    .get(`${CALLBACK_PATH}?code=${AUTH_CODE}&state=${encodeURIComponent(state ?? '')}`)
    .set('Cookie', cookieHeader(login.headers['set-cookie'], CONSOLE_LOGIN_STATE_COOKIE));
  const sessionValue = cookieValue(callback.headers['set-cookie'], CONSOLE_SESSION_COOKIE) ?? '';
  const csrfValue = cookieValue(callback.headers['set-cookie'], CONSOLE_CSRF_COOKIE) ?? '';
  return {
    sessionCookie: `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(sessionValue)}`,
    allCookies: [
      `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(sessionValue)}`,
      `${CONSOLE_CSRF_COOKIE}=${encodeURIComponent(csrfValue)}`,
    ].join('; '),
    csrfValue,
    cookieValues: {
      session: sessionValue,
      csrf: csrfValue,
    },
  };
}

function loginTransactionFixture(overrides: {
  readonly flowKind: ConsoleLoginFlowKind;
  readonly idHash: Buffer;
  readonly stateHash: Buffer;
  readonly pkceVerifierEnc: Buffer;
  readonly userId: string | null;
  readonly consoleSessionIdHash: Buffer | null;
  readonly requestedCapability: 'console:admin:accounts' | null;
}) {
  return {
    ...overrides,
    returnTo: '/',
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
    consumedAt: null,
  };
}

class KnownPkceEncryption implements ISecretEncryptionService {
  readonly decryptContexts: Array<{ secretClass: string; ownerId: string }> = [];

  constructor(private readonly plaintext: string) {}

  encrypt(_plaintext: Buffer): Buffer {
    return Buffer.from('known-ciphertext');
  }

  decrypt(_record: Buffer, context: { secretClass: string; ownerId: string }): Buffer {
    this.decryptContexts.push(context);
    return Buffer.from(this.plaintext);
  }
}

function cookieValue(setCookies: string[] | undefined, name: string): string | null {
  const cookie = setCookies?.find(value => value.startsWith(`${name}=`));
  if (!cookie) return null;
  return decodeURIComponent(cookie.slice(name.length + 1, cookie.indexOf(';')));
}

function cookieHeader(setCookies: string[] | undefined, name: string): string {
  const value = cookieValue(setCookies, name);
  if (!value) throw new Error(`Missing cookie ${name}`);
  return `${name}=${encodeURIComponent(value)}`;
}
