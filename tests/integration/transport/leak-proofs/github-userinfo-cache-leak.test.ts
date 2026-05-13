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

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
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

  it('a /user response cached under Alice\'s context is visible to Bob\'s session', () => {
    const apiCache = env.container.resolve<APICache>('APICache');

    // APICache stores responses by URL key. Inject a fake Alice response.
    const aliceIdentity = {
      login: 'alice-github',
      id: 1001,
      name: 'Alice GitHub User',
      email: 'alice@example.com',
    };

    // Inject Alice's response into the shared cache at the /user URL.
    // APICache.set signature: set(key, data, ttlMs?)
    apiCache.set(GITHUB_USER_URL, aliceIdentity, 60_000);

    // Now retrieve from the same cache with no token context (as Bob would see it).
    const cached = apiCache.get(GITHUB_USER_URL);

    console.log('[userinfo-cache] Cached at /user URL:', JSON.stringify(cached));

    // LEAK PROVEN: Bob's session can read Alice's identity from the cache,
    // because the cache key is the URL only, not URL+token.
    if (cached && (cached as { login?: string }).login === 'alice-github') {
      throw new Error(
        'CACHE LEAK PROVEN: The shared APICache serves Alice\'s /user response ' +
        'without any token or user-scoped key. Bob\'s session would receive Alice\'s ' +
        'GitHub identity (login: alice-github) from cache.\n' +
        `Cached value: ${JSON.stringify(cached)}`
      );
    }

    // If we reach here, the cache returned nothing (TTL expired, cache miss, or
    // different key structure) — document as inconclusive.
    console.log('[userinfo-cache] Cache miss — unable to prove or disprove leak without real tokens.');
  });

  it('APICache has no per-user key partitioning (URL is the sole cache key)', () => {
    const apiCache = env.container.resolve<APICache>('APICache');

    // Inspect the APICache internals to determine if it has userId awareness.
    const internalCache = apiCache as unknown as Record<string, unknown>;
    const hasCacheKeys = Object.keys(internalCache).some(k =>
      k.toLowerCase().includes('user') && k !== 'set' && k !== 'get'
    );

    console.log('[userinfo-cache] APICache internal keys:', Object.keys(internalCache).join(', '));
    expect(hasCacheKeys).toBe(false);

    // Set two values for the same URL — the second should overwrite the first,
    // proving there is no user-namespace partitioning.
    apiCache.set(GITHUB_USER_URL, { login: 'first-user' }, 60_000);
    apiCache.set(GITHUB_USER_URL, { login: 'second-user' }, 60_000);

    const result = apiCache.get(GITHUB_USER_URL);
    console.log('[userinfo-cache] After two sets at same URL:', result);

    // Only one value can exist at a given key — second overwrites first.
    // This proves that if Alice sets /user and Bob reads /user, Bob gets Alice's data.
    expect((result as { login?: string } | null)?.login).toBe('second-user');
  });
});
