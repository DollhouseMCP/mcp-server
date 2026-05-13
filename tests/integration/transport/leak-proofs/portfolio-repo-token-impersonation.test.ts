/**
 * Leak proof #5: portfolio-repo-token-impersonation
 *
 * Audit claim: PortfolioRepoManager is a root-level singleton with a mutable
 * `private token: string | null` field. When Alice calls a portfolio operation
 * that authenticates with GitHub, the token is cached on `this.token`. Bob's
 * subsequent portfolio operation reuses that cached token, authenticating as
 * Alice.
 *
 * See PortfolioRepoManager.ts line 32: `private token: string | null = null`
 * and getTokenAndValidate() lines 71-72: `this.token = await this.tokenManager.getGitHubTokenAsync()`
 *
 * This test:
 * 1. Resolves the PortfolioRepoManager singleton.
 * 2. Sets its token field to a fake "Alice" token via setToken().
 * 3. Verifies the token persists across two container resolutions (singleton).
 * 4. Documents that two different HTTP sessions would share this mutable state.
 *
 * EXPECTED (audit correct): PortfolioRepoManager is a singleton; token set for
 *   one session persists and would be returned for the next session's call.
 * EXPECTED (audit wrong): PortfolioRepoManager is NOT a singleton, or the
 *   token field is cleared between requests.
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
import { PortfolioRepoManager } from '../../../../src/portfolio/PortfolioRepoManager.js';

const ENV_STARTUP_TIMEOUT = 20_000;
const TEST_TIMEOUT = 30_000;

const USER_A = 'alice';
const USER_B = 'bob';

// Syntactically valid fake GitHub tokens (never contact GitHub in these tests).
const ALICE_FAKE_TOKEN = 'ghp_ALICEFAKETOKEN0000000000000000000001';
const BOB_FAKE_TOKEN = 'ghp_BOBFAKETOKEN00000000000000000000002';

describe('portfolio-repo-token-impersonation: shared PortfolioRepoManager mutable token', () => {
  let env: HttpTestEnvironment;
  let homeOverride: string;
  let handleA: HttpClientHandle;
  let handleB: HttpClientHandle;

  beforeAll(async () => {
    homeOverride = await fs.mkdtemp(path.join(os.tmpdir(), 'portfolio-token-home-'));
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

  it('PortfolioRepoManager is a root-scoped singleton (not per-session)', () => {
    const mgr1 = env.container.resolve<PortfolioRepoManager>('PortfolioRepoManager');
    const mgr2 = env.container.resolve<PortfolioRepoManager>('PortfolioRepoManager');

    expect(mgr1).toBe(mgr2);
    console.log('[portfolio-token] PortfolioRepoManager is singleton:', mgr1 === mgr2);
  });

  it('token written for Alice persists on the singleton and is visible to Bob\'s resolution', () => {
    const mgrForAlice = env.container.resolve<PortfolioRepoManager>('PortfolioRepoManager');

    // Simulate Alice's session setting the token (as getTokenAndValidate() does lazily).
    mgrForAlice.setToken(ALICE_FAKE_TOKEN);

    // Simulate Bob resolving the same singleton in his request context.
    const mgrForBob = env.container.resolve<PortfolioRepoManager>('PortfolioRepoManager');

    // Inspect the private token field via cast.
    const tokenOnBobsView = (mgrForBob as unknown as { token: string | null }).token;

    console.log(
      '[portfolio-token] Token visible to Bob after Alice set it:',
      tokenOnBobsView ? tokenOnBobsView.substring(0, 20) + '...' : 'null'
    );

    // LEAK PROVEN: Bob sees Alice's token because they share the same singleton.
    if (tokenOnBobsView === ALICE_FAKE_TOKEN) {
      throw new Error(
        'IMPERSONATION LEAK PROVEN: PortfolioRepoManager is a mutable singleton. ' +
        'Alice\'s token was set via setToken() and is immediately visible when Bob ' +
        'resolves the same PortfolioRepoManager instance. Any portfolio GitHub API ' +
        'call Bob makes will authenticate as Alice.\n' +
        `Token prefix: ${tokenOnBobsView.substring(0, 20)}`
      );
    }

    // If we reach here the audit finding is wrong — Bob got a different (null) token.
    console.log('[portfolio-token] AUDIT DISPROVED: Bob did not see Alice\'s token.');
    expect(tokenOnBobsView).not.toBe(ALICE_FAKE_TOKEN);
  }, TEST_TIMEOUT);

  it('GitHubPortfolioIndexer holds the same PortfolioRepoManager singleton', () => {
    const mgr = env.container.resolve<PortfolioRepoManager>('PortfolioRepoManager');
    const indexer = env.container.resolve<{
      portfolioRepoManager: PortfolioRepoManager;
    }>('GitHubPortfolioIndexer');

    const indexerMgr = indexer.portfolioRepoManager;

    console.log('[portfolio-token] GitHubPortfolioIndexer.portfolioRepoManager === singleton:', indexerMgr === mgr);

    // Both the direct PortfolioRepoManager and the one inside the indexer
    // are the same instance — confirming the blast radius of the mutable token.
    expect(indexerMgr).toBe(mgr);
  });

  it('token persists after a second mutation (singleton mutable state survives calls)', () => {
    const mgr = env.container.resolve<PortfolioRepoManager>('PortfolioRepoManager');

    mgr.setToken(BOB_FAKE_TOKEN);
    const resolvedAgain = env.container.resolve<PortfolioRepoManager>('PortfolioRepoManager');
    const tokenAfterBobSet = (resolvedAgain as unknown as { token: string | null }).token;

    console.log(
      '[portfolio-token] Token after Bob sets it:',
      tokenAfterBobSet ? tokenAfterBobSet.substring(0, 20) + '...' : 'null'
    );

    // Bob's set overwrote Alice's — confirms mutual overwrite on shared singleton.
    expect(tokenAfterBobSet).toBe(BOB_FAKE_TOKEN);
  });
});
