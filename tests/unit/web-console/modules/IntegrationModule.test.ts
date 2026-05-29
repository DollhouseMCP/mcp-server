import { describe, expect, it } from '@jest/globals';

import {
  createIntegrationModule,
  InMemoryUserIntegrationStore,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
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
});
