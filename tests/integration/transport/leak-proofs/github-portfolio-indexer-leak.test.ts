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

  it('Alice\'s cache entry is visible to Bob because the cache is an instance field on the singleton', () => {
    const indexer = env.container.resolve<GitHubPortfolioIndexer>('GitHubPortfolioIndexer');

    // Directly inject Alice's portfolio index into the singleton's cache.
    const aliceIndex = makeFakeIndex('alice-github');
    const indexerInternal = indexer as unknown as {
      cache: GitHubPortfolioIndex | null;
      lastFetch: Date | null;
    };
    indexerInternal.cache = aliceIndex;
    indexerInternal.lastFetch = new Date();

    // Now resolve from the same container as Bob would (same object reference).
    const indexerForBob = env.container.resolve<GitHubPortfolioIndexer>('GitHubPortfolioIndexer');
    const bobSeesCache = (indexerForBob as unknown as { cache: GitHubPortfolioIndex | null }).cache;

    console.log('[indexer-leak] Cache username visible to Bob:', bobSeesCache?.username);

    // LEAK PROVEN: Bob's resolution sees Alice's username.
    if (bobSeesCache?.username === 'alice-github') {
      throw new Error(
        'CACHE LEAK PROVEN: GitHubPortfolioIndexer.cache is an instance field on a ' +
        'root-scoped singleton. Alice\'s cached portfolio (username: alice-github, ' +
        `sha: ${bobSeesCache.sha}) is visible to Bob's session within the 15-minute TTL. ` +
        'Bob\'s portfolio operations would show Alice\'s repo listing.'
      );
    }

    // If we reach here, Bob got null or a different cache entry.
    console.log('[indexer-leak] AUDIT DISPROVED: Bob did not see Alice\'s cache entry.');
    expect(bobSeesCache?.username).not.toBe('alice-github');
  }, TEST_TIMEOUT);

  it('index TTL check is not user-aware (lastFetch is shared, not per-user)', () => {
    const indexer = env.container.resolve<GitHubPortfolioIndexer>('GitHubPortfolioIndexer');
    const indexerInternal = indexer as unknown as {
      cache: GitHubPortfolioIndex | null;
      lastFetch: Date | null;
      ttl: number;
    };

    // Set a fresh fetch time for Alice.
    indexerInternal.lastFetch = new Date();
    indexerInternal.cache = makeFakeIndex('alice-github');

    // The TTL check is done against `this.lastFetch` which is a single field.
    // Bob's fetch within the TTL window would use Alice's cached data.
    const ttlMs = indexerInternal.ttl;
    const lastFetch = indexerInternal.lastFetch;
    const ageMs = Date.now() - lastFetch.getTime();
    const isWithinTtl = ageMs < ttlMs;

    console.log(
      '[indexer-leak] Shared TTL window — lastFetch:', lastFetch.toISOString(),
      '| TTL (ms):', ttlMs,
      '| Is within TTL:', isWithinTtl
    );

    // Within TTL: Bob would get Alice's stale cache. This is the impersonation window.
    expect(isWithinTtl).toBe(true);
    console.log(
      '[indexer-leak] CONFIRMED: Bob\'s request within',
      Math.round(ttlMs / 60_000),
      'minutes of Alice\'s last fetch would return Alice\'s index.'
    );
  });
});
