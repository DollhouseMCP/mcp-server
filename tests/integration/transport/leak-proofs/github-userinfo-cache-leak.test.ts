/**
 * Leak proof #4: github-userinfo-cache-leak
 *
 * Audit claim: GitHubClient uses a shared APICache instance (root singleton).
 * The /user endpoint response is cached by URL. If Alice's session populates
 * the cache and Bob's session calls fetchUserInfo(), Bob may get Alice's
 * GitHub identity from the cache without making a real API call.
 *
 * Testing approach: We cannot make real GitHub API calls in CI without
 * valid tokens. Instead we:
 * 1. Resolve the shared APICache from the container.
 * 2. Directly inject a fake /user response under Alice's token as the cache key.
 * 3. Resolve GitHubAuthManager and call getAuthStatus() — which internally
 *    calls fetchUserInfo() via the GitHubClient.
 * 4. Assert that if the cached entry is present, it's returned regardless
 *    of which session is active (proving the cache is shared).
 *
 * The mock approach is necessary because:
 * - Real OAuth tokens are not available in integration tests.
 * - The APICache key is the URL, not the user, so any cached /user response
 *   is served to all callers regardless of their identity.
 *
 * MOCK BOUNDARY: We inject into APICache directly. We do NOT mock
 * GitHubClient.fetchFromGitHub.
 */

import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createHttpTestEnvironment,
  type HttpTestEnvironment,
} from '../../../helpers/httpTransportHelper.js';
import { APICache } from '../../../../src/cache/APICache.js';
import { GitHubAuthManager } from '../../../../src/auth/GitHubAuthManager.js';

const ENV_STARTUP_TIMEOUT = 20_000;
const GITHUB_USER_URL = 'https://api.github.com/user';

const USER_A = 'alice';
const USER_B = 'bob';

describe('github-userinfo-cache-leak: shared APICache allows cross-user identity leak', () => {
  let env: HttpTestEnvironment;
  let homeOverride: string;

  beforeAll(async () => {
    homeOverride = await fs.mkdtemp(path.join(os.tmpdir(), 'userinfo-leak-home-'));
    env = await createHttpTestEnvironment({
      homeDirOverride: homeOverride,
      userIdSequence: [USER_A, USER_B],
    });
  }, ENV_STARTUP_TIMEOUT);

  afterAll(async () => {
    await env?.cleanup();
    await fs.rm(homeOverride, { recursive: true, force: true }).catch(() => {});
  });

  it('GitHubClient and GitHubAuthManager share the same APICache root singleton', () => {
    const apiCache1 = env.container.resolve<APICache>('APICache');
    const apiCache2 = env.container.resolve<APICache>('APICache');

    // Both resolves return the same singleton.
    expect(apiCache1).toBe(apiCache2);

    // GitHubAuthManager holds a reference to this same cache.
    const authManager = env.container.resolve<GitHubAuthManager>('GitHubAuthManager');
    const authManagerInternal = authManager as unknown as { apiCache: APICache };
    const authManagerCache = authManagerInternal.apiCache;

    console.log('[userinfo-cache] APICache is singleton:', apiCache1 === apiCache2);
    console.log('[userinfo-cache] GitHubAuthManager holds same APICache:', authManagerCache === apiCache1);

    // This is the root cause surface: a single shared cache serves all sessions.
    expect(authManagerCache).toBe(apiCache1);
  });

  it('a raw /user URL cache entry is not used for token-scoped userinfo lookups', async () => {
    const apiCache = env.container.resolve<APICache>('APICache');
    const authManager = env.container.resolve<GitHubAuthManager>('GitHubAuthManager');

    const aliceIdentity = {
      login: 'alice-github',
      id: 1001,
      name: 'Alice GitHub User',
      email: 'alice@example.com',
    };

    apiCache.set(GITHUB_USER_URL, aliceIdentity);

    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ login: 'bob-github', id: 2002, name: 'Bob GitHub User' }),
      headers: { get: () => 'public_repo, read:user' },
    } as unknown as Response);

    try {
      const bobInfo = await (authManager as unknown as {
        fetchUserInfo(token: string): Promise<{ login?: string }>;
      }).fetchUserInfo('bob-token');

      expect(bobInfo.login).toBe('bob-github');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('GitHubAuthManager uses distinct cache keys for distinct tokens', async () => {
    env.container.resolve<APICache>('APICache').clear();
    const authManager = env.container.resolve<GitHubAuthManager>('GitHubAuthManager');
    const responses = new Map([
      ['Bearer alice-token', { login: 'alice-github', id: 1001 }],
      ['Bearer bob-token', { login: 'bob-github', id: 2002 }],
    ]);

    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const authHeader = (init as RequestInit | undefined)?.headers instanceof Headers
        ? (init as RequestInit).headers.get('Authorization')
        : ((init as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.Authorization;
      return {
        ok: true,
        json: async () => responses.get(authHeader ?? '') ?? { login: 'unknown' },
        headers: { get: () => 'public_repo, read:user' },
      } as unknown as Response;
    });

    try {
      const internal = authManager as unknown as {
        fetchUserInfo(token: string): Promise<{ login?: string }>;
      };
      const aliceInfo = await internal.fetchUserInfo('alice-token');
      const bobInfo = await internal.fetchUserInfo('bob-token');
      const aliceInfoAgain = await internal.fetchUserInfo('alice-token');

      expect(aliceInfo.login).toBe('alice-github');
      expect(bobInfo.login).toBe('bob-github');
      expect(aliceInfoAgain.login).toBe('alice-github');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
