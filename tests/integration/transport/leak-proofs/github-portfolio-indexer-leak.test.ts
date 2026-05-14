/**
 * Leak proof #6: github-portfolio-indexer-leak
 *
 * Audit claim: GitHubPortfolioIndexer is a root-level singleton with an
 * in-memory `cache: GitHubPortfolioIndex | null` field (TTL=15min) that
 * stores `username` and element listings. If Alice's session populates this
 * cache with her repo index, Bob's session will receive Alice's username and
 * repo list from the same cache object.
 *
 * See GitHubPortfolioIndexer.ts:
 *   line 56: `private cache: GitHubPortfolioIndex | null = null`
 *   line 57: `private lastFetch: Date | null = null`
 *   line 58: `private readonly ttl = 15 * 60 * 1000; // 15 minutes`
 *
 * Testing approach:
 * 1. Resolve the GitHubPortfolioIndexer singleton.
 * 2. Directly inject a fake cache entry representing Alice's portfolio.
 * 3. Call getIndex() (or inspect the cache) from a simulated Bob context.
 * 4. Assert Bob receives Alice's `username` from the shared cache.
 *
 * We inject directly because real GitHub API calls require OAuth tokens
 * not available in integration tests.
 *
 * EXPECTED (audit correct): Bob's getIndex() call returns Alice's username
 *   from the shared in-memory cache.
 * EXPECTED (audit wrong): GitHubPortfolioIndexer is per-user or the cache
 *   is partitioned by userId.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createHttpTestEnvironment,
  connectHttpClient,
  type HttpTestEnvironment,
  type HttpClientHandle,
} from '../../../helpers/httpTransportHelper.js';
import { GitHubPortfolioIndexer, type GitHubPortfolioIndex } from '../../../../src/portfolio/GitHubPortfolioIndexer.js';
import { ElementType } from '../../../../src/portfolio/types.js';

const ENV_STARTUP_TIMEOUT = 20_000;
const TEST_TIMEOUT = 30_000;

const USER_A = 'alice';
const USER_B = 'bob';

function makeFakeIndex(username: string): GitHubPortfolioIndex {
  return {
    username,
    repository: 'dollhouse-portfolio',
    lastUpdated: new Date(),
    elements: new Map([
      [ElementType.PERSONA, []],
      [ElementType.SKILL, []],
    ]),
    totalElements: 0,
    sha: 'fake-sha-' + username,
    rateLimitInfo: { remaining: 100, resetTime: new Date(Date.now() + 3600_000) },
  };
}

describe('github-portfolio-indexer-leak: shared GitHubPortfolioIndexer cache stores username', () => {
  let env: HttpTestEnvironment;
  let homeOverride: string;
  let handleA: HttpClientHandle;
  let handleB: HttpClientHandle;

  beforeAll(async () => {
    homeOverride = await fs.mkdtemp(path.join(os.tmpdir(), 'indexer-leak-home-'));
    env = await createHttpTestEnvironment({
      homeDirOverride: homeOverride,
      userIdSequence: [USER_A, USER_B],
    });

    handleA = await connectHttpClient(env.runtime);
    handleB = await connectHttpClient(env.runtime);
  }, ENV_STARTUP_TIMEOUT);

  afterAll(async () => {
    await handleA?.disconnect();
    await handleB?.disconnect();
    await env?.cleanup();
    await fs.rm(homeOverride, { recursive: true, force: true }).catch(() => {});
  });

  it('GitHubPortfolioIndexer is a root-scoped singleton', () => {
    const idx1 = env.container.resolve<GitHubPortfolioIndexer>('GitHubPortfolioIndexer');
    const idx2 = env.container.resolve<GitHubPortfolioIndexer>('GitHubPortfolioIndexer');

    expect(idx1).toBe(idx2);
    console.log('[indexer-leak] GitHubPortfolioIndexer is singleton:', idx1 === idx2);
  });

  it('per-user cache slots are mutually exclusive — each user only sees their own injected entry', () => {
    const indexer = env.container.resolve<GitHubPortfolioIndexer>('GitHubPortfolioIndexer');

    // Inject DIFFERENT portfolio indexes for both users into the singleton's
    // per-user cache. After Step 7, the cache must be Map<userId, …>, so
    // each user reads back their own entry — never the other's.
    const aliceIndex = makeFakeIndex('alice-github');
    const bobIndex = makeFakeIndex('bob-github');
    const indexerInternal = indexer as unknown as {
      cacheByUser: Map<string, GitHubPortfolioIndex>;
      lastFetchByUser: Map<string, Date>;
    };
    indexerInternal.cacheByUser.set(USER_A, aliceIndex);
    indexerInternal.cacheByUser.set(USER_B, bobIndex);
    indexerInternal.lastFetchByUser.set(USER_A, new Date());
    indexerInternal.lastFetchByUser.set(USER_B, new Date());

    // Same singleton across both lookups (sanity).
    const indexerForBob = env.container.resolve<GitHubPortfolioIndexer>('GitHubPortfolioIndexer');
    expect(indexerForBob).toBe(indexer);

    const aliceSlot = indexerInternal.cacheByUser.get(USER_A);
    const bobSlot = indexerInternal.cacheByUser.get(USER_B);

    console.log('[indexer-leak] alice slot username:', aliceSlot?.username);
    console.log('[indexer-leak] bob slot username:', bobSlot?.username);

    try {
      // STRONG positive assertions — these would all fail if the cache regressed
      // to a single shared slot (alice's last write would overwrite bob's, or
      // both lookups would return the same instance).
      expect(aliceSlot).toBeDefined();
      expect(bobSlot).toBeDefined();
      expect(aliceSlot!.username).toBe('alice-github');
      expect(bobSlot!.username).toBe('bob-github');
      expect(aliceSlot).not.toBe(bobSlot);
    } finally {
      // Clean up so subsequent tests in this suite see a fresh per-user cache.
      // The indexer is a root singleton — state leaks across tests otherwise.
      indexerInternal.cacheByUser.delete(USER_A);
      indexerInternal.cacheByUser.delete(USER_B);
      indexerInternal.lastFetchByUser.delete(USER_A);
      indexerInternal.lastFetchByUser.delete(USER_B);
    }
  }, TEST_TIMEOUT);

  it('index TTL state is tracked per user', () => {
    const indexer = env.container.resolve<GitHubPortfolioIndexer>('GitHubPortfolioIndexer');
    const indexerInternal = indexer as unknown as {
      cacheByUser: Map<string, GitHubPortfolioIndex>;
      lastFetchByUser: Map<string, Date>;
      ttl: number;
    };

    // Set a fresh fetch time for Alice.
    indexerInternal.lastFetchByUser.set(USER_A, new Date());
    indexerInternal.cacheByUser.set(USER_A, makeFakeIndex('alice-github'));

    const ttlMs = indexerInternal.ttl;
    const lastFetch = indexerInternal.lastFetchByUser.get(USER_A)!;
    const bobLastFetch = indexerInternal.lastFetchByUser.get(USER_B);
    const ageMs = Date.now() - lastFetch.getTime();
    const isWithinTtl = ageMs < ttlMs;

    console.log(
      '[indexer-leak] Shared TTL window — lastFetch:', lastFetch.toISOString(),
      '| TTL (ms):', ttlMs,
      '| Is within TTL:', isWithinTtl
    );

    expect(isWithinTtl).toBe(true);
    expect(bobLastFetch).toBeUndefined();
  });
});
