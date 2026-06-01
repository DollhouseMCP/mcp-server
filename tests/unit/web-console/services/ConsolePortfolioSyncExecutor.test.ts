import { describe, expect, it, jest } from '@jest/globals';

import {
  AeadSecretEncryptionService,
  ConsolePortfolioSyncExecutor,
  InMemoryPortfolioElementStore,
  InMemoryUserIntegrationStore,
  integrationSecretContext,
  type UserIntegrationRecord,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const INTEGRATION_ID = '35e22a52-dc56-4cd0-9d13-b2802524fbd3';
const NOW = new Date('2026-05-31T12:00:00.000Z');

const secretEncryption = new AeadSecretEncryptionService({
  keyId: 'integration-test-key',
  key: Buffer.alloc(32, 7),
});

describe('ConsolePortfolioSyncExecutor', () => {
  it('pushes local portfolio elements with decrypted GitHub credentials', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore([{
      userId: USER_ID,
      type: 'personas',
      name: 'helper',
      canonicalName: 'helper',
      displayName: 'Helper',
      version: 1,
      updatedAt: NOW,
      validationStatus: 'valid',
      tags: ['utility'],
      metadata: { description: 'Helpful persona' },
      content: 'You are helpful.',
    }]);
    const fetchMock = createFetchMock([
      route('GET', '/repos/alice/custom-portfolio/contents/personas/helper.md', 404, {}),
      route('PUT', '/repos/alice/custom-portfolio/contents/personas/helper.md', 200, { content: { path: 'personas/helper.md' } }),
    ]);
    const executor = new ConsolePortfolioSyncExecutor({
      integrationStore: new InMemoryUserIntegrationStore([integrationRecord()]),
      portfolioStore,
      secretEncryption,
      repositoryName: 'custom-portfolio',
      fetch: fetchMock,
      now: () => NOW,
    });

    await expect(executor.execute(syncJob({ direction: 'push', conflictPolicy: 'prefer_local' })))
      .resolves.toEqual({
        status: 'succeeded',
        resultSummary: {
          provider: 'github',
          direction: 'push',
          conflict_policy: 'prefer_local',
          pulled: 0,
          pushed: 1,
          updated: 0,
          skipped: 0,
          conflicts: 0,
        },
      });

    const put = fetchMock.mock.calls.find(([input, init]) =>
      inputUrl(input).endsWith('/repos/alice/custom-portfolio/contents/personas/helper.md') &&
      init?.method === 'PUT');
    expect(put?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer ghu_test_token',
    });
    const body = JSON.parse(bodyString(put?.[1]?.body)) as { content: string };
    expect(Buffer.from(body.content, 'base64').toString('utf8')).toContain('You are helpful.');
  });

  it('pulls remote portfolio files into the owner portfolio store', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const remoteContent = [
      '---',
      'name: Remote Helper',
      'tags:',
      '  - remote',
      '---',
      '',
      'Remote body.',
    ].join('\n');
    const fetchMock = createFetchMock([
      route('GET', '/repos/alice/dollhouse-portfolio/contents/personas', 200, [
        { type: 'file', name: 'remote-helper.md', path: 'personas/remote-helper.md' },
      ]),
      route('GET', '/repos/alice/dollhouse-portfolio/contents/personas/remote-helper.md', 200, {
        content: Buffer.from(remoteContent, 'utf8').toString('base64'),
        sha: 'remote-sha',
      }),
      ...emptyDirectoryRoutes('alice', 'dollhouse-portfolio', ['skills', 'templates', 'agents', 'memories', 'ensembles']),
    ]);
    const executor = new ConsolePortfolioSyncExecutor({
      integrationStore: new InMemoryUserIntegrationStore([integrationRecord()]),
      portfolioStore,
      secretEncryption,
      fetch: fetchMock,
      now: () => NOW,
    });

    await expect(executor.execute(syncJob({ direction: 'pull', conflictPolicy: 'prefer_remote' })))
      .resolves.toMatchObject({
        status: 'succeeded',
        resultSummary: { pulled: 1, pushed: 0, updated: 0 },
      });
    await expect(portfolioStore.findByName(USER_ID, 'personas', 'remote-helper')).resolves.toMatchObject({
      displayName: 'Remote Helper',
      content: 'Remote body.',
      tags: ['remote'],
    });
  });

  it('fails closed without a usable connected integration credential', async () => {
    const executor = new ConsolePortfolioSyncExecutor({
      integrationStore: new InMemoryUserIntegrationStore([integrationRecord({
        accessTokenCiphertext: Buffer.from('not-a-valid-ciphertext'),
      })]),
      portfolioStore: new InMemoryPortfolioElementStore(),
      secretEncryption,
      fetch: createFetchMock([]),
      now: () => NOW,
    });

    await expect(executor.execute(syncJob({ direction: 'pull', conflictPolicy: 'fail' })))
      .resolves.toMatchObject({
        status: 'failed',
        operationalErrorCode: 'portfolio_sync_credential_unavailable',
      });
  });

  it('honors fail conflict policy without returning repository content', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore([{
      userId: USER_ID,
      type: 'personas',
      name: 'helper',
      canonicalName: 'helper',
      displayName: 'Helper',
      version: 1,
      updatedAt: NOW,
      validationStatus: 'valid',
      tags: [],
      metadata: { name: 'Helper' },
      content: 'local body',
    }]);
    const fetchMock = createFetchMock([
      route('GET', '/repos/alice/dollhouse-portfolio/contents/personas/helper.md', 200, {
        content: Buffer.from('remote body', 'utf8').toString('base64'),
        sha: 'remote-sha',
      }),
    ]);
    const executor = new ConsolePortfolioSyncExecutor({
      integrationStore: new InMemoryUserIntegrationStore([integrationRecord()]),
      portfolioStore,
      secretEncryption,
      fetch: fetchMock,
      now: () => NOW,
    });

    await expect(executor.execute(syncJob({ direction: 'push', conflictPolicy: 'fail' })))
      .resolves.toEqual({
        status: 'failed',
        operationalErrorCode: 'portfolio_sync_conflict',
        resultSummary: {
          provider: 'github',
          direction: 'push',
          conflict_policy: 'fail',
          pulled: 0,
          pushed: 0,
          updated: 0,
          skipped: 0,
          conflicts: 1,
        },
      });
  });
});

function integrationRecord(overrides: Partial<UserIntegrationRecord> = {}): UserIntegrationRecord {
  return {
    id: INTEGRATION_ID,
    userId: USER_ID,
    provider: 'github',
    externalAccountLabel: 'alice',
    externalInstallationId: 'installation-123',
    authorizedPermissions: {
      repository_selection: 'selected',
      permissions: { contents: 'write' },
    },
    accessTokenCiphertext: secretEncryption.encrypt(
      Buffer.from('ghu_test_token', 'utf8'),
      integrationSecretContext('access_token', USER_ID, 'github'),
    ),
    refreshTokenCiphertext: null,
    credentialKeyVersion: 'integration-test-key',
    status: 'connected',
    errorReason: null,
    connectedAt: NOW,
    lastSyncAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function syncJob(overrides: {
  readonly direction: 'pull' | 'push' | 'bidirectional';
  readonly conflictPolicy: 'fail' | 'prefer_local' | 'prefer_remote';
}) {
  return {
    id: '6c490ce1-86b5-4d5a-bec8-4b681a528d38',
    userId: USER_ID,
    integrationId: INTEGRATION_ID,
    direction: overrides.direction,
    conflictPolicy: overrides.conflictPolicy,
    status: 'running' as const,
    claimVersion: 1,
    claimedByWorkerId: 'worker-a',
    leaseUntil: new Date('2026-05-31T12:01:00.000Z'),
    attemptCount: 1,
    resultSummary: null,
    operationalErrorCode: null,
    createdAt: new Date('2026-05-31T11:59:00.000Z'),
    startedAt: NOW,
    completedAt: null,
  };
}

function createFetchMock(routes: readonly MockRoute[]): jest.MockedFunction<typeof fetch> {
  return jest.fn<typeof fetch>((input, init) => {
    const url = new URL(inputUrl(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const match = routes.find(candidate => candidate.method === method && candidate.path === url.pathname);
    if (!match) {
      return Promise.resolve(jsonResponse(500, { message: `unexpected ${method} ${url.pathname}` }));
    }
    return Promise.resolve(jsonResponse(match.status, match.body));
  });
}

interface MockRoute {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: unknown;
}

function route(method: string, path: string, status: number, body: unknown): MockRoute {
  return { method, path, status, body };
}

function emptyDirectoryRoutes(owner: string, repo: string, directories: readonly string[]): readonly MockRoute[] {
  return directories.map(directory =>
    route('GET', `/repos/${owner}/${repo}/contents/${directory}`, 404, {}));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function bodyString(body: BodyInit | null | undefined): string {
  return typeof body === 'string' ? body : '';
}
