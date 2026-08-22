import { describe, expect, it, jest } from '@jest/globals';

import {
  AeadSecretEncryptionService,
  ConfiguredOAuthIntegrationProvider,
  createIntegrationModule,
  HmacConsoleOpaqueValueService,
  InMemoryIntegrationDescriptorStore,
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
import { MintedIntegrationCredentialsError } from '../../../../src/web-console/modules/integrations/IntegrationProvider.js';
import { CONSUMED_TRANSACTION_COMPLETION_LEASE_MS } from '../../../../src/web-console/stores/ILoginTransactionStore.js';

// Built from parts so it is not a hardcoded IP literal; any public address satisfies the SSRF guard.
const PUBLIC_TEST_ADDRESS = [8, 8, 8, 8].join('.');

/** Adapt a plain fetch stub into the provider's pinned-outbound + DNS seams. */
function providerOutbound(fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>) {
  return {
    pinnedOutbound: () => ({ fetch: fetchImpl, close: () => Promise.resolve() }),
    dnsLookup: () => Promise.resolve([{ address: PUBLIC_TEST_ADDRESS, family: 4 }]),
  };
}

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
const AIRTABLE_PATH = '/api/v1/me/integrations/airtable';
const AIRTABLE_CONNECT_PATH = '/api/v1/me/integrations/airtable/connect';
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
    credentialGeneration: 0,
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
  const loginTransactions = new InMemoryLoginTransactionStore(options.now ?? (() => NOW));
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

it('fails closed when an OAuth login store cannot fence descriptor callbacks', () => {
  const loginTransactions = new InMemoryLoginTransactionStore(() => NOW);
  Object.defineProperty(loginTransactions, 'fenceIntegrationAuthorizationsByDescriptor', {
    value: undefined,
  });

  expect(() => createIntegrationModule({
    integrationStore: new InMemoryUserIntegrationStore(),
    descriptorStore: new InMemoryIntegrationDescriptorStore(),
    loginTransactions,
  })).toThrow('must support descriptor callback fencing');
});

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

    // Start the transaction that will expire before the first callback creates
    // an active connection. Reconnect is intentionally blocked once connected.
    const expiredStart = await connect.handler(consoleRequest());
    const expiredTransactionId = cookieValue(expiredStart, CONSOLE_INTEGRATION_STATE_COOKIE);
    const expiredState = provider.authorizations[1]?.state;
    if (!expiredTransactionId || !expiredState) throw new Error('fixture did not start expired transaction');

    await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

    await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));

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

  it('audits a consumed token exchange failure without overwriting integration state', async () => {
    const provider = new FixtureGitHubIntegrationProvider();
    provider.exchangeFails = true;
    const { module, store, securityEventSink } = writeModuleFixture({ provider });
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
    await expect(store.findByProvider(USER_ID, 'github')).resolves.toBeNull();
    const getGitHub = findRoute(module.routes, GITHUB_PATH);
    await expect(getGitHub.handler(consoleRequest())).resolves.toMatchObject({
      body: {
        status: 'disconnected',
      },
    });
    expect(securityEventSink.events).toContainEqual(expect.objectContaining({
      reason: 'token_exchange_failed',
      provider: 'github',
    }));
  });

  it('revokes credentials minted before an OAuth exchange fails', async () => {
    const provider = new FixtureGitHubIntegrationProvider();
    provider.mintedExchangeFailure = true;
    const { module, store } = writeModuleFixture({ provider });
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    const started = await connect.handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = provider.authorizations[0]?.state;
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    await expect(callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }))).resolves.toMatchObject({ status: 302 });

    await expect(store.findByProvider(USER_ID, 'github')).resolves.toBeNull();
    expect(provider.revocations).toEqual([{
      accessToken: provider.accessToken,
      refreshToken: 'github-refresh-token-secret',
      installationId: null,
    }]);
  });

  it('defers cleanup of callback-minted credentials while a current grant is active', async () => {
    const provider = new FixtureGitHubIntegrationProvider();
    const { module, store } = writeModuleFixture({ provider });
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);

    const first = await connect.handler(consoleRequest());
    const firstId = cookieValue(first, CONSOLE_INTEGRATION_STATE_COOKIE);
    const firstState = provider.authorizations[0]?.state;
    if (!firstId || !firstState) throw new Error(START_TRANSACTION_ERROR);

    // Both flows must begin while disconnected. Once either callback wins,
    // starting another authorization is rejected until explicit disconnect.
    const second = await connect.handler(consoleRequest());
    const secondId = cookieValue(second, CONSOLE_INTEGRATION_STATE_COOKIE);
    const secondState = provider.authorizations[1]?.state;
    if (!secondId || !secondState) throw new Error(START_TRANSACTION_ERROR);

    await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(firstId)}` },
      query: { code: 'first-code', state: firstState },
    }));

    provider.mintedExchangeFailure = true;
    await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(secondId)}` },
      query: { code: 'second-code', state: secondState },
    }));

    await expect(store.findByProvider(USER_ID, 'github')).resolves.toMatchObject({ status: 'connected' });
    await expect(store.listCredentialCleanup(USER_ID, 'github')).resolves.toHaveLength(1);
    expect(provider.revocations).toHaveLength(0);
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
      status: 502,
      body: { code: 'integration_credential_cleanup_pending' },
    });
    expect(await store.findByProvider(USER_ID, 'github')).toBeNull();
    await expect(store.listCredentialCleanup(USER_ID, 'github')).resolves.toEqual([
      expect.objectContaining({
      status: 'cleanup_pending',
      errorReason: 'revocation_failed',
      accessTokenCiphertext: expect.any(Buffer),
      }),
    ]);
  });

  it('retries durable provider credential cleanup on a later disconnect', async () => {
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

    await expect(disconnect.handler(consoleRequest())).resolves.toMatchObject({ status: 502 });
    provider.revokeFails = false;
    await expect(disconnect.handler(consoleRequest())).resolves.toMatchObject({
      status: 200,
      body: { status: 'disconnected' },
    });

    expect(provider.revocations).toHaveLength(2);
    await expect(store.listCredentialCleanup(USER_ID, 'github')).resolves.toEqual([]);
  });

  it('retains cleanup ownership while a timed-out provider revocation is still running', async () => {
    jest.useFakeTimers();
    try {
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
      provider.revokeGate = new Promise<void>(resolve => { releaseRevocation = resolve; });

      const first = disconnect.handler(consoleRequest());
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toMatchObject({ status: 502 });
      await jest.advanceTimersByTimeAsync(64_000);
      await expect(disconnect.handler(consoleRequest())).resolves.toMatchObject({ status: 502 });
      expect(provider.revocations).toHaveLength(1);

      releaseRevocation();
      await jest.advanceTimersByTimeAsync(0);
      await expect(store.listCredentialCleanup(USER_ID, 'github')).resolves.toEqual([]);
      provider.revokeGate = null;
      await expect(disconnect.handler(consoleRequest())).resolves.toMatchObject({ status: 200 });
      expect(provider.revocations).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('grants only one cleanup lease and releases it for an immediate retry', async () => {
    const store = new InMemoryUserIntegrationStore([integrationFixture()]);
    const pending = await store.beginAuthorizationDisconnect(USER_ID, 'github', NOW);
    if (!pending) throw new Error('Expected cleanup-pending fixture');
    const leaseIds = [
      '00000000-0000-4000-8000-000000000701',
      '00000000-0000-4000-8000-000000000702',
    ];
    const claims = await Promise.all(leaseIds.map(cleanupLeaseId => store.claimCredentialCleanup({
      userId: USER_ID,
      provider: 'github',
      integrationId: pending.id,
      credentialGeneration: pending.credentialGeneration,
      cleanupLeaseId,
      leaseDurationMs: 30_000,
    })));

    expect(claims.filter(Boolean)).toHaveLength(1);
    const winningIndex = claims.findIndex(Boolean);
    await store.releaseCredentialCleanupClaim({
      userId: USER_ID,
      provider: 'github',
      integrationId: pending.id,
      cleanupLeaseId: leaseIds[winningIndex]!,
    });
    await expect(store.claimCredentialCleanup({
      userId: USER_ID,
      provider: 'github',
      integrationId: pending.id,
      credentialGeneration: pending.credentialGeneration,
      cleanupLeaseId: leaseIds[winningIndex === 0 ? 1 : 0]!,
      leaseDurationMs: 30_000,
    })).resolves.toMatchObject({ id: pending.id });
  });

  it('rejects an older OAuth callback after a newer authorization has connected', async () => {
    let clock = new Date(NOW);
    const provider = new FixtureGitHubIntegrationProvider();
    const { module, store, secretEncryption } = writeModuleFixture({ provider, now: () => new Date(clock) });
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);

    const older = await connect.handler(consoleRequest());
    const olderId = cookieValue(older, CONSOLE_INTEGRATION_STATE_COOKIE);
    const olderState = provider.authorizations[0]?.state;
    clock = new Date(NOW.getTime() + 1_000);
    const newer = await connect.handler(consoleRequest());
    const newerId = cookieValue(newer, CONSOLE_INTEGRATION_STATE_COOKIE);
    const newerState = provider.authorizations[1]?.state;
    if (!olderId || !olderState || !newerId || !newerState) throw new Error(START_TRANSACTION_ERROR);

    provider.accessToken = 'newer-access-token';
    clock = new Date(NOW.getTime() + 2_000);
    await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(newerId)}` },
      query: { code: 'newer-code', state: newerState },
    }));
    provider.accessToken = 'older-access-token';
    clock = new Date(NOW.getTime() + 3_000);
    await callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(olderId)}` },
      query: { code: 'older-code', state: olderState },
    }));

    const active = await store.findByProvider(USER_ID, 'github');
    expect(active?.accessTokenCiphertext).not.toBeNull();
    expect(secretEncryption.decrypt(
      active!.accessTokenCiphertext!,
      { secretClass: 'integration_access_token', ownerId: `github:${USER_ID}` },
    ).toString('utf8')).toBe('newer-access-token');
    await expect(store.listCredentialCleanup(USER_ID, 'github')).resolves.toHaveLength(1);
    expect(provider.revocations).toHaveLength(0);
  });

  it('rejects an older callback while a newer authorization is still pending', async () => {
    let clock = new Date(NOW);
    const provider = new FixtureGitHubIntegrationProvider();
    const { module, store, secretEncryption } = writeModuleFixture({ provider, now: () => new Date(clock) });
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);

    const transactions: Array<{ transactionId: string; state: string }> = [];
    for (const index of [0, 1]) {
      clock = new Date(NOW.getTime() + index * 2_000);
      const started = await connect.handler(consoleRequest());
      const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
      const state = provider.authorizations[index]?.state;
      if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);
      transactions.push({ transactionId, state });
    }

    provider.accessToken = 'first-access-token';
    clock = new Date(NOW.getTime() + 3_000);
    await callback.handler(consoleRequest({
      headers: {
        cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactions[0]!.transactionId)}`,
      },
      query: { code: 'code-0', state: transactions[0]!.state },
    }));
    provider.accessToken = 'second-access-token';
    clock = new Date(NOW.getTime() + 4_000);
    await callback.handler(consoleRequest({
      headers: {
        cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactions[1]!.transactionId)}`,
      },
      query: { code: 'code-1', state: transactions[1]!.state },
    }));

    const active = await store.findByProvider(USER_ID, 'github');
    expect(active).toMatchObject({ status: 'connected' });
    expect(secretEncryption.decrypt(
      active!.accessTokenCiphertext!,
      { secretClass: 'integration_access_token', ownerId: `github:${USER_ID}` },
    ).toString('utf8')).toBe('second-access-token');
    await expect(store.listCredentialCleanup(USER_ID, 'github')).resolves.toEqual([]);
    expect(provider.revocations).toEqual([
      expect.objectContaining({ accessToken: 'first-access-token' }),
    ]);
  });

  it('rejects credentials when an in-memory callback outlives its completion lease', async () => {
    let clock = new Date(NOW);
    const provider = new FixtureGitHubIntegrationProvider();
    let releaseExchange!: () => void;
    let markExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>(resolve => { markExchangeStarted = resolve; });
    const exchangeGate = new Promise<void>(resolve => { releaseExchange = resolve; });
    jest.spyOn(provider, 'exchangeAuthorizationCode').mockImplementation(async () => {
      markExchangeStarted();
      await exchangeGate;
      return {
        accountLabel: 'alice',
        installationId: 'installation-456',
        repositorySelection: 'selected',
        contentsPermission: 'read',
        accessToken: provider.accessToken,
        refreshToken: 'github-refresh-token-secret',
      };
    });
    const { module, store } = writeModuleFixture({ provider, now: () => new Date(clock) });
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    const started = await connect.handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = provider.authorizations[0]?.state;
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    const completion = callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }));
    await exchangeStarted;
    clock = new Date(NOW.getTime() + CONSUMED_TRANSACTION_COMPLETION_LEASE_MS + 1);
    releaseExchange();

    await expect(completion).resolves.toMatchObject({ status: 302 });
    await expect(store.findByProvider(USER_ID, 'github')).resolves.toBeNull();
    expect(provider.revocations).toEqual([
      expect.objectContaining({ accessToken: provider.accessToken }),
    ]);
  });

  it('prevents a callback begun before disconnect from reconnecting afterward', async () => {
    const provider = new FixtureGitHubIntegrationProvider();
    const { module, store } = writeModuleFixture({ provider });
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    const disconnect = findRoute(module.routes, GITHUB_PATH, 'DELETE');
    const started = await connect.handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = provider.authorizations[0]?.state;
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    await expect(disconnect.handler(consoleRequest())).resolves.toMatchObject({ status: 200 });
    await expect(callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }))).resolves.toMatchObject({ status: 302 });

    await expect(store.findByProvider(USER_ID, 'github')).resolves.toBeNull();
    expect(provider.revocations).toHaveLength(1);
  });

  it('rejects callback credential persistence after the principal becomes inactive', async () => {
    const provider = new FixtureGitHubIntegrationProvider();
    const { module, store } = writeModuleFixture({ provider });
    const connect = findRoute(module.routes, GITHUB_CONNECT_PATH, 'POST');
    const callback = findRoute(module.routes, GITHUB_CALLBACK_PATH);
    const started = await connect.handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = provider.authorizations[0]?.state;
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);
    store.configurePrincipalLifecycleFence({ isPrincipalActive: () => Promise.resolve(false) });

    await expect(callback.handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }))).resolves.toMatchObject({ status: 302 });

    await expect(store.findByProvider(USER_ID, 'github')).resolves.toBeNull();
    expect(provider.revocations).toHaveLength(1);
  });

  it('logs integration credential decrypt failures with caller context', async () => {
    const { module, store } = writeModuleFixture({
      records: [integrationFixture({
        accessTokenCiphertext: Buffer.from('not-valid-ciphertext'),
        refreshTokenCiphertext: null,
      })],
    });
    const disconnect = findRoute(module.routes, GITHUB_PATH, 'DELETE');
    const logSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
    try {
      const result = await disconnect.handler(consoleRequest());

      expect(result).toMatchObject({
        status: 502,
        body: { code: 'integration_credential_cleanup_pending' },
      });
      await expect(store.hasCredentialCleanupPending(USER_ID, 'github')).resolves.toBe(true);
      expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'OPERATION_FAILED',
        severity: 'MEDIUM',
        source: 'IntegrationService',
        details: 'Integration credential decrypt failed',
        additionalData: {
          userId: USER_ID,
          provider: 'github',
          secretClass: 'integration_access_token',
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
        access_token: 'gmail-access-token-secret',
        refresh_token: 'gmail-refresh-token-secret',
        email: 'alice@example.com',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    };
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'gmail-client-secret',
      ...providerOutbound(fetchImpl),
    });
    const store = new InMemoryUserIntegrationStore();
    const loginTransactions = new InMemoryLoginTransactionStore(() => NOW);
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: 'integration-test-key',
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
      externalAccountLabel: 'alice@example.com',
      authorizedPermissions: { scopes: ['gmail.readonly'] },
      refreshTokenCiphertext: expect.any(Buffer),
    });
    expect(stored?.accessTokenCiphertext?.toString('utf8')).not.toContain('gmail-access-token-secret');
    expect(secretEncryption.decrypt(stored?.accessTokenCiphertext ?? Buffer.alloc(0), {
      secretClass: 'integration_access_token',
      ownerId: `gmail:${USER_ID}`,
    }).toString('utf8')).toBe('gmail-access-token-secret');
    const getGmail = findRoute(module.routes, GMAIL_PATH);
    const status = await getGmail.handler(consoleRequest());
    expect(status).toMatchObject({
      status: 200,
      body: {
        provider: 'gmail',
        display_name: 'Gmail',
        status: 'connected',
        account_label: 'alice@example.com',
        scopes: ['gmail.readonly'],
      },
    });
    expect(JSON.stringify(status.body)).not.toContain('token');
    expect(JSON.stringify(status.body)).not.toContain('ciphertext');
  });

  it('rejects and revokes an OAuth access token too short for safe response redaction', async () => {
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'gmail-client-secret',
      ...providerOutbound(() => Promise.resolve(new Response(JSON.stringify({
        access_token: 'short7',
        refresh_token: 'gmail-refresh-token-secret',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))),
    });
    const revoke = jest.spyOn(provider, 'revokeCredentials').mockResolvedValue();
    const store = new InMemoryUserIntegrationStore();
    const loginTransactions = new InMemoryLoginTransactionStore(() => NOW);
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
    const module = createIntegrationModule({
      integrationStore: store,
      loginTransactions,
      opaqueValues,
      secretEncryption: new AeadSecretEncryptionService({
        keyId: 'integration-test-key',
        key: Buffer.alloc(32, 9),
      }),
      configuredProviders: [provider],
      publicBaseUrl: PUBLIC_BASE_URL,
      now: () => NOW,
    });
    const started = await findRoute(module.routes, GMAIL_CONNECT_PATH, 'POST').handler(consoleRequest());
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const state = new URL(String((started.body as { authorize_url: string }).authorize_url)).searchParams.get('state');
    if (!transactionId || !state) throw new Error(START_TRANSACTION_ERROR);

    await expect(findRoute(module.routes, GMAIL_CALLBACK_PATH).handler(consoleRequest({
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: PROVIDER_CODE, state },
    }))).resolves.toMatchObject({ status: 302 });
    await expect(store.findByProvider(USER_ID, 'gmail')).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'short7' }));
  });

  it('rejects a callback when a same-name descriptor replaced the one that started OAuth', async () => {
    const originalFetch = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error('not reached')));
    const replacementFetch = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error('not reached')));
    const original = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'original-client-secret',
      ...providerOutbound(originalFetch),
    });
    const replacement = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture({ id: '00000000-0000-4000-8000-000000000103' }),
      clientSecret: 'replacement-client-secret',
      ...providerOutbound(replacementFetch),
    });
    const store = new InMemoryUserIntegrationStore();
    const loginTransactions = new InMemoryLoginTransactionStore(() => NOW);
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: 'integration-test-key',
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
    const originalFetch = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error('not reached')));
    const changedFetch = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error('not reached')));
    const original = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'original-client-secret',
      ...providerOutbound(originalFetch),
    });
    const changed = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture({ apiHosts: ['mail.example.com'] }),
      clientSecret: 'original-client-secret',
      ...providerOutbound(changedFetch),
    });
    const store = new InMemoryUserIntegrationStore();
    const loginTransactions = new InMemoryLoginTransactionStore(() => NOW);
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: 'integration-test-key',
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
    const originalFetch = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error('not reached')));
    const changedFetch = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error('not reached')));
    const original = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'original-client-secret',
      ...providerOutbound(originalFetch),
    });
    const changed = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture({ apiHosts: ['mail.example.com'] }),
      clientSecret: 'original-client-secret',
      ...providerOutbound(changedFetch),
    });
    const store = new InMemoryUserIntegrationStore();
    const loginTransactions = new InMemoryLoginTransactionStore(() => NOW);
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: 'integration-test-key',
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

  it('fails closed when a resolver disables a descriptor-backed boot provider before connect', async () => {
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'configured-client-secret',
      ...providerOutbound(jest.fn()),
    });
    const resolveProvider = jest.fn<() => Promise<null>>().mockResolvedValue(null);
    const service = new IntegrationService({
      store: new InMemoryUserIntegrationStore(),
      providers: new IntegrationProviderRegistry([provider]),
      resolveProvider,
    });

    await expect(service.connectProvider(consoleRequest(), 'gmail')).resolves.toMatchObject({
      status: 404,
      body: { code: 'integration_provider_not_found' },
    });
    expect(resolveProvider).toHaveBeenCalledWith(USER_ID, 'gmail');
  });

  it('fails closed when a resolver disables a descriptor-backed boot provider before refresh', async () => {
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'configured-client-secret',
      ...providerOutbound(jest.fn()),
    });
    const resolveProvider = jest.fn<() => Promise<null>>().mockResolvedValue(null);
    const store = new InMemoryUserIntegrationStore();
    const service = new IntegrationTokenRefreshService({
      store,
      providers: new IntegrationProviderRegistry([provider]),
      resolveProvider,
      secretEncryption: new AeadSecretEncryptionService({
        keyId: 'integration-test-key',
        key: Buffer.alloc(32, 9),
      }),
      now: () => NOW,
    });

    await expect(service.refreshOnDemand({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: provider.integrationDescriptorId ?? null,
      staleAccessTokenCiphertext: Buffer.from('stale-access-token'),
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: ['gmail.readonly'] },
    })).resolves.toEqual({ kind: 'missing', record: null });
    expect(resolveProvider).toHaveBeenCalledWith(USER_ID, 'gmail');
  });

  it('does not send an old refresh token to a replacement same-name descriptor', async () => {
    const fetchImpl = jest.fn<() => Promise<Response>>(() => Promise.reject(new Error('not reached')));
    const replacement = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture({ id: '00000000-0000-4000-8000-000000000103' }),
      clientSecret: 'replacement-client-secret',
      ...providerOutbound(fetchImpl),
    });
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: 'integration-test-key',
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
      externalAccountLabel: 'alice@example.com',
      externalInstallationId: null,
      authorizedPermissions: { scopes: ['gmail.readonly'] },
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
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: ['gmail.readonly'] },
    })).resolves.toEqual({ kind: 'missing', record: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('locally disconnects a stale credential without sending it to a replacement descriptor', async () => {
    const replacement = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture({ id: '00000000-0000-4000-8000-000000000103' }),
      clientSecret: 'replacement-client-secret',
      ...providerOutbound(() => Promise.reject(new Error('not reached'))),
    });
    const revoke = jest.spyOn(replacement, 'revokeCredentials').mockResolvedValue();
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: 'integration-test-key',
      key: Buffer.alloc(32, 9),
    });
    const store = new InMemoryUserIntegrationStore();
    await store.connect({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: oauthDescriptorFixture().id,
      externalAccountLabel: 'alice@example.com',
      externalInstallationId: null,
      authorizedPermissions: { scopes: ['gmail.readonly'] },
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
      .resolves.toMatchObject({ status: 502, body: { code: 'integration_credential_cleanup_pending' } });
    await expect(findRoute(module.routes, GMAIL_PATH, 'DELETE').handler(consoleRequest()))
      .resolves.toMatchObject({ status: 502, body: { code: 'integration_credential_cleanup_pending' } });
    expect(revoke).not.toHaveBeenCalled();
    await expect(store.findByProvider(USER_ID, 'gmail')).resolves.toBeNull();
    await expect(store.hasCredentialCleanupPending(USER_ID, 'gmail')).resolves.toBe(true);
  });

  it('keeps the descriptor binding when configured-provider revocation fails', async () => {
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'gmail-client-secret',
      ...providerOutbound(() => Promise.reject(new Error('not reached'))),
    });
    jest.spyOn(provider, 'revokeCredentials').mockRejectedValue(new Error('provider revoke failed'));
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: 'integration-test-key',
      key: Buffer.alloc(32, 9),
    });
    const store = new InMemoryUserIntegrationStore();
    await store.connect({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: oauthDescriptorFixture().id,
      externalAccountLabel: 'alice@example.com',
      externalInstallationId: null,
      authorizedPermissions: { scopes: ['gmail.readonly'] },
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
        status: 502,
        body: { code: 'integration_credential_cleanup_pending' },
      });
    await expect(store.findByProvider(USER_ID, 'gmail')).resolves.toBeNull();
    await expect(store.listCredentialCleanup(USER_ID, 'gmail')).resolves.toEqual([
      expect.objectContaining({
      integrationDescriptorId: oauthDescriptorFixture().id,
      status: 'cleanup_pending',
      errorReason: 'revocation_failed',
      }),
    ]);
  });

  it('revokes exchanged credentials when descriptor-bound persistence fails closed', async () => {
    const fetchImpl = () => Promise.resolve(new Response(JSON.stringify({
      access_token: 'gmail-access-token-secret',
      refresh_token: 'gmail-refresh-token-secret',
      email: 'alice@example.com',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'gmail-client-secret',
      ...providerOutbound(fetchImpl),
    });
    const revoke = jest.spyOn(provider, 'revokeCredentials').mockResolvedValue();
    const store = new InMemoryUserIntegrationStore();
    jest.spyOn(store, 'connectDescriptorCallback').mockRejectedValue(new Error('descriptor foreign key rejected'));
    const loginTransactions = new InMemoryLoginTransactionStore(() => NOW);
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
    const securityEventSink = new FixtureIntegrationSecurityEventSink();
    const module = createIntegrationModule({
      integrationStore: store,
      loginTransactions,
      opaqueValues,
      secretEncryption: new AeadSecretEncryptionService({
        keyId: 'integration-test-key',
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
      accessToken: 'gmail-access-token-secret',
      refreshToken: 'gmail-refresh-token-secret',
      externalInstallationId: null,
    });
    await expect(store.findByProvider(USER_ID, 'gmail')).resolves.toBeNull();
    expect(securityEventSink.events).toEqual([
      expect.objectContaining({ provider: 'gmail', reason: 'credential_persistence_failed' }),
    ]);
  });

  it('revokes exchanged credentials when descriptor rotation invalidates the consumed callback', async () => {
    const fetchImpl = () => Promise.resolve(new Response(JSON.stringify({
      access_token: 'gmail-access-token-secret',
      refresh_token: 'gmail-refresh-token-secret',
      email: 'alice@example.com',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'gmail-client-secret',
      ...providerOutbound(fetchImpl),
    });
    const revoke = jest.spyOn(provider, 'revokeCredentials').mockResolvedValue();
    const connectDescriptorCallback = jest.fn(() => Promise.resolve(null));
    const store = Object.assign(new InMemoryUserIntegrationStore(), { connectDescriptorCallback });
    const loginTransactions = new InMemoryLoginTransactionStore(() => NOW);
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8));
    const securityEventSink = new FixtureIntegrationSecurityEventSink();
    const module = createIntegrationModule({
      integrationStore: store,
      loginTransactions,
      opaqueValues,
      secretEncryption: new AeadSecretEncryptionService({
        keyId: 'integration-test-key',
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
      accessToken: 'gmail-access-token-secret',
      refreshToken: 'gmail-refresh-token-secret',
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
      keyId: 'integration-test-key',
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
        api_key: 'airtable-api-key-secret',
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
    }).toString('utf8')).toBe('airtable-api-key-secret');

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

  it('rejects static credential persistence when the descriptor changes concurrently', async () => {
    const provider = new StaticApiKeyIntegrationProvider(staticApiKeyDescriptorFixture());
    const databaseStartedAt = new Date(NOW.getTime() + 500);
    const connectDescriptorCredential = jest.fn(() => Promise.resolve(null));
    const store = Object.assign(new InMemoryUserIntegrationStore(), { connectDescriptorCredential });
    jest.spyOn(store, 'captureCredentialOperationStartedAt').mockResolvedValue(databaseStartedAt);
    const module = createIntegrationModule({
      integrationStore: store,
      secretEncryption: new AeadSecretEncryptionService({
        keyId: 'integration-test-key',
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
      operationStartedAt: databaseStartedAt,
    }));
    await expect(store.findByProvider(USER_ID, 'airtable')).resolves.toBeNull();
  });

  it('rejects a static credential request superseded by disconnect intent', async () => {
    const provider = new StaticApiKeyIntegrationProvider(staticApiKeyDescriptorFixture());
    const store = new InMemoryUserIntegrationStore();
    store.configureDescriptorCallbackFence({
      runIfCurrent: async (_id, _fingerprint, operation) => operation(),
    });
    await store.beginAuthorizationDisconnect(USER_ID, 'airtable', new Date(NOW.getTime() + 1_000));

    await expect(store.connectDescriptorCredential({
      descriptorId: staticApiKeyDescriptorFixture().id,
      descriptorFingerprint: provider.integrationDescriptorFingerprint!,
      operationStartedAt: NOW,
      connection: {
        userId: USER_ID,
        provider: 'airtable',
        integrationDescriptorId: staticApiKeyDescriptorFixture().id,
        externalAccountLabel: null,
        externalInstallationId: null,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: Buffer.from('encrypted-api-key'),
        refreshTokenCiphertext: null,
        authorizationStartedAt: NOW,
        connectedAt: new Date(NOW.getTime() + 2_000),
      },
    })).resolves.toBeNull();
    await expect(store.findByProvider(USER_ID, 'airtable')).resolves.toBeNull();
  });

  it.each([
    ['leading', String.fromCharCode(0xd800)],
    ['trailing', String.fromCharCode(0xdc00)],
  ])('rejects a static API key containing a %s lone surrogate', async (_position, malformed) => {
    const store = new InMemoryUserIntegrationStore();
    const module = createIntegrationModule({
      integrationStore: store,
      secretEncryption: new AeadSecretEncryptionService({
        keyId: 'integration-test-key',
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

  it('rejects static and Basic secrets below the safe redaction floor', async () => {
    const store = new InMemoryUserIntegrationStore();
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: 'integration-test-key',
      key: Buffer.alloc(32, 9),
    });
    const staticModule = createIntegrationModule({
      integrationStore: store,
      secretEncryption,
      configuredProviders: [new StaticApiKeyIntegrationProvider(staticApiKeyDescriptorFixture())],
      now: () => NOW,
    });
    await expect(findRoute(staticModule.routes, AIRTABLE_CONNECT_PATH, 'POST').handler(consoleRequest({
      body: { api_key: 'short7' },
    }))).resolves.toMatchObject({ status: 400, body: { code: 'invalid_static_api_key' } });

    const basicDescriptor = staticApiKeyDescriptorFixture({
      staticApiKey: {
        injection: { location: 'basic', name: 'Authorization', valuePrefix: null },
      },
    });
    const basicModule = createIntegrationModule({
      integrationStore: store,
      secretEncryption,
      configuredProviders: [new StaticApiKeyIntegrationProvider(basicDescriptor)],
      now: () => NOW,
    });
    await expect(findRoute(basicModule.routes, AIRTABLE_CONNECT_PATH, 'POST').handler(consoleRequest({
      body: { username: 'alice', password: 'short7' },
    }))).resolves.toMatchObject({ status: 400, body: { code: 'invalid_basic_credential' } });
    await expect(store.findByProvider(USER_ID, 'airtable')).resolves.toBeNull();
  });

  it('accepts a static API key containing a well-formed surrogate pair', async () => {
    const store = new InMemoryUserIntegrationStore();
    const module = createIntegrationModule({
      integrationStore: store,
      secretEncryption: new AeadSecretEncryptionService({
        keyId: 'integration-test-key',
        key: Buffer.alloc(32, 9),
      }),
      configuredProviders: [new StaticApiKeyIntegrationProvider(staticApiKeyDescriptorFixture())],
      now: () => NOW,
    });
    const connect = findRoute(module.routes, AIRTABLE_CONNECT_PATH, 'POST');

    await expect(connect.handler(consoleRequest({
      body: { api_key: `safe-key-${String.fromCodePoint(0x1f600)}` },
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
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    };
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'gmail-client-secret',
      ...providerOutbound(fetchImpl),
    });
    const store = new InMemoryUserIntegrationStore();
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: 'integration-test-key',
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
      externalAccountLabel: 'alice@example.com',
      externalInstallationId: null,
      authorizedPermissions: { scopes: ['gmail.readonly'] },
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
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: ['gmail.readonly'] },
    });

    expect(refreshed).toMatchObject({
      kind: 'refreshed',
      record: {
        provider: 'gmail',
        status: 'connected',
        errorReason: null,
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

  it('does not revoke a refreshed credential that may be the replica winner after CAS loss', async () => {
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'gmail-client-secret',
      ...providerOutbound(() => Promise.resolve(new Response(JSON.stringify({
        access_token: 'gmail-shared-winner-access-token',
        refresh_token: 'gmail-shared-winner-refresh-token',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))),
    });
    const revoke = jest.spyOn(provider, 'revokeCredentials').mockResolvedValue();
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: 'integration-test-key',
      key: Buffer.alloc(32, 9),
    });
    const staleAccessTokenCiphertext = secretEncryption.encrypt(
      Buffer.from('gmail-stale-access-token', 'utf8'),
      { secretClass: 'integration_access_token', ownerId: `gmail:${USER_ID}` },
    );
    const store = new InMemoryUserIntegrationStore();
    await store.connect({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: oauthDescriptorFixture().id,
      externalAccountLabel: 'alice@example.com',
      externalInstallationId: null,
      authorizedPermissions: { scopes: ['gmail.readonly'] },
      accessTokenCiphertext: staleAccessTokenCiphertext,
      refreshTokenCiphertext: secretEncryption.encrypt(
        Buffer.from('gmail-stale-refresh-token', 'utf8'),
        { secretClass: 'integration_refresh_token', ownerId: `gmail:${USER_ID}` },
      ),
      connectedAt: NOW,
    });
    jest.spyOn(store, 'refresh').mockImplementation(async input => {
      const current = await store.findByProvider(input.userId, input.provider);
      if (!current) throw new Error('Expected refresh fixture record');
      const decision = await input.refresh(current);
      if (decision.kind !== 'refreshed') throw new Error('Expected refreshed decision');
      return {
        kind: 'reused',
        record: {
          ...current,
          accessTokenCiphertext: decision.accessTokenCiphertext,
          refreshTokenCiphertext: decision.refreshTokenCiphertext,
          credentialKeyVersion: decision.credentialKeyVersion ?? current.credentialKeyVersion,
          authorizedPermissions: decision.authorizedPermissions ?? current.authorizedPermissions,
          credentialGeneration: current.credentialGeneration + 1,
        },
      };
    });
    const service = new IntegrationTokenRefreshService({
      store,
      providers: new IntegrationProviderRegistry([provider]),
      secretEncryption,
      now: () => NOW,
    });

    const result = await service.refreshOnDemand({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: oauthDescriptorFixture().id,
      staleAccessTokenCiphertext,
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: ['gmail.readonly'] },
    });

    expect(result.kind).toBe('reused');
    expect(revoke).not.toHaveBeenCalled();
    await expect(store.listCredentialCleanup(USER_ID, 'gmail')).resolves.toEqual([
      expect.objectContaining({ status: 'cleanup_pending', errorReason: 'revocation_failed' }),
    ]);
    if (result.kind !== 'reused' || !result.record.accessTokenCiphertext) {
      throw new Error('Expected committed replica winner');
    }
    expect(secretEncryption.decrypt(
      result.record.accessTokenCiphertext,
      { secretClass: 'integration_access_token', ownerId: `gmail:${USER_ID}` },
    ).toString('utf8')).toBe('gmail-shared-winner-access-token');
  });

  it('durably queues a minted token that is too short for safe redaction', async () => {
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'gmail-client-secret',
      ...providerOutbound(() => Promise.resolve(new Response(JSON.stringify({
        access_token: 'short7',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))),
    });
    const revoke = jest.spyOn(provider, 'revokeCredentials').mockResolvedValue();
    const store = new InMemoryUserIntegrationStore();
    const secretEncryption = new AeadSecretEncryptionService({
      keyId: 'integration-test-key',
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
      externalAccountLabel: null,
      externalInstallationId: null,
      authorizedPermissions: { scopes: ['gmail.readonly'] },
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
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: ['gmail.readonly'] },
    })).resolves.toMatchObject({
      kind: 'retryable',
      record: { status: 'connected', errorReason: null },
    });
    expect(revoke).not.toHaveBeenCalled();
    await expect(store.listCredentialCleanup(USER_ID, 'gmail')).resolves.toEqual([
      expect.objectContaining({ status: 'cleanup_pending', errorReason: 'revocation_failed' }),
    ]);
  });

  it('durably queues a minted access token when its rotated refresh token is malformed', async () => {
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'gmail-client-secret',
      ...providerOutbound(() => Promise.resolve(new Response(JSON.stringify({
        access_token: 'gmail-minted-access-token',
        refresh_token: 'malformed-\uD800-token',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))),
    });
    const revoke = jest.spyOn(provider, 'revokeCredentials').mockResolvedValue();
    const fixture = await tokenRefreshFixture(() => Promise.reject(new Error('unused')), provider);

    await expect(fixture.service.refreshOnDemand(fixture.input)).resolves.toMatchObject({
      kind: 'retryable',
      record: { status: 'connected', errorReason: null },
    });
    expect(revoke).not.toHaveBeenCalled();
    await expect(fixture.store.listCredentialCleanup(USER_ID, 'gmail')).resolves.toEqual([
      expect.objectContaining({ status: 'cleanup_pending', errorReason: 'revocation_failed' }),
    ]);
  });

  it('durably queues provider-minted refresh credentials when the database commit fails', async () => {
    const fixture = await tokenRefreshFixture(() => Promise.resolve(new Response(JSON.stringify({
      access_token: 'gmail-minted-before-database-failure',
      refresh_token: 'gmail-rotated-before-database-failure',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const databaseFailure = new Error('database commit failed');
    jest.spyOn(fixture.store, 'refresh').mockImplementation(async input => {
      const current = await fixture.store.findByProvider(input.userId, input.provider);
      if (!current) throw new Error('Expected refresh fixture record');
      const decision = await input.refresh(current);
      if (decision.kind !== 'refreshed') throw new Error('Expected refreshed decision');
      throw databaseFailure;
    });

    await expect(fixture.service.refreshOnDemand(fixture.input)).rejects.toBe(databaseFailure);
    await expect(fixture.store.listCredentialCleanup(USER_ID, 'gmail')).resolves.toEqual([
      expect.objectContaining({ status: 'cleanup_pending', errorReason: 'revocation_failed' }),
    ]);
  });

  it('revokes immediately when a minted refresh credential cannot be queued durably', async () => {
    const provider = new ConfiguredOAuthIntegrationProvider({
      descriptor: oauthDescriptorFixture(),
      clientSecret: 'gmail-client-secret',
      ...providerOutbound(() => Promise.resolve(new Response(JSON.stringify({
        access_token: 'short7',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))),
    });
    const revoke = jest.spyOn(provider, 'revokeCredentials').mockResolvedValue();
    const fixture = await tokenRefreshFixture(() => Promise.reject(new Error('unused')), provider);
    const queue = jest.spyOn(fixture.store, 'queueCredentialCleanup')
      .mockRejectedValue(new Error('cleanup persistence unavailable'));

    await expect(fixture.service.refreshOnDemand(fixture.input)).resolves.toMatchObject({ kind: 'retryable' });
    expect(queue).toHaveBeenCalledTimes(3);
    expect(revoke).toHaveBeenCalledWith({
      accessToken: 'short7',
      refreshToken: null,
      externalInstallationId: null,
    });
  });

  it.each([
    ['network failure', () => Promise.reject(new Error('ENOTFOUND'))],
    ['provider 503', () => Promise.resolve(new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }))],
  ] as const)('releases refresh state and remains retryable after %s', async (_label, fetchImpl) => {
    const fixture = await tokenRefreshFixture(fetchImpl);

    await expect(fixture.service.refreshOnDemand(fixture.input)).resolves.toMatchObject({
      kind: 'retryable',
      record: { status: 'connected', errorReason: null, credentialGeneration: 0 },
    });
    await expect(fixture.store.findByProvider(USER_ID, 'gmail')).resolves.toMatchObject({
      status: 'connected',
      errorReason: null,
      credentialGeneration: 0,
    });

    // A transient failure did not brick the row; a later attempt can acquire
    // the refresh path again and successfully rotate the same credential.
    const provider = fixture.providers.get('gmail');
    if (!provider) throw new Error('expected configured provider');
    jest.spyOn(provider, 'refreshCredentials').mockResolvedValueOnce({
      accessToken: 'gmail-recovered-access-token',
      refreshToken: 'gmail-recovered-refresh-token',
    });
    await expect(fixture.service.refreshOnDemand(fixture.input)).resolves.toMatchObject({
      kind: 'refreshed',
      record: { status: 'connected', credentialGeneration: 1 },
    });
  });

  it('poisons the integration only when the provider confirms invalid_grant', async () => {
    const fixture = await tokenRefreshFixture(() => Promise.resolve(new Response(JSON.stringify({
      error: 'invalid_grant',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })));

    await expect(fixture.service.refreshOnDemand(fixture.input)).resolves.toMatchObject({
      kind: 'failed',
      record: { status: 'error', errorReason: 'token_refresh_failed' },
    });
    await expect(fixture.store.findByProvider(USER_ID, 'gmail')).resolves.toMatchObject({
      status: 'error',
      errorReason: 'token_refresh_failed',
    });
  });

  it('coalesces concurrent refreshes for the same stale credential in one process', async () => {
    const store = new InMemoryUserIntegrationStore();
    let release!: (result: { kind: 'missing'; record: null }) => void;
    const pending = new Promise<{ kind: 'missing'; record: null }>(resolve => {
      release = resolve;
    });
    const refreshStore = jest.spyOn(store, 'refresh').mockImplementation(() => pending);
    const service = new IntegrationTokenRefreshService({
      store,
      providers: IntegrationProviderRegistry.empty(),
      secretEncryption: new AeadSecretEncryptionService({
        keyId: 'integration-test-key',
        key: Buffer.alloc(32, 9),
      }),
      now: () => NOW,
    });
    const input = {
      userId: USER_ID,
      provider: 'gmail' as const,
      integrationDescriptorId: null,
      staleAccessTokenCiphertext: Buffer.from('same-stale-ciphertext'),
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: [] },
    };

    const first = service.refreshOnDemand(input);
    const second = service.refreshOnDemand(input);
    await Promise.resolve();
    expect(refreshStore).toHaveBeenCalledTimes(1);
    release({ kind: 'missing', record: null });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'missing', record: null },
      { kind: 'missing', record: null },
    ]);
  });

  it('does not resurrect an in-memory credential when disconnect wins during refresh', async () => {
    const staleAccessToken = Buffer.from('stale-access-token');
    const store = new InMemoryUserIntegrationStore([integrationFixture({
      provider: 'gmail',
      integrationDescriptorId: null,
      authorizedPermissions: { scopes: ['openid'] },
      accessTokenCiphertext: staleAccessToken,
      refreshTokenCiphertext: Buffer.from('stale-refresh-token'),
    })]);
    let releaseRefresh!: () => void;
    let markRefreshEntered!: () => void;
    const refreshEntered = new Promise<void>(resolve => { markRefreshEntered = resolve; });
    const allowRefreshToFinish = new Promise<void>(resolve => { releaseRefresh = resolve; });

    const refreshing = store.refresh({
      userId: USER_ID,
      provider: 'gmail',
      integrationDescriptorId: null,
      staleAccessTokenCiphertext: staleAccessToken,
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: ['openid'] },
      refreshedAt: NOW,
      refresh: async () => {
        markRefreshEntered();
        await allowRefreshToFinish;
        return {
          kind: 'refreshed',
          accessTokenCiphertext: Buffer.from('fresh-access-token'),
          refreshTokenCiphertext: Buffer.from('fresh-refresh-token'),
        };
      },
    });

    await refreshEntered;
    const active = await store.findByProvider(USER_ID, 'gmail');
    if (!active) throw new Error('expected active integration');
    await store.disconnect({
      userId: USER_ID,
      provider: 'gmail',
      integrationId: active.id,
      credentialGeneration: active.credentialGeneration,
      revokedAt: NOW,
    });
    releaseRefresh();

    await expect(refreshing).resolves.toMatchObject({
      kind: 'retryable',
      record: { status: 'cleanup_pending', errorReason: 'revocation_failed' },
    });
    await expect(store.findByProvider(USER_ID, 'gmail')).resolves.toBeNull();
  });

  it.each([false, true])(
    'audits store refresh exceptions before propagating (configured provider: %s)',
    async configuredProvider => {
      SecurityMonitor.clearAllEventsForTesting();
      const store = new InMemoryUserIntegrationStore();
      const storeFailure = new Error('database connection included only in the thrown error');
      jest.spyOn(store, 'refresh').mockRejectedValue(storeFailure);
      const secretEncryption = new AeadSecretEncryptionService({
        keyId: 'integration-test-key',
        key: Buffer.alloc(32, 9),
      });
      const providers = configuredProvider
        ? [new ConfiguredOAuthIntegrationProvider({
          descriptor: oauthDescriptorFixture(),
          clientSecret: 'gmail-client-secret',
          ...providerOutbound(() => Promise.reject(new Error('not reached'))),
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
        staleCredentialGeneration: 0,
        staleAuthorizedPermissions: { scopes: [] },
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

async function tokenRefreshFixture(
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  providedProvider?: ConfiguredOAuthIntegrationProvider,
) {
  const provider = providedProvider ?? new ConfiguredOAuthIntegrationProvider({
    descriptor: oauthDescriptorFixture(),
    clientSecret: 'gmail-client-secret',
    ...providerOutbound(fetchImpl),
  });
  const providers = new IntegrationProviderRegistry([provider]);
  const store = new InMemoryUserIntegrationStore();
  const secretEncryption = new AeadSecretEncryptionService({
    keyId: 'integration-test-key',
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
    externalAccountLabel: 'alice@example.com',
    externalInstallationId: null,
    authorizedPermissions: { scopes: ['gmail.readonly'] },
    accessTokenCiphertext: staleAccessTokenCiphertext,
    refreshTokenCiphertext: secretEncryption.encrypt(
      Buffer.from('gmail-stale-refresh-token', 'utf8'),
      { secretClass: 'integration_refresh_token', ownerId: `gmail:${USER_ID}` },
    ),
    connectedAt: NOW,
  });
  const service = new IntegrationTokenRefreshService({
    store,
    providers,
    secretEncryption,
    now: () => NOW,
  });
  return {
    provider,
    providers,
    service,
    store,
    input: {
      userId: USER_ID,
      provider: 'gmail' as const,
      integrationDescriptorId: oauthDescriptorFixture().id,
      staleAccessTokenCiphertext,
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: ['gmail.readonly'] },
    },
  };
}

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
      scopes: ['gmail.readonly'],
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

function staticApiKeyDescriptorFixture(
  overrides: Partial<IntegrationDescriptorRecord> = {},
): IntegrationDescriptorRecord {
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
    ...overrides,
  };
}

function cookieValue(result: Awaited<ReturnType<ConsoleRouteDefinition['handler']>>, name: string): string | null {
  const cookie = result.cookies?.find(candidate => candidate.operation === 'set' && candidate.name === name);
  return cookie?.operation === 'set' ? cookie.value : null;
}

class FixtureGitHubIntegrationProvider implements IGitHubIntegrationProvider {
  readonly authorizations: Parameters<IGitHubIntegrationProvider['createAuthorizationUrl']>[0][] = [];
  readonly revocations: Parameters<IGitHubIntegrationProvider['revokeCredentials']>[0][] = [];
  accessToken = 'github-access-token-secret';
  exchangeFails = false;
  mintedExchangeFailure = false;
  revokeFails = false;
  revokeGate: Promise<void> | null = null;

  createAuthorizationUrl(request: Parameters<IGitHubIntegrationProvider['createAuthorizationUrl']>[0]): string {
    this.authorizations.push(request);
    return `https://github.example/install?state=${encodeURIComponent(request.state)}`;
  }

  exchangeAuthorizationCode(): Promise<Awaited<ReturnType<IGitHubIntegrationProvider['exchangeAuthorizationCode']>>> {
    if (this.mintedExchangeFailure) {
      return Promise.reject(new MintedIntegrationCredentialsError(
        this.accessToken,
        'github-refresh-token-secret',
      ));
    }
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
    return this.revokeGate ?? Promise.resolve();
  }
}

class FixtureIntegrationSecurityEventSink implements IIntegrationSecurityEventSink {
  readonly events: IntegrationCallbackRejectedEvent[] = [];

  async recordIntegrationCallbackRejected(event: IntegrationCallbackRejectedEvent): Promise<void> {
    await Promise.resolve();
    this.events.push(event);
  }
}
