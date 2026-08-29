import { describe, expect, it, jest } from '@jest/globals';

import {
  AeadSecretEncryptionService,
  ConfiguredOAuthIntegrationProvider,
  createIntegrationModule,
  HmacConsoleOpaqueValueService,
  InMemoryUserIntegrationStore,
  InMemoryLoginTransactionStore,
  IntegrationDescriptorChangedError,
  CONSOLE_INTEGRATION_STATE_COOKIE,
  CONSOLE_LOGIN_STATE_COOKIE,
  IntegrationProviderRegistry,
  IntegrationService,
  IntegrationTokenRefreshService,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
  type IGitHubIntegrationProvider,
  type IIntegrationSecurityEventSink,
  type IntegrationCallbackRejectedEvent,
  StaticApiKeyIntegrationProvider,
  type IntegrationDescriptorRecord,
  type UserIntegrationRecord,
} from '../../../../src/web-console/index.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import type {
  PinnedFetch,
  PinnedOutboundFactory,
} from '../../../../src/web-console/modules/integrations/PinnedOutboundFactory.js';

function formBodyString(body: RequestInit['body']): string | null {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return null;
}

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
const GMAIL_PATH = '/api/v1/me/integrations/gmail';
const GMAIL_CONNECT_PATH = '/api/v1/me/integrations/gmail/connect';
const GMAIL_CALLBACK_PATH = '/api/v1/me/integrations/gmail/callback';
const CALENDAR_CALLBACK_PATH = '/api/v1/me/integrations/calendar/callback';
const AIRTABLE_PATH = '/api/v1/me/integrations/airtable';
const AIRTABLE_CONNECT_PATH = '/api/v1/me/integrations/airtable/connect';
const PUBLIC_BASE_URL = 'https://console.example';
const SETTINGS_INTEGRATIONS_PATH = '/settings/integrations';
const PROVIDER_CODE = 'provider-code';
const START_TRANSACTION_ERROR = 'fixture did not start integration transaction';
const PUBLIC_TEST_ADDRESS = [8, 8, 8, 8].join('.');
const TEST_ENCRYPTION_KEY_ID = 'integration-test-key';
const GMAIL_CLIENT_SECRET = 'gmail-client-secret';
const GMAIL_ACCESS_TOKEN = 'gmail-access-token-secret';
const GMAIL_REFRESH_TOKEN = 'gmail-refresh-token-secret';
const GMAIL_ACCOUNT_LABEL = 'alice@example.com';
const GMAIL_READONLY_SCOPE = 'gmail.readonly';
const NOT_REACHED_ERROR = 'not reached';
const ORIGINAL_CLIENT_SECRET = 'original-client-secret';

function configuredOAuthNetwork(fetchImpl: typeof fetch): {
  readonly dnsLookup: () => Promise<readonly [{ readonly address: string; readonly family: 4 }]>;
  readonly pinnedOutbound: PinnedOutboundFactory;
} {
  return {
    dnsLookup: () => Promise.resolve([{ address: PUBLIC_TEST_ADDRESS, family: 4 }]),
    pinnedOutbound: () => ({
      fetch: fetchImpl as PinnedFetch,
      close: () => Promise.resolve(),
    }),
  };
}

function successfulConfiguredOAuthFetch(): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({
    access_token: GMAIL_ACCESS_TOKEN,
    refresh_token: GMAIL_REFRESH_TOKEN,
    email: GMAIL_ACCOUNT_LABEL,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

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
    integrationDescriptorId: null,
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
    cleanupAttemptCount: 0,
    cleanupNextAttemptAt: null,
    cleanupLeaseId: null,
    cleanupLeaseExpiresAt: null,
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
    keyId: TEST_ENCRYPTION_KEY_ID,
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
        idempotency: 'not_applicable',
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

  it('lists registered provider catalog entries even when write provider is unavailable', async () => {
    const store = new InMemoryUserIntegrationStore();
    const module = createIntegrationModule({ integrationStore: store });
    const list = findRoute(module.routes, LIST_PATH);

    await expect(list.handler(consoleRequest())).resolves.toEqual({
      status: 200,
      body: {
        integrations: [{
          provider: 'github',
          status: 'disconnected',
          account_label: null,
          repository_selection: 'unknown',
          permissions: { contents: 'none' },
          sync_directions: [],
          error_reason: null,
          connected_at: null,
          last_sync_at: null,
        }],
      },
    });
  });

  it('preserves configured provider metadata in integration list responses', async () => {
    const module = createIntegrationModule({
      integrationStore: new InMemoryUserIntegrationStore(),
      configuredProviders: [new StaticApiKeyIntegrationProvider(staticApiKeyDescriptorFixture())],
    });
    const list = findRoute(module.routes, LIST_PATH);

    await expect(list.handler(consoleRequest())).resolves.toMatchObject({
      status: 200,
      body: {
        integrations: expect.arrayContaining([{
          provider: 'airtable',
          display_name: 'Airtable',
          category: 'Database',
          status: 'disconnected',
          account_label: null,
          scopes: [],
          error_reason: null,
          connected_at: null,
          last_sync_at: null,
        }]),
      },
    });
  });

  it('registers callback routes only for OAuth providers', () => {
    const oauthProvider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: GMAIL_CLIENT_SECRET,
      ...configuredOAuthNetwork(() => Promise.resolve(new Response('{}', { status: 200 }))),
    });
    const module = createIntegrationModule({
      integrationStore: new InMemoryUserIntegrationStore(),
      configuredProviders: [
        oauthProvider,
        new StaticApiKeyIntegrationProvider(staticApiKeyDescriptorFixture()),
      ],
    });
    const callbackPaths = module.routes
      .filter(route => route.path.endsWith('/callback'))
      .map(route => route.path);

    expect(callbackPaths).toContain(GMAIL_CALLBACK_PATH);
    expect(callbackPaths).not.toContain(`${AIRTABLE_PATH}/callback`);
  });

  it('restarts OAuth initialization on retry while keeping credential writes idempotent', () => {
    const oauthProvider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: GMAIL_CLIENT_SECRET,
      ...configuredOAuthNetwork(() => Promise.resolve(new Response('{}', { status: 200 }))),
    });
    const module = createIntegrationModule({
      integrationStore: new InMemoryUserIntegrationStore(),
      configuredProviders: [
        oauthProvider,
        new StaticApiKeyIntegrationProvider(staticApiKeyDescriptorFixture()),
      ],
    });

    expect(findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST').idempotency).toBe('not_applicable');
    expect(findRoute(module.routes, `${GMAIL_PATH}/connect`, 'POST').idempotency).toBe('not_applicable');
    expect(findRoute(module.routes, `${AIRTABLE_PATH}/connect`, 'POST').idempotency).toBe('required');
    expect(findRoute(module.routes, AIRTABLE_PATH, 'DELETE').idempotency).toBe('required');
  });

  it('rejects configured provider IDs that collide with built-in or configured providers', () => {
    const gmail = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: GMAIL_CLIENT_SECRET,
      ...configuredOAuthNetwork(() => Promise.resolve(new Response('{}', { status: 200 }))),
    });
    const github = new StaticApiKeyIntegrationProvider({
      ...staticApiKeyDescriptorFixture(),
      provider: 'github',
    });

    expect(() => createIntegrationModule({
      integrationStore: new InMemoryUserIntegrationStore(),
      configuredProviders: [github],
    })).toThrow("Integration provider 'github' is registered more than once");
    expect(() => createIntegrationModule({
      integrationStore: new InMemoryUserIntegrationStore(),
      configuredProviders: [gmail, gmail],
    })).toThrow("Integration provider 'gmail' is registered more than once");
  });

  it('fails closed for an unregistered provider id', async () => {
    const service = new IntegrationService({
      store: new InMemoryUserIntegrationStore(),
      providers: IntegrationProviderRegistry.empty(),
    });

    await expect(service.getProvider(
      consoleRequest(),
      'linear' as Parameters<IntegrationService['getProvider']>[1],
    )).resolves.toMatchObject({
      status: 404,
      body: {
        code: 'integration_provider_not_found',
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
      status: 200,
      body: { authorize_url: expect.stringContaining('https://github.example/install?state=') },
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

  it('does not elevate a confusable GitHub contents permission', async () => {
    const { module, provider } = writeModuleFixture();
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');

    await connect.handler(consoleRequest({
      body: { contents_permission: '\uff57rite' },
    }));

    expect(provider.authorizations[0]).toMatchObject({
      contentsPermission: 'read',
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

  it('preserves an active grant when a relink token exchange fails', async () => {
    const provider = new FixtureGitHubIntegrationProvider();
    const { module, store } = writeModuleFixture({ provider });
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);

    const firstStart = await connect.handler(consoleRequest());
    const firstTransactionId = cookieValue(firstStart, CONSOLE_INTEGRATION_STATE_COOKIE);
    const firstState = provider.authorizations[0]?.state;
    if (!firstTransactionId || !firstState) throw new Error(START_TRANSACTION_ERROR);
    await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(firstTransactionId)}` },
      query: { code: PROVIDER_CODE, state: firstState },
    }));
    const original = await store.findByProvider(USER_ID, 'github');
    if (!original) throw new Error('fixture did not create the original integration');

    provider.exchangeFails = true;
    const relinkStart = await connect.handler(consoleRequest());
    const relinkTransactionId = cookieValue(relinkStart, CONSOLE_INTEGRATION_STATE_COOKIE);
    const relinkState = provider.authorizations[1]?.state;
    if (!relinkTransactionId || !relinkState) throw new Error(START_TRANSACTION_ERROR);

    await expect(callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(relinkTransactionId)}` },
      query: { code: PROVIDER_CODE, state: relinkState },
    }))).resolves.toMatchObject({ status: 302 });

    await expect(store.findByProvider(USER_ID, 'github')).resolves.toEqual(original);
  });

  it('returns a retryable conflict when a descriptor changes while authorization starts', async () => {
    const { module, loginTransactions } = writeModuleFixture();
    jest.spyOn(loginTransactions, 'create').mockRejectedValueOnce(
      new IntegrationDescriptorChangedError('integration descriptor changed while starting authorization'),
    );

    await expect(findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST').handler(consoleRequest()))
      .resolves.toMatchObject({
        status: 409,
        body: { code: 'integration_descriptor_changed' },
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
      stateHash: opaqueValues.hashOpaqueValue(`${'github'.length}:github:${state}`),
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
        status: 'cleanup_pending',
        error_reason: 'revocation_failed',
      },
    });
    await expect(store.findByProvider(USER_ID, 'github')).resolves.toBeNull();
    expect(await store.findCredentialCleanupPending(USER_ID, 'github')).toMatchObject({
      status: 'cleanup_pending',
      errorReason: 'revocation_failed',
      accessTokenCiphertext: expect.any(Buffer),
      refreshTokenCiphertext: expect.any(Buffer),
      cleanupAttemptCount: 1,
    });
  });

  it('backs off repeated cleanup failures and completes a later retry', async () => {
    let clock = NOW;
    const provider = new FixtureGitHubIntegrationProvider();
    const { module, store } = writeModuleFixture({ provider, now: () => clock });
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

    await expect(disconnect.handler(consoleRequest())).resolves.toMatchObject({
      body: { status: 'cleanup_pending', error_reason: 'revocation_failed' },
    });
    expect(provider.revocations).toHaveLength(1);
    await expect(disconnect.handler(consoleRequest())).resolves.toMatchObject({
      body: { status: 'cleanup_pending', error_reason: 'revocation_failed' },
    });
    expect(provider.revocations).toHaveLength(1);

    clock = new Date(NOW.getTime() + 1_000);
    provider.revokeFails = false;
    await expect(disconnect.handler(consoleRequest())).resolves.toMatchObject({
      body: { status: 'disconnected', error_reason: null },
    });
    expect(provider.revocations).toHaveLength(2);
    await expect(store.findCredentialCleanupPending(USER_ID, 'github')).resolves.toBeNull();
    await expect(store.hasAnyCredentialMaterial(USER_ID)).resolves.toBe(false);
  });

  it.each([
    { label: 'succeeds', revokeFails: false },
    { label: 'fails', revokeFails: true },
  ])('does not disconnect a replacement grant when remote revocation $label', async ({ revokeFails }) => {
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

    let releaseRevocation!: () => void;
    let markRevocationStarted!: () => void;
    provider.revocationGate = new Promise<void>(resolve => { releaseRevocation = resolve; });
    const revocationStarted = new Promise<void>(resolve => { markRevocationStarted = resolve; });
    provider.onRevocationStarted = markRevocationStarted;
    provider.revokeFails = revokeFails;
    const disconnecting = disconnect.handler(consoleRequest());
    await revocationStarted;

    const replacementInput = {
      userId: USER_ID,
      provider: 'github' as const,
      externalAccountLabel: 'replacement-account',
      externalInstallationId: 'replacement-installation',
      authorizedPermissions: {
        repository_selection: 'all',
        permissions: { contents: 'write' },
      },
      accessTokenCiphertext: Buffer.from('replacement-access-ciphertext'),
      refreshTokenCiphertext: Buffer.from('replacement-refresh-ciphertext'),
      credentialKeyVersion: 'integration-key-v2',
      connectedAt: LAST_SYNC,
    };
    await expect(store.connect(replacementInput)).rejects.toThrow(
      'integration credential cleanup must finish before reconnecting',
    );
    releaseRevocation();

    await expect(disconnecting).resolves.toMatchObject({
      status: 200,
      body: {
        provider: 'github',
        status: revokeFails ? 'cleanup_pending' : 'disconnected',
      },
    });
    if (revokeFails) {
      await expect(store.findCredentialCleanupPending(USER_ID, 'github')).resolves.toMatchObject({
        status: 'cleanup_pending',
      });
    } else {
      const replacement = await store.connect(replacementInput);
      await expect(store.findByProvider(USER_ID, 'github')).resolves.toEqual(replacement);
    }
  });

  it.each([
    {
      label: 'access token',
      record: integrationFixture({
        accessTokenCiphertext: Buffer.from('not-valid-ciphertext'),
        refreshTokenCiphertext: null,
      }),
      secretClass: 'integration_access_token',
    },
    {
      label: 'refresh token',
      record: integrationFixture({
        accessTokenCiphertext: null,
        refreshTokenCiphertext: Buffer.from('not-valid-ciphertext'),
      }),
      secretClass: 'integration_refresh_token',
    },
  ])('reports revocation failure when the $label cannot be decrypted', async ({ record, secretClass }) => {
    const { module, provider, store } = writeModuleFixture({
      records: [record],
    });
    const disconnect = findRoute(module.routes, GITHUB_PATH, 'DELETE');
    const logSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
    try {
      const result = await disconnect.handler(consoleRequest());

      expect(result).toMatchObject({
        status: 200,
        body: {
          provider: 'github',
          status: 'cleanup_pending',
          error_reason: 'revocation_failed',
        },
      });
      expect(provider.revocations).toHaveLength(0);
      await expect(store.findByProvider(USER_ID, 'github')).resolves.toBeNull();
      await expect(store.findCredentialCleanupPending(USER_ID, 'github')).resolves.toMatchObject({
        status: 'cleanup_pending',
        errorReason: 'revocation_failed',
        accessTokenCiphertext: record.accessTokenCiphertext,
        refreshTokenCiphertext: record.refreshTokenCiphertext,
      });
      expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'OPERATION_FAILED',
        severity: 'MEDIUM',
        source: 'IntegrationService',
        details: 'Integration credential decrypt failed',
        additionalData: {
          userId: USER_ID,
          provider: 'github',
          secretClass,
        },
      }));
    } finally {
      logSpy.mockRestore();
    }
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

  it('connects a configured OAuth provider with shared PKCE transaction flow', async () => {
    const fetchCalls: Array<{ readonly url: string; readonly body: string | null }> = [];
    const fetchImpl = (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: url.toString(), body: formBodyString(init?.body) });
      return Promise.resolve(new Response(JSON.stringify({
        access_token: GMAIL_ACCESS_TOKEN,
        refresh_token: GMAIL_REFRESH_TOKEN,
        email: GMAIL_ACCOUNT_LABEL,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    };
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: GMAIL_CLIENT_SECRET,
      ...configuredOAuthNetwork(fetchImpl),
    });
    const store = new InMemoryUserIntegrationStore();
    const loginTransactions = new InMemoryLoginTransactionStore();
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: TEST_ENCRYPTION_KEY_ID,
      key: Buffer.alloc(32, 9),
    });
    const module = createIntegrationModule({
      integrationStore: store,
      loginTransactions,
      opaqueValues,
      secretEncryption,
      configuredProviders: [provider],
      publicBaseUrl: PUBLIC_BASE_URL,
      now: () => NOW,
    });
    const connect = findRoute(module.routes, GMAIL_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GMAIL_CALLBACK_PATH);

    const started = await connect.handler(consoleRequest({
      body: { return_to: SETTINGS_INTEGRATIONS_PATH },
    }));
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const authorizeUrl = new URL(String((started.body as { authorize_url: string }).authorize_url));
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://accounts.example/oauth/authorize');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('gmail-client-id');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${PUBLIC_BASE_URL}${GMAIL_CALLBACK_PATH}`);
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeTruthy();
    const state = authorizeUrl.searchParams.get('state');
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);
    await expect(loginTransactions.findByIdHash(opaqueValues.hashOpaqueValue(transactionId)))
      .resolves.toMatchObject({
        integrationDescriptorId: oauthDescriptorFixture().id,
        integrationDescriptorFingerprint: provider.integrationDescriptorFingerprint,
      });

    const result = await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    expect(result).toEqual({
      status: 302,
      redirectTo: SETTINGS_INTEGRATIONS_PATH,
      cookies: [{ operation: 'clear', name: CONSOLE_INTEGRATION_STATE_COOKIE }],
    });
    expect(fetchCalls[0]?.url).toBe('https://accounts.example/oauth/token');
    expect(fetchCalls[0]?.body).toContain('code_verifier=');
    const stored = await store.findByProvider(USER_ID, 'gmail');
    expect(stored).toMatchObject({
      provider: 'gmail',
      integrationDescriptorId: oauthDescriptorFixture().id,
      externalAccountLabel: GMAIL_ACCOUNT_LABEL,
      authorizedPermissions: { scopes: [GMAIL_READONLY_SCOPE] },
      refreshTokenCiphertext: expect.any(Buffer),
    });
    expect(stored?.accessTokenCiphertext?.toString('utf8')).not.toContain(GMAIL_ACCESS_TOKEN);
    expect(secretEncryption.decrypt(stored?.accessTokenCiphertext ?? Buffer.alloc(0), {
      secretClass: 'integration_access_token',
      ownerId: `gmail:${USER_ID}`,
    }).toString('utf8')).toBe(GMAIL_ACCESS_TOKEN);
    const getGmail = findRoute(module.routes, GMAIL_PATH);
    const status = await getGmail.handler(consoleRequest());
    expect(status).toMatchObject({
      status: 200,
      body: {
        provider: 'gmail',
        display_name: 'Gmail',
        status: 'connected',
        account_label: GMAIL_ACCOUNT_LABEL,
        scopes: [GMAIL_READONLY_SCOPE],
      },
    });
    expect(JSON.stringify(status.body)).not.toContain('token');
    expect(JSON.stringify(status.body)).not.toContain('ciphertext');
  });

  it('binds a configured OAuth transaction to the provider callback route', async () => {
    const fetchImpl = jest.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({
      access_token: 'should-not-be-used',
    }), { status: 200 })));
    const gmail = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: GMAIL_CLIENT_SECRET,
      ...configuredOAuthNetwork(fetchImpl),
    });
    const calendar = new ConfiguredOAuthIntegrationProvider({
      descriptor: calendarDescriptorFixture(),
      clientSecret: 'calendar-client-secret',
      ...configuredOAuthNetwork(fetchImpl),
    });
    const store = new InMemoryUserIntegrationStore();
    const module = createIntegrationModule({
      integrationStore: store,
      loginTransactions: new InMemoryLoginTransactionStore(),
      opaqueValues: new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8)),
      secretEncryption: new AeadSecretEncryptionService({
        keyId: TEST_ENCRYPTION_KEY_ID,
        key: Buffer.alloc(32, 9),
      }),
      configuredProviders: [gmail, calendar],
      publicBaseUrl: PUBLIC_BASE_URL,
      now: () => NOW,
    });
    const connect = findRoute(module.routes, GMAIL_CONNECT_PATH, 'POST');
    const wrongCallback = findRoute(module.routes, CALENDAR_CALLBACK_PATH);
    const started = await connect.handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = new URL(String((started.body as { authorize_url: string }).authorize_url))
      .searchParams.get('state');
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    await expect(wrongCallback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }))).resolves.toMatchObject({ status: 302 });
    await expect(store.findByProvider(USER_ID, 'gmail')).resolves.toBeNull();
    await expect(store.findByProvider(USER_ID, 'calendar')).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a callback when a same-name descriptor replaced the one that started OAuth', async () => {
    const originalFetch = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error(NOT_REACHED_ERROR)));
    const replacementFetch = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error(NOT_REACHED_ERROR)));
    const original = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: ORIGINAL_CLIENT_SECRET,
      ...configuredOAuthNetwork(originalFetch),
    });
    const replacement = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture({ id: '00000000-0000-4000-8000-000000000103' }),
      clientSecret: 'replacement-client-secret',
      ...configuredOAuthNetwork(replacementFetch),
    });
    const store = new InMemoryUserIntegrationStore();
    const loginTransactions = new InMemoryLoginTransactionStore();
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: TEST_ENCRYPTION_KEY_ID,
      key: Buffer.alloc(32, 9),
    });
    const originalModule = createIntegrationModule({
      integrationStore: store,
      loginTransactions,
      opaqueValues,
      secretEncryption,
      configuredProviders: [original],
      publicBaseUrl: PUBLIC_BASE_URL,
      now: () => NOW,
    });
    const securityEventSink = new FixtureIntegrationSecurityEventSink();
    const replacementModule = createIntegrationModule({
      integrationStore: store,
      loginTransactions,
      opaqueValues,
      secretEncryption,
      configuredProviders: [replacement],
      publicBaseUrl: PUBLIC_BASE_URL,
      securityEventSink,
      now: () => NOW,
    });
    const started = await findRoute(originalModule.routes, GMAIL_CONNECT_PATH, 'POST')
      .handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const authorizeUrl = new URL(String((started.body as { authorize_url: string }).authorize_url));
    const state = authorizeUrl.searchParams.get('state');
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    const result = await findRoute(replacementModule.routes, GMAIL_CALLBACK_PATH).handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    expect(result).toMatchObject({ status: 302, redirectTo: LIST_PATH });
    expect(originalFetch).not.toHaveBeenCalled();
    expect(replacementFetch).not.toHaveBeenCalled();
    await expect(store.findByProvider(USER_ID, 'gmail')).resolves.toBeNull();
    expect(securityEventSink.events).toEqual([
      expect.objectContaining({ provider: 'gmail', reason: 'descriptor_mismatch' }),
    ]);
  });

  it('rejects a callback when routing changes on the descriptor that started OAuth', async () => {
    const originalFetch = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error(NOT_REACHED_ERROR)));
    const changedFetch = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error(NOT_REACHED_ERROR)));
    const original = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: ORIGINAL_CLIENT_SECRET,
      ...configuredOAuthNetwork(originalFetch),
    });
    const changed = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture({ apiHosts: ['mail.example.com'] }),
      clientSecret: ORIGINAL_CLIENT_SECRET,
      ...configuredOAuthNetwork(changedFetch),
    });
    const store = new InMemoryUserIntegrationStore();
    const loginTransactions = new InMemoryLoginTransactionStore();
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: TEST_ENCRYPTION_KEY_ID,
      key: Buffer.alloc(32, 9),
    });
    const originalModule = createIntegrationModule({
      integrationStore: store,
      loginTransactions,
      opaqueValues,
      secretEncryption,
      configuredProviders: [original],
      publicBaseUrl: PUBLIC_BASE_URL,
      now: () => NOW,
    });
    const securityEventSink = new FixtureIntegrationSecurityEventSink();
    const changedModule = createIntegrationModule({
      integrationStore: store,
      loginTransactions,
      opaqueValues,
      secretEncryption,
      configuredProviders: [changed],
      publicBaseUrl: PUBLIC_BASE_URL,
      securityEventSink,
      now: () => NOW,
    });
    const started = await findRoute(originalModule.routes, GMAIL_CONNECT_PATH, 'POST')
      .handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const authorizeUrl = new URL(String((started.body as { authorize_url: string }).authorize_url));
    const state = authorizeUrl.searchParams.get('state');
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    const result = await findRoute(changedModule.routes, GMAIL_CALLBACK_PATH).handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    expect(result).toMatchObject({ status: 302, redirectTo: LIST_PATH });
    expect(originalFetch).not.toHaveBeenCalled();
    expect(changedFetch).not.toHaveBeenCalled();
    await expect(store.findByProvider(USER_ID, 'gmail')).resolves.toBeNull();
    expect(securityEventSink.events).toEqual([
      expect.objectContaining({ provider: 'gmail', reason: 'descriptor_mismatch' }),
    ]);
  });

  it('re-resolves a store-backed descriptor after consuming callback state', async () => {
    const originalFetch = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error(NOT_REACHED_ERROR)));
    const changedFetch = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error(NOT_REACHED_ERROR)));
    const original = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: ORIGINAL_CLIENT_SECRET,
      ...configuredOAuthNetwork(originalFetch),
    });
    const changed = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture({ apiHosts: ['mail.example.com'] }),
      clientSecret: ORIGINAL_CLIENT_SECRET,
      ...configuredOAuthNetwork(changedFetch),
    });
    const store = new InMemoryUserIntegrationStore();
    const loginTransactions = new InMemoryLoginTransactionStore();
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: TEST_ENCRYPTION_KEY_ID,
      key: Buffer.alloc(32, 9),
    });
    const securityEventSink = new FixtureIntegrationSecurityEventSink();
    const resolveProvider = jest.fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(changed);
    const service = new IntegrationService({
      store,
      providers: IntegrationProviderRegistry.empty(),
      resolveProvider,
      loginTransactions,
      opaqueValues,
      secretEncryption,
      publicBaseUrl: PUBLIC_BASE_URL,
      securityEventSink,
      now: () => NOW,
    });
    const providerId = 'gmail' as Parameters<IntegrationService['connectProvider']>[1];
    const started = await service.connectProvider(consoleRequest(), providerId);
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const authorizeUrl = new URL(String((started.body as { authorize_url: string }).authorize_url));
    const state = authorizeUrl.searchParams.get('state');
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    const result = await service.completeProviderCallback(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }), providerId);

    expect(result).toMatchObject({ status: 302, redirectTo: LIST_PATH });
    expect(resolveProvider).toHaveBeenCalledTimes(3);
    expect(originalFetch).not.toHaveBeenCalled();
    expect(changedFetch).not.toHaveBeenCalled();
    expect(securityEventSink.events).toEqual([
      expect.objectContaining({ provider: 'gmail', reason: 'descriptor_mismatch' }),
    ]);
  });

  it('does not send an old refresh token to a replacement same-name descriptor', async () => {
    const fetchImpl = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error(NOT_REACHED_ERROR)));
    const replacement = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture({ id: '00000000-0000-4000-8000-000000000103' }),
      clientSecret: 'replacement-client-secret',
      ...configuredOAuthNetwork(fetchImpl),
    });
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: TEST_ENCRYPTION_KEY_ID,
      key: Buffer.alloc(32, 9),
    });
    const staleAccessTokenCiphertext = secretEncryption.encrypt(
      Buffer.from('stale-access-token', 'utf8'),
      { secretClass: 'integration_access_token', ownerId: `gmail:${USER_ID}` },
    );
    const store = new InMemoryUserIntegrationStore();
    await store.connect({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: oauthDescriptorFixture().id,
      externalAccountLabel: GMAIL_ACCOUNT_LABEL,
      externalInstallationId: null,
      authorizedPermissions: { scopes: [GMAIL_READONLY_SCOPE] },
      accessTokenCiphertext: staleAccessTokenCiphertext,
      refreshTokenCiphertext: secretEncryption.encrypt(
        Buffer.from('stale-refresh-token', 'utf8'),
        { secretClass: 'integration_refresh_token', ownerId: `gmail:${USER_ID}` },
      ),
      connectedAt: NOW,
    });
    const service = new IntegrationTokenRefreshService({
      store,
      providers: new IntegrationProviderRegistry([replacement]),
      secretEncryption,
      now: () => NOW,
    });

    await expect(service.refreshOnDemand({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: oauthDescriptorFixture().id,
      staleAccessTokenCiphertext,
    })).resolves.toEqual({ kind: 'missing', record: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('locally disconnects a stale credential without sending it to a replacement descriptor', async () => {
    const replacement = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture({ id: '00000000-0000-4000-8000-000000000103' }),
      clientSecret: 'replacement-client-secret',
      ...configuredOAuthNetwork(() => Promise.reject(new Error(NOT_REACHED_ERROR))),
    });
    const revoke = jest.spyOn(replacement, 'revokeCredentials').mockResolvedValue();
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: TEST_ENCRYPTION_KEY_ID,
      key: Buffer.alloc(32, 9),
    });
    const store = new InMemoryUserIntegrationStore();
    await store.connect({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: oauthDescriptorFixture().id,
      externalAccountLabel: GMAIL_ACCOUNT_LABEL,
      externalInstallationId: null,
      authorizedPermissions: { scopes: [GMAIL_READONLY_SCOPE] },
      accessTokenCiphertext: secretEncryption.encrypt(
        Buffer.from('old-access-token', 'utf8'),
        { secretClass: 'integration_access_token', ownerId: `gmail:${USER_ID}` },
      ),
      refreshTokenCiphertext: null,
      connectedAt: NOW,
    });
    const module = createIntegrationModule({
      integrationStore: store,
      secretEncryption,
      configuredProviders: [replacement],
      now: () => NOW,
    });

    await expect(findRoute(module.routes, GMAIL_PATH).handler(consoleRequest()))
      .resolves.toMatchObject({ body: { status: 'disconnected' } });
    await expect(findRoute(module.routes, GMAIL_PATH, 'DELETE').handler(consoleRequest()))
      .resolves.toMatchObject({ status: 200, body: { status: 'cleanup_pending' } });
    expect(revoke).not.toHaveBeenCalled();
    await expect(store.findByProvider(USER_ID, 'gmail')).resolves.toBeNull();
    await expect(store.findCredentialCleanupPending(USER_ID, 'gmail')).resolves.toMatchObject({
      integrationDescriptorId: oauthDescriptorFixture().id,
      status: 'cleanup_pending',
    });
  });

  it('keeps the descriptor binding when configured-provider revocation fails', async () => {
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: GMAIL_CLIENT_SECRET,
      ...configuredOAuthNetwork(() => Promise.reject(new Error(NOT_REACHED_ERROR))),
    });
    jest.spyOn(provider, 'revokeCredentials').mockRejectedValue(new Error('provider revoke failed'));
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: TEST_ENCRYPTION_KEY_ID,
      key: Buffer.alloc(32, 9),
    });
    const store = new InMemoryUserIntegrationStore();
    await store.connect({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: oauthDescriptorFixture().id,
      externalAccountLabel: GMAIL_ACCOUNT_LABEL,
      externalInstallationId: null,
      authorizedPermissions: { scopes: [GMAIL_READONLY_SCOPE] },
      accessTokenCiphertext: secretEncryption.encrypt(
        Buffer.from('gmail-access-token', 'utf8'),
        { secretClass: 'integration_access_token', ownerId: `gmail:${USER_ID}` },
      ),
      refreshTokenCiphertext: null,
      connectedAt: NOW,
    });
    const module = createIntegrationModule({
      integrationStore: store,
      secretEncryption,
      configuredProviders: [provider],
      now: () => NOW,
    });

    await expect(findRoute(module.routes, GMAIL_PATH, 'DELETE').handler(consoleRequest()))
      .resolves.toMatchObject({
        status: 200,
        body: { status: 'cleanup_pending', error_reason: 'revocation_failed' },
      });
    await expect(store.findByProvider(USER_ID, 'gmail')).resolves.toBeNull();
    await expect(store.findCredentialCleanupPending(USER_ID, 'gmail')).resolves.toMatchObject({
      integrationDescriptorId: oauthDescriptorFixture().id,
      status: 'cleanup_pending',
      errorReason: 'revocation_failed',
    });
  });

  it('revokes exchanged credentials when descriptor-bound persistence fails closed', async () => {
    const fetchImpl = successfulConfiguredOAuthFetch;
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: GMAIL_CLIENT_SECRET,
      ...configuredOAuthNetwork(fetchImpl),
    });
    const revoke = jest.spyOn(provider, 'revokeCredentials').mockResolvedValue();
    const store = new InMemoryUserIntegrationStore();
    jest.spyOn(store, 'connect').mockRejectedValue(new Error('descriptor foreign key rejected'));
    const loginTransactions = new InMemoryLoginTransactionStore();
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
    const securityEventSink = new FixtureIntegrationSecurityEventSink();
    const module = createIntegrationModule({
      integrationStore: store,
      loginTransactions,
      opaqueValues,
      secretEncryption: new AeadSecretEncryptionService({
        keyId: TEST_ENCRYPTION_KEY_ID,
        key: Buffer.alloc(32, 9),
      }),
      configuredProviders: [provider],
      publicBaseUrl: PUBLIC_BASE_URL,
      securityEventSink,
      now: () => NOW,
    });
    const started = await findRoute(module.routes, GMAIL_CONNECT_PATH, 'POST').handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const authorizeUrl = new URL(String((started.body as { authorize_url: string }).authorize_url));
    const state = authorizeUrl.searchParams.get('state');
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    const result = await findRoute(module.routes, GMAIL_CALLBACK_PATH).handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    expect(result).toMatchObject({ status: 302, redirectTo: LIST_PATH });
    expect(revoke).toHaveBeenCalledWith({
      accessToken: GMAIL_ACCESS_TOKEN,
      refreshToken: GMAIL_REFRESH_TOKEN,
      externalInstallationId: null,
    });
    await expect(store.findByProvider(USER_ID, 'gmail')).resolves.toBeNull();
    expect(securityEventSink.events).toEqual([
      expect.objectContaining({ provider: 'gmail', reason: 'credential_persistence_failed' }),
    ]);
  });

  it('revokes exchanged credentials when descriptor rotation invalidates the consumed callback', async () => {
    const fetchImpl = successfulConfiguredOAuthFetch;
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: GMAIL_CLIENT_SECRET,
      ...configuredOAuthNetwork(fetchImpl),
    });
    const revoke = jest.spyOn(provider, 'revokeCredentials').mockResolvedValue();
    const connectDescriptorCallback = jest.fn(() => Promise.resolve(null));
    const store = Object.assign(new InMemoryUserIntegrationStore(), { connectDescriptorCallback });
    const loginTransactions = new InMemoryLoginTransactionStore();
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
    const securityEventSink = new FixtureIntegrationSecurityEventSink();
    const module = createIntegrationModule({
      integrationStore: store,
      loginTransactions,
      opaqueValues,
      secretEncryption: new AeadSecretEncryptionService({
        keyId: TEST_ENCRYPTION_KEY_ID,
        key: Buffer.alloc(32, 9),
      }),
      configuredProviders: [provider],
      publicBaseUrl: PUBLIC_BASE_URL,
      securityEventSink,
      now: () => NOW,
    });
    const started = await findRoute(module.routes, GMAIL_CONNECT_PATH, 'POST').handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const authorizeUrl = new URL(String((started.body as { authorize_url: string }).authorize_url));
    const state = authorizeUrl.searchParams.get('state');
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    const result = await findRoute(module.routes, GMAIL_CALLBACK_PATH).handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    expect(result).toMatchObject({ status: 302, redirectTo: LIST_PATH });
    expect(connectDescriptorCallback).toHaveBeenCalledWith(expect.objectContaining({
      descriptorId: oauthDescriptorFixture().id,
      descriptorFingerprint: provider.integrationDescriptorFingerprint,
    }));
    expect(revoke).toHaveBeenCalledWith({
      accessToken: GMAIL_ACCESS_TOKEN,
      refreshToken: GMAIL_REFRESH_TOKEN,
      externalInstallationId: null,
    });
    await expect(store.findByProvider(USER_ID, 'gmail')).resolves.toBeNull();
    expect(securityEventSink.events).toEqual([
      expect.objectContaining({ provider: 'gmail', reason: 'descriptor_mismatch' }),
    ]);
  });

  it('stores and revokes static API key credentials without OAuth', async () => {
    const provider = new StaticApiKeyIntegrationProvider(staticApiKeyDescriptorFixture());
    const store = new InMemoryUserIntegrationStore();
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: TEST_ENCRYPTION_KEY_ID,
      key: Buffer.alloc(32, 9),
    });
    const module = createIntegrationModule({
      integrationStore: store,
      secretEncryption,
      configuredProviders: [provider],
      now: () => NOW,
    });
    const connect = findRoute(module.routes, AIRTABLE_CONNECT_PATH, 'POST');
    const disconnect = findRoute(module.routes, AIRTABLE_PATH, 'DELETE');

    const connected = await connect.handler(consoleRequest({
      body: {
        api_key: '  airtable-api-key-secret\t',
        account_label: 'Alice Airtable',
      },
    }));

    expect(connected).toMatchObject({
      status: 200,
      body: {
        provider: 'airtable',
        display_name: 'Airtable',
        status: 'connected',
        account_label: 'Alice Airtable',
        scopes: [],
      },
    });
    expect(JSON.stringify(connected.body)).not.toContain('airtable-api-key-secret');
    expect(JSON.stringify(connected.body)).not.toContain('ciphertext');
    const stored = await store.findByProvider(USER_ID, 'airtable');
    expect(stored).toMatchObject({
      provider: 'airtable',
      authorizedPermissions: { scopes: [] },
      refreshTokenCiphertext: null,
    });
    expect(secretEncryption.decrypt(stored?.accessTokenCiphertext ?? Buffer.alloc(0), {
      secretClass: 'integration_access_token',
      ownerId: `airtable:${USER_ID}`,
    }).toString('utf8')).toBe('  airtable-api-key-secret\t');

    const revoked = await disconnect.handler(consoleRequest());

    expect(revoked).toMatchObject({
      status: 200,
      body: {
        provider: 'airtable',
        status: 'disconnected',
        scopes: [],
      },
    });
    await expect(store.findByProvider(USER_ID, 'airtable')).resolves.toBeNull();
  });

  it('rejects malformed static API key account labels before persistence', async () => {
    const store = new InMemoryUserIntegrationStore();
    const module = createIntegrationModule({
      integrationStore: store,
      secretEncryption: new AeadSecretEncryptionService({
        keyId: TEST_ENCRYPTION_KEY_ID,
        key: Buffer.alloc(32, 9),
      }),
      configuredProviders: [new StaticApiKeyIntegrationProvider(staticApiKeyDescriptorFixture())],
      now: () => NOW,
    });

    await expect(findRoute(module.routes, AIRTABLE_CONNECT_PATH, 'POST').handler(consoleRequest({
      body: { api_key: 'valid-secret', account_label: 'invalid\u0000label' },
    }))).resolves.toMatchObject({
      status: 400,
      body: { code: 'invalid_account_label' },
    });
    await expect(store.findByProvider(USER_ID, 'airtable')).resolves.toBeNull();
  });

  it('rejects static credential persistence when the descriptor changes concurrently', async () => {
    const provider = new StaticApiKeyIntegrationProvider(staticApiKeyDescriptorFixture());
    const connectDescriptorCredential = jest.fn(() => Promise.resolve(null));
    const store = Object.assign(new InMemoryUserIntegrationStore(), { connectDescriptorCredential });
    const module = createIntegrationModule({
      integrationStore: store,
      secretEncryption: new AeadSecretEncryptionService({
        keyId: TEST_ENCRYPTION_KEY_ID,
        key: Buffer.alloc(32, 9),
      }),
      configuredProviders: [provider],
      now: () => NOW,
    });

    await expect(findRoute(module.routes, AIRTABLE_CONNECT_PATH, 'POST').handler(consoleRequest({
      body: { api_key: 'airtable-api-key-secret' },
    }))).resolves.toMatchObject({
      status: 409,
      body: { code: 'integration_descriptor_changed' },
    });
    expect(connectDescriptorCredential).toHaveBeenCalledWith(expect.objectContaining({
      descriptorId: staticApiKeyDescriptorFixture().id,
      descriptorFingerprint: provider.integrationDescriptorFingerprint,
    }));
    await expect(store.findByProvider(USER_ID, 'airtable')).resolves.toBeNull();
  });

  it.each([
    ['leading', String.fromCodePoint(0xd800)],
    ['trailing', String.fromCodePoint(0xdc00)],
  ])('rejects a static API key containing a %s lone surrogate', async (_position, malformed) => {
    const store = new InMemoryUserIntegrationStore();
    const module = createIntegrationModule({
      integrationStore: store,
      secretEncryption: new AeadSecretEncryptionService({
        keyId: TEST_ENCRYPTION_KEY_ID,
        key: Buffer.alloc(32, 9),
      }),
      configuredProviders: [new StaticApiKeyIntegrationProvider(staticApiKeyDescriptorFixture())],
      now: () => NOW,
    });
    const connect = findRoute(module.routes, AIRTABLE_CONNECT_PATH, 'POST');

    await expect(connect.handler(consoleRequest({ body: { api_key: `key-${malformed}` } }))).resolves
      .toMatchObject({
        status: 400,
        body: { code: 'invalid_static_api_key' },
      });
    await expect(store.findByProvider(USER_ID, 'airtable')).resolves.toBeNull();
  });

  it('accepts a static API key containing a well-formed surrogate pair', async () => {
    const store = new InMemoryUserIntegrationStore();
    const module = createIntegrationModule({
      integrationStore: store,
      secretEncryption: new AeadSecretEncryptionService({
        keyId: TEST_ENCRYPTION_KEY_ID,
        key: Buffer.alloc(32, 9),
      }),
      configuredProviders: [new StaticApiKeyIntegrationProvider(staticApiKeyDescriptorFixture())],
      now: () => NOW,
    });
    const connect = findRoute(module.routes, AIRTABLE_CONNECT_PATH, 'POST');

    await expect(connect.handler(consoleRequest({
      body: { api_key: `key-${String.fromCodePoint(0x1f600)}` },
    }))).resolves.toMatchObject({ status: 200 });
    await expect(store.findByProvider(USER_ID, 'airtable')).resolves.toMatchObject({
      status: 'connected',
    });
  });

  it('refreshes configured OAuth tokens through store-level single-flight helper', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const fetchCalls: Array<{ readonly url: string; readonly body: string | null }> = [];
    const fetchImpl = (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: url.toString(), body: formBodyString(init?.body) });
      return Promise.resolve(new Response(JSON.stringify({
        access_token: 'gmail-fresh-access-token',
        refresh_token: 'gmail-rotated-refresh-token',
        scope: 'gmail.metadata',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    };
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: GMAIL_CLIENT_SECRET,
      ...configuredOAuthNetwork(fetchImpl),
    });
    const store = new InMemoryUserIntegrationStore();
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: TEST_ENCRYPTION_KEY_ID,
      key: Buffer.alloc(32, 9),
    });
    const staleAccessTokenCiphertext = secretEncryption.encrypt(
      Buffer.from('gmail-stale-access-token', 'utf8'),
      { secretClass: 'integration_access_token', ownerId: `gmail:${USER_ID}` },
    );
    await store.connect({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: oauthDescriptorFixture().id,
      externalAccountLabel: GMAIL_ACCOUNT_LABEL,
      externalInstallationId: null,
      authorizedPermissions: { scopes: [GMAIL_READONLY_SCOPE] },
      accessTokenCiphertext: staleAccessTokenCiphertext,
      refreshTokenCiphertext: secretEncryption.encrypt(
        Buffer.from('gmail-stale-refresh-token', 'utf8'),
        { secretClass: 'integration_refresh_token', ownerId: `gmail:${USER_ID}` },
      ),
      connectedAt: NOW,
    });
    const service = new IntegrationTokenRefreshService({
      store,
      providers: new IntegrationProviderRegistry([provider]),
      secretEncryption,
      now: () => NOW,
    });

    const refreshed = await service.refreshOnDemand({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: oauthDescriptorFixture().id,
      staleAccessTokenCiphertext,
    });

    expect(refreshed).toMatchObject({
      kind: 'refreshed',
      record: {
        provider: 'gmail',
        status: 'connected',
        errorReason: null,
        authorizedPermissions: { scopes: ['gmail.metadata'] },
      },
    });
    expect(fetchCalls[0]?.url).toBe('https://accounts.example/oauth/token');
    expect(fetchCalls[0]?.body).toContain('grant_type=refresh_token');
    const stored = await store.findByProvider(USER_ID, 'gmail');
    expect(secretEncryption.decrypt(stored?.accessTokenCiphertext ?? Buffer.alloc(0), {
      secretClass: 'integration_access_token',
      ownerId: `gmail:${USER_ID}`,
    }).toString('utf8')).toBe('gmail-fresh-access-token');
    expect(secretEncryption.decrypt(stored?.refreshTokenCiphertext ?? Buffer.alloc(0), {
      secretClass: 'integration_refresh_token',
      ownerId: `gmail:${USER_ID}`,
    }).toString('utf8')).toBe('gmail-rotated-refresh-token');
    expect(SecurityMonitor.getRecentEvents()).toContainEqual(expect.objectContaining({
      source: 'IntegrationTokenRefreshService.refreshOnDemand',
      details: expect.stringContaining('refresh refreshed for provider gmail'),
    }));
  });

  it('maps provider refresh failures to a stored token_refresh_failed result', async () => {
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: GMAIL_CLIENT_SECRET,
      ...configuredOAuthNetwork(() => Promise.resolve(new Response('{}', { status: 503 }))),
    });
    const store = new InMemoryUserIntegrationStore();
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: TEST_ENCRYPTION_KEY_ID,
      key: Buffer.alloc(32, 9),
    });
    const staleAccessTokenCiphertext = secretEncryption.encrypt(
      Buffer.from('gmail-stale-access-token', 'utf8'),
      { secretClass: 'integration_access_token', ownerId: `gmail:${USER_ID}` },
    );
    await store.connect({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: oauthDescriptorFixture().id,
      externalAccountLabel: GMAIL_ACCOUNT_LABEL,
      externalInstallationId: null,
      authorizedPermissions: { scopes: [GMAIL_READONLY_SCOPE] },
      accessTokenCiphertext: staleAccessTokenCiphertext,
      refreshTokenCiphertext: secretEncryption.encrypt(
        Buffer.from('gmail-stale-refresh-token', 'utf8'),
        { secretClass: 'integration_refresh_token', ownerId: `gmail:${USER_ID}` },
      ),
      connectedAt: NOW,
    });
    const service = new IntegrationTokenRefreshService({
      store,
      providers: new IntegrationProviderRegistry([provider]),
      secretEncryption,
      now: () => NOW,
    });

    await expect(service.refreshOnDemand({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: oauthDescriptorFixture().id,
      staleAccessTokenCiphertext,
    })).resolves.toMatchObject({
      kind: 'failed',
      record: {
        status: 'error',
        errorReason: 'token_refresh_failed',
        accessTokenCiphertext: staleAccessTokenCiphertext,
      },
    });
  });

  it.each([false, true])(
    'audits store refresh exceptions before propagating (configured provider: %s)',
    async configuredProvider => {
      SecurityMonitor.clearAllEventsForTesting();
      const store = new InMemoryUserIntegrationStore();
      const storeFailure = new Error('database connection included only in the thrown error');
      jest.spyOn(store, 'refresh').mockRejectedValue(storeFailure);
      const secretEncryption = new AeadSecretEncryptionService({
        keyId: TEST_ENCRYPTION_KEY_ID,
        key: Buffer.alloc(32, 9),
      });
      const providers = configuredProvider
        ? [new ConfiguredOAuthIntegrationProvider({
          descriptor: oauthDescriptorFixture(),
          clientSecret: GMAIL_CLIENT_SECRET,
          ...configuredOAuthNetwork(() => Promise.reject(new Error(NOT_REACHED_ERROR))),
        })]
        : [];
      const service = new IntegrationTokenRefreshService({
        store,
        providers: new IntegrationProviderRegistry(providers),
        secretEncryption,
        now: () => NOW,
      });

      await expect(service.refreshOnDemand({
        userId: USER_ID,
        provider: 'gmail',
        integrationDescriptorId: configuredProvider ? oauthDescriptorFixture().id : null,
        staleAccessTokenCiphertext: Buffer.from('stale-token-ciphertext'),
      })).rejects.toBe(storeFailure);

      const events = SecurityMonitor.getRecentEvents().filter(
        event => event.source === 'IntegrationTokenRefreshService.refreshOnDemand',
      );
      expect(events).toEqual([
        expect.objectContaining({
          severity: 'MEDIUM',
          details: 'Integration token refresh failed for provider gmail',
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain(storeFailure.message);
    },
  );
});

function oauthDescriptorFixture(
  overrides: Partial<IntegrationDescriptorRecord> = {},
): IntegrationDescriptorRecord {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    provider: 'gmail',
    ownership: 'curated',
    ownerUserId: null,
    displayName: 'Gmail',
    category: 'Email',
    authStrategy: 'oauth2_authorization_code',
    apiHosts: ['gmail.googleapis.com'],
    oauth: {
      clientId: 'gmail-client-id',
      authorizationUrl: 'https://accounts.example/oauth/authorize',
      tokenUrl: 'https://accounts.example/oauth/token',
      scopes: [GMAIL_READONLY_SCOPE],
      pkce: 'required',
      refresh: 'rotating',
      tokenExchange: { style: 'form', clientAuth: 'body' },
      accountLabel: { field: 'email' },
    },
    staticApiKey: null,
    clientSecretCiphertext: Buffer.from('encrypted-client-secret'),
    clientSecretRevision: '00000000-0000-4000-8000-000000000201',
    credentialKeyVersion: 'integration-key-v1',
    operationPromotion: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function staticApiKeyDescriptorFixture(): IntegrationDescriptorRecord {
  return {
    id: '00000000-0000-4000-8000-000000000102',
    provider: 'airtable',
    ownership: 'curated',
    ownerUserId: null,
    displayName: 'Airtable',
    category: 'Database',
    authStrategy: 'static_api_key',
    apiHosts: ['api.airtable.com'],
    oauth: null,
    staticApiKey: {
      injection: {
        location: 'header',
        name: 'Authorization',
        valuePrefix: 'Bearer ',
      },
    },
    clientSecretCiphertext: null,
    clientSecretRevision: null,
    credentialKeyVersion: null,
    operationPromotion: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function calendarDescriptorFixture(): IntegrationDescriptorRecord {
  const base = oauthDescriptorFixture();
  return {
    ...base,
    id: '00000000-0000-4000-8000-000000000103',
    provider: 'calendar',
    displayName: 'Calendar',
    apiHosts: ['calendar.googleapis.com'],
  };
}

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
  revocationGate: Promise<void> | null = null;
  onRevocationStarted: (() => void) | null = null;

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

  async revokeCredentials(request: Parameters<IGitHubIntegrationProvider['revokeCredentials']>[0]): Promise<void> {
    this.revocations.push(request);
    this.onRevocationStarted?.();
    if (this.revocationGate) await this.revocationGate;
    if (this.revokeFails) throw new Error('provider revoke failed');
  }
}

class FixtureIntegrationSecurityEventSink implements IIntegrationSecurityEventSink {
  readonly events: IntegrationCallbackRejectedEvent[] = [];

  async recordIntegrationCallbackRejected(event: IntegrationCallbackRejectedEvent): Promise<void> {
    await Promise.resolve();
    this.events.push(event);
  }
}
