import { describe, expect, it } from '@jest/globals';

import {
  AeadSecretEncryptionService,
  createIntegrationModule,
  HmacConsoleOpaqueValueService,
  InMemoryUserIntegrationStore,
  InMemoryLoginTransactionStore,
  CONSOLE_INTEGRATION_STATE_COOKIE,
  CONSOLE_LOGIN_STATE_COOKIE,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
  type IGitHubIntegrationProvider,
  type IIntegrationSecurityEventSink,
  type IntegrationCallbackRejectedEvent,
  type UserIntegrationRecord,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const OTHER_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const PRIMARY_SUB = 'github_user-7';
const SELF_CAPABILITY = 'console:self';
const NOW = new Date('2026-05-28T10:00:00.000Z');
const LAST_SYNC = new Date('2026-05-28T10:30:00.000Z');
const LIST_PATH = '/api/v1/me/integrations';
const GITHUB_PATH = '/api/v1/me/integrations/github';
const GITHUB_CONNECT_PATH = '/api/v1/me/integrations/github/connect';
const GITHUB_CALLBACK_PATH = '/api/v1/me/integrations/github/callback';
const PUBLIC_BASE_URL = 'https://console.example';
const SETTINGS_INTEGRATIONS_PATH = '/settings/integrations';
const PROVIDER_CODE = 'provider-code';
const START_TRANSACTION_ERROR = 'fixture did not start integration transaction';

function authenticatedContext(userId = USER_ID): NonNullable<ConsoleRequest['consoleAuthentication']> {
  return {
    sessionIdHash: Buffer.alloc(32, 7),
    userId,
    authSub: PRIMARY_SUB,
    authzVersion: 3,
    grantedCapabilities: [SELF_CAPABILITY],
    elevation: null,
  };
}

function consoleRequest(overrides: Partial<ConsoleRequest> = {}): ConsoleRequest {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    consoleAuthentication: authenticatedContext(),
    ...overrides,
  } as ConsoleRequest;
}

function integrationFixture(overrides: Partial<UserIntegrationRecord> = {}): UserIntegrationRecord {
  return {
    id: '35e22a52-dc56-4cd0-9d13-b2802524fbd3',
    userId: USER_ID,
    provider: 'github',
    externalAccountLabel: 'alice',
    externalInstallationId: 'installation-123',
    authorizedPermissions: {
      repository_selection: 'selected',
      permissions: { contents: 'read' },
    },
    accessTokenCiphertext: Buffer.from('encrypted-access-token'),
    refreshTokenCiphertext: Buffer.from('encrypted-refresh-token'),
    credentialKeyVersion: 'integration-key-v1',
    status: 'connected',
    errorReason: null,
    connectedAt: NOW,
    lastSyncAt: LAST_SYNC,
    revokedAt: null,
    ...overrides,
  };
}

function moduleFixture(records: readonly UserIntegrationRecord[] = [integrationFixture()]) {
  const store = new InMemoryUserIntegrationStore(records);
  const module = createIntegrationModule({ integrationStore: store });
  return { module, store };
}

function writeModuleFixture(options: {
  readonly records?: readonly UserIntegrationRecord[];
  readonly now?: () => Date;
  readonly provider?: FixtureGitHubIntegrationProvider;
  readonly securityEventSink?: FixtureIntegrationSecurityEventSink;
} = {}) {
  const records = options.records ?? [];
  const store = new InMemoryUserIntegrationStore(records);
  const loginTransactions = new InMemoryLoginTransactionStore();
  const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
  const secretEncryption = new AeadSecretEncryptionService({
    keyId: 'integration-test-key',
    key: Buffer.alloc(32, 9),
  });
  const provider = options.provider ?? new FixtureGitHubIntegrationProvider();
  const securityEventSink = options.securityEventSink ?? new FixtureIntegrationSecurityEventSink();
  const module = createIntegrationModule({
    integrationStore: store,
    loginTransactions,
    opaqueValues,
    secretEncryption,
    githubProvider: provider,
    publicBaseUrl: PUBLIC_BASE_URL,
    securityEventSink,
    now: options.now ?? (() => NOW),
  });
  return { module, store, loginTransactions, opaqueValues, secretEncryption, provider, securityEventSink };
}

function findRoute(
  routes: readonly ConsoleRouteDefinition[],
  path: string,
  method = 'GET',
): ConsoleRouteDefinition {
  const route = routes.find(candidate => candidate.path === path && candidate.method === method);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

describe('IntegrationModule', () => {
  it('registers self-private integration read descriptors', () => {
    const { module } = moduleFixture([]);

    expect(module).toMatchObject({
      id: 'integrations',
      apiVersion: 'v1',
      capabilities: [SELF_CAPABILITY],
    });
    expect(module.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'GET',
        path: LIST_PATH,
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        method: 'GET',
        path: GITHUB_PATH,
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        privacyClass: 'self_private',
      }),
      expect.objectContaining({
        method: 'POST',
        path: GITHUB_CONNECT_PATH,
        ownership: 'authenticated_user',
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'GET',
        path: GITHUB_CALLBACK_PATH,
        ownership: 'flow_transaction',
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        method: 'DELETE',
        path: GITHUB_PATH,
        ownership: 'authenticated_user',
        idempotency: 'required',
      }),
    ]));
  });

  it('returns GitHub status without token or ciphertext material', async () => {
    const { module } = moduleFixture();
    const getGitHub = findRoute(module.routes, GITHUB_PATH);

    const result = await getGitHub.handler(consoleRequest());

    expect(result).toEqual({
      status: 200,
      body: {
        provider: 'github',
        status: 'connected',
        account_label: 'alice',
        repository_selection: 'selected',
        permissions: { contents: 'read' },
        sync_directions: ['pull'],
        error_reason: null,
        connected_at: NOW.toISOString(),
        last_sync_at: LAST_SYNC.toISOString(),
      },
    });
    expect(JSON.stringify(result.body)).not.toContain('token');
    expect(JSON.stringify(result.body)).not.toContain('ciphertext');
    expect(getGitHub.privacyProjector?.({
      ...(result.body as Record<string, unknown>),
      access_token_ciphertext: 'leak',
      refresh_token_ciphertext: 'leak',
      token_hash: 'leak',
      permissions: { contents: 'read', administration: 'write' },
    })).toEqual(result.body);
  });

  it('derives write-capable sync directions only from explicit contents write permission', async () => {
    const { module } = moduleFixture([integrationFixture({
      authorizedPermissions: {
        repository_selection: 'selected',
        permissions: { contents: 'write' },
      },
    })]);
    const getGitHub = findRoute(module.routes, GITHUB_PATH);

    await expect(getGitHub.handler(consoleRequest())).resolves.toMatchObject({
      status: 200,
      body: {
        permissions: { contents: 'write' },
        sync_directions: ['pull', 'push', 'bidirectional'],
      },
    });
  });

  it('returns disconnected status for missing or non-owned integration records', async () => {
    const { module } = moduleFixture([integrationFixture({ userId: OTHER_USER_ID })]);
    const list = findRoute(module.routes, LIST_PATH);
    const getGitHub = findRoute(module.routes, GITHUB_PATH);

    await expect(getGitHub.handler(consoleRequest())).resolves.toEqual({
      status: 200,
      body: {
        provider: 'github',
        status: 'disconnected',
        account_label: null,
        repository_selection: 'unknown',
        permissions: { contents: 'none' },
        sync_directions: [],
        error_reason: null,
        connected_at: null,
        last_sync_at: null,
      },
    });
    await expect(list.handler(consoleRequest())).resolves.toMatchObject({
      status: 200,
      body: {
        integrations: [expect.objectContaining({ provider: 'github', status: 'disconnected' })],
      },
    });
  });

  it('requires authentication and ignores caller-supplied owner parameters', async () => {
    const { module } = moduleFixture();
    const getGitHub = findRoute(module.routes, GITHUB_PATH);

    await expect(getGitHub.handler(consoleRequest({ consoleAuthentication: undefined }))).rejects
      .toThrow('authentication middleware');
    await expect(getGitHub.handler(consoleRequest({ params: { user_id: OTHER_USER_ID } }))).resolves
      .toMatchObject({ status: 200, body: { account_label: 'alice' } });
  });

  it('starts GitHub link with integration state cookie and not login state', async () => {
    const { module, provider } = writeModuleFixture();
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');

    const result = await connect.handler(consoleRequest({
      body: {
        contents_permission: 'write',
        return_to: SETTINGS_INTEGRATIONS_PATH,
      },
    }));

    expect(result).toMatchObject({
      status: 302,
      redirectTo: expect.stringContaining('https://github.example/install?state='),
      cookies: [expect.objectContaining({
        operation: 'set',
        name: CONSOLE_INTEGRATION_STATE_COOKIE,
      })],
    });
    expect(result.cookies).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: CONSOLE_LOGIN_STATE_COOKIE }),
    ]));
    expect(provider.authorizations[0]).toMatchObject({
      contentsPermission: 'write',
      redirectUri: `${PUBLIC_BASE_URL}${GITHUB_CALLBACK_PATH}`,
      codeChallengeMethod: 'S256',
    });
  });

  it('completes GitHub callback only with dh_integration_state and encrypted credentials', async () => {
    const { module, store, secretEncryption, provider } = writeModuleFixture();
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    const started = await connect.handler(consoleRequest({
      body: { return_to: SETTINGS_INTEGRATIONS_PATH },
    }));
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = provider.authorizations[0]?.state;
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    const result = await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    expect(result).toEqual({
      status: 302,
      redirectTo: SETTINGS_INTEGRATIONS_PATH,
      cookies: [{ operation: 'clear', name: CONSOLE_INTEGRATION_STATE_COOKIE }],
    });
    const stored = await store.findByProvider(USER_ID, 'github');
    expect(stored).toMatchObject({
      userId: USER_ID,
      provider: 'github',
      externalAccountLabel: 'alice',
      externalInstallationId: 'installation-456',
      authorizedPermissions: {
        repository_selection: 'selected',
        permissions: { contents: 'read' },
      },
    });
    expect(stored?.accessTokenCiphertext?.toString('utf8')).not.toContain(provider.accessToken);
    expect(secretEncryption.decrypt(stored?.accessTokenCiphertext ?? Buffer.alloc(0), {
      secretClass: 'integration_access_token',
      ownerId: `github:${USER_ID}`,
    }).toString('utf8')).toBe(provider.accessToken);
  });

  it('rejects callback attempts that present only login state', async () => {
    const { module, store, provider, securityEventSink } = writeModuleFixture();
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    await connect.handler(consoleRequest());
    const state = provider.authorizations[0]?.state;
    if (!state) throw new Error(START_TRANSACTION_ERROR);

    const result = await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_LOGIN_STATE_COOKIE}=login-transaction` },
      query: { code: PROVIDER_CODE, state },
    }));

    expect(result).toEqual({
      status: 302,
      redirectTo: GITHUB_CONNECT_PATH.replace('/github/connect', ''),
      cookies: [{ operation: 'clear', name: CONSOLE_INTEGRATION_STATE_COOKIE }],
    });
    await expect(store.findByProvider(USER_ID, 'github')).resolves.toBeNull();
    expect(securityEventSink.events).toEqual([
      expect.objectContaining({
        type: 'console.auth.integration_callback_rejected.v1',
        provider: 'github',
        userId: USER_ID,
        reason: 'missing',
      }),
    ]);
  });

  it('returns 503 for GitHub writes when write dependencies are unavailable', async () => {
    const store = new InMemoryUserIntegrationStore();
    const module = createIntegrationModule({ integrationStore: store });
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');

    await expect(connect.handler(consoleRequest())).resolves.toMatchObject({
      status: 503,
      body: {
        title: 'Service unavailable',
      },
    });
  });

  it('rejects callbacks with missing transaction id, code, or provider state', async () => {
    const missingCases = [
      { headers: {}, query: { code: PROVIDER_CODE, state: 'provider-state' } },
      { headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=transaction` }, query: { state: 'provider-state' } },
      { headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=transaction` }, query: { code: PROVIDER_CODE } },
    ];

    for (const missingCase of missingCases) {
      const { module, securityEventSink } = writeModuleFixture();
      const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
      const result = await callback.handler(consoleRequest({
        headers: missingCase.headers,
        query: missingCase.query,
      }));

      expect(result).toMatchObject({ status: 302, redirectTo: LIST_PATH });
      expect(securityEventSink.events).toEqual([
        expect.objectContaining({ reason: 'missing' }),
      ]);
    }
  });

  it('rejects cross-user integration callback replay with a security event', async () => {
    const { module, store, provider, securityEventSink } = writeModuleFixture();
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    const started = await connect.handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = provider.authorizations[0]?.state;
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    const result = await callback.handler(consoleRequest({
      consoleAuthentication: authenticatedContext(OTHER_USER_ID),
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    expect(result).toMatchObject({ status: 302, redirectTo: LIST_PATH });
    await expect(store.findByProvider(OTHER_USER_ID, 'github')).resolves.toBeNull();
    expect(securityEventSink.events).toEqual([
      expect.objectContaining({ userId: OTHER_USER_ID, reason: 'user_mismatch' }),
    ]);
  });

  it('rejects integration callback replay from a different browser session', async () => {
    const { module, store, provider, securityEventSink } = writeModuleFixture();
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    const started = await connect.handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = provider.authorizations[0]?.state;
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    const result = await callback.handler(consoleRequest({
      consoleAuthentication: {
        ...authenticatedContext(),
        sessionIdHash: Buffer.alloc(32, 8),
      },
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    expect(result).toMatchObject({ status: 302, redirectTo: LIST_PATH });
    await expect(store.findByProvider(USER_ID, 'github')).resolves.toBeNull();
    expect(securityEventSink.events).toEqual([
      expect.objectContaining({ userId: USER_ID, reason: 'session_mismatch' }),
    ]);
  });

  it('classifies consumed and expired callback transactions', async () => {
    let currentNow = NOW;
    const { module, provider, securityEventSink } = writeModuleFixture({ now: () => currentNow });
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    const started = await connect.handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = provider.authorizations[0]?.state;
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);
    await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    const expiredStart = await connect.handler(consoleRequest());
    const expiredTransactionId = cookieValue(expiredStart, CONSOLE_INTEGRATION_STATE_COOKIE);
    const expiredState = provider.authorizations[1]?.state;
    if (!expiredTransactionId || !expiredState) throw new Error('fixture did not start expired transaction');
    currentNow = new Date(NOW.getTime() + 11 * 60 * 1000);
    await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(expiredTransactionId)}` },
      query: { code: PROVIDER_CODE, state: expiredState },
    }));

    expect(securityEventSink.events).toEqual([
      expect.objectContaining({ reason: 'consumed' }),
      expect.objectContaining({ reason: 'expired' }),
    ]);
  });

  it('records token exchange failures without exposing credentials', async () => {
    const provider = new FixtureGitHubIntegrationProvider();
    provider.exchangeFails = true;
    const { module, store } = writeModuleFixture({ provider });
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    const started = await connect.handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = provider.authorizations[0]?.state;
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    const result = await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    expect(result).toMatchObject({ status: 302 });
    await expect(store.findByProvider(USER_ID, 'github')).resolves.toMatchObject({
      status: 'error',
      errorReason: 'token_exchange_failed',
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
    });
    const getGitHub = findRoute(module.routes, GITHUB_PATH);
    await expect(getGitHub.handler(consoleRequest())).resolves.toMatchObject({
      body: {
        status: 'error',
        error_reason: 'token_exchange_failed',
      },
    });
  });

  it('treats tampered PKCE verifier ciphertext as a rejected callback instead of throwing', async () => {
    const { module, store, loginTransactions, opaqueValues, secretEncryption, securityEventSink } = writeModuleFixture();
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    const transactionId = opaqueValues.createOpaqueValue();
    const state = opaqueValues.createOpaqueValue();
    await loginTransactions.create({
      idHash: opaqueValues.hashOpaqueValue(transactionId),
      flowKind: 'integration_link',
      stateHash: opaqueValues.hashOpaqueValue(state),
      pkceVerifierEnc: secretEncryption.encrypt(Buffer.from('pkce-verifier', 'utf8'), {
        secretClass: 'pkce_verifier',
        ownerId: 'integration:wrong-transaction',
      }),
      userId: USER_ID,
      consoleSessionIdHash: Buffer.alloc(32, 7),
      requestedCapability: null,
      returnTo: SETTINGS_INTEGRATIONS_PATH,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
      consumedAt: null,
    });

    const result = await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    expect(result).toMatchObject({ status: 302, redirectTo: SETTINGS_INTEGRATIONS_PATH });
    await expect(store.findByProvider(USER_ID, 'github')).resolves.toBeNull();
    expect(securityEventSink.events).toEqual([
      expect.objectContaining({ reason: 'consumed' }),
    ]);
  });

  it('disconnects GitHub by revoking remote credentials and clearing local ciphertext', async () => {
    const { module, store, provider } = writeModuleFixture();
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    const disconnect = findRoute(module.routes, GITHUB_PATH, 'DELETE');
    const started = await connect.handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = provider.authorizations[0]?.state;
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);
    await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    const result = await disconnect.handler(consoleRequest());

    expect(result).toMatchObject({
      status: 200,
      body: {
        provider: 'github',
        status: 'disconnected',
        permissions: { contents: 'none' },
      },
    });
    expect(provider.revocations).toHaveLength(1);
    expect(provider.revocations[0]).toMatchObject({
      accessToken: provider.accessToken,
      refreshToken: 'github-refresh-token-secret',
      installationId: 'installation-456',
    });
    expect(await store.findByProvider(USER_ID, 'github')).toBeNull();
  });

  it('keeps local credential invalidation when remote revocation fails', async () => {
    const provider = new FixtureGitHubIntegrationProvider();
    const { module, store } = writeModuleFixture({ provider });
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    const disconnect = findRoute(module.routes, GITHUB_PATH, 'DELETE');
    const started = await connect.handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = provider.authorizations[0]?.state;
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);
    await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));
    provider.revokeFails = true;

    const result = await disconnect.handler(consoleRequest());

    expect(result).toMatchObject({
      status: 200,
      body: {
        provider: 'github',
        status: 'error',
        error_reason: 'revocation_failed',
      },
    });
    expect(await store.findByProvider(USER_ID, 'github')).toMatchObject({
      status: 'error',
      errorReason: 'revocation_failed',
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
    });
  });

  it('binds encrypted integration credentials to the owning user AAD', async () => {
    const { module, store, secretEncryption, provider } = writeModuleFixture();
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    const started = await connect.handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = provider.authorizations[0]?.state;
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);
    await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));
    const stored = await store.findByProvider(USER_ID, 'github');
    if (!stored?.accessTokenCiphertext) throw new Error('fixture did not store access token ciphertext');

    expect(() => secretEncryption.decrypt(stored.accessTokenCiphertext ?? Buffer.alloc(0), {
      secretClass: 'integration_access_token',
      ownerId: `github:${OTHER_USER_ID}`,
    })).toThrow('authentication failed');
  });
});

function cookieValue(result: Awaited<ReturnType<ConsoleRouteDefinition['handler']>>, name: string): string | null {
  const cookie = result.cookies?.find(candidate => candidate.operation === 'set' && candidate.name === name);
  return cookie?.operation === 'set' ? cookie.value : null;
}

class FixtureGitHubIntegrationProvider implements IGitHubIntegrationProvider {
  readonly authorizations: Parameters<IGitHubIntegrationProvider['createAuthorizationUrl']>[0][] = [];
  readonly revocations: Parameters<IGitHubIntegrationProvider['revokeCredentials']>[0][] = [];
  readonly accessToken = 'github-access-token-secret';
  exchangeFails = false;
  revokeFails = false;

  createAuthorizationUrl(request: Parameters<IGitHubIntegrationProvider['createAuthorizationUrl']>[0]): string {
    this.authorizations.push(request);
    return `https://github.example/install?state=${encodeURIComponent(request.state)}`;
  }

  exchangeAuthorizationCode(): Promise<Awaited<ReturnType<IGitHubIntegrationProvider['exchangeAuthorizationCode']>>> {
    if (this.exchangeFails) return Promise.reject(new Error('provider exchange failed'));
    return Promise.resolve({
      accountLabel: 'alice',
      installationId: 'installation-456',
      repositorySelection: 'selected',
      contentsPermission: 'read',
      accessToken: this.accessToken,
      refreshToken: 'github-refresh-token-secret',
    });
  }

  revokeCredentials(request: Parameters<IGitHubIntegrationProvider['revokeCredentials']>[0]): Promise<void> {
    this.revocations.push(request);
    if (this.revokeFails) return Promise.reject(new Error('provider revoke failed'));
    return Promise.resolve();
  }
}

class FixtureIntegrationSecurityEventSink implements IIntegrationSecurityEventSink {
  readonly events: IntegrationCallbackRejectedEvent[] = [];

  async recordIntegrationCallbackRejected(event: IntegrationCallbackRejectedEvent): Promise<void> {
    await Promise.resolve();
    this.events.push(event);
  }
}
