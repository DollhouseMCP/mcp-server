/**
 * Leak proof #5: portfolio-repo-token-impersonation
 *
 * Step 3 regression: HTTP session handlers must resolve PortfolioRepoManager
 * and GitHubPortfolioIndexer through their SessionContainer so mutable token
 * state cannot cross user sessions.
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
import type { GitHubPortfolioIndexer } from '../../../../src/portfolio/GitHubPortfolioIndexer.js';
import type { PortfolioHandler } from '../../../../src/handlers/PortfolioHandler.js';
import type { SessionContainerRegistry } from '../../../../src/di/SessionContainerRegistry.js';

const ENV_STARTUP_TIMEOUT = 20_000;
const TEST_TIMEOUT = 30_000;

const USER_A = 'alice';
const USER_B = 'bob';

// Syntactically valid fake GitHub tokens (never contact GitHub in these tests).
const ALICE_FAKE_TOKEN = 'ghp_ALICEFAKETOKEN0000000000000000000001';
const BOB_FAKE_TOKEN = 'ghp_BOBFAKETOKEN00000000000000000000002';

describe('portfolio-repo-token-impersonation: HTTP sessions isolate PortfolioRepoManager token state', () => {
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

  it('root PortfolioRepoManager remains a singleton for stdio/background fallback', () => {
    const mgr1 = env.container.resolve<PortfolioRepoManager>('PortfolioRepoManager');
    const mgr2 = env.container.resolve<PortfolioRepoManager>('PortfolioRepoManager');

    expect(mgr1).toBe(mgr2);
    console.log('[portfolio-token] PortfolioRepoManager is singleton:', mgr1 === mgr2);
  });

  it('token written for Alice stays on Alice session manager only', () => {
    const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
    const childA = registry.get(env.sessionContexts[0].sessionId);
    const childB = registry.get(env.sessionContexts[1].sessionId);
    expect(childA).toBeDefined();
    expect(childB).toBeDefined();

    const mgrForAlice = childA!.resolve<PortfolioRepoManager>('PortfolioRepoManager');
    const mgrForBob = childB!.resolve<PortfolioRepoManager>('PortfolioRepoManager');

    mgrForAlice.setToken(ALICE_FAKE_TOKEN);
    const tokenOnBobsView = (mgrForBob as unknown as { token: string | null }).token;

    console.log(
      '[portfolio-token] Token visible to Bob after Alice set it:',
      tokenOnBobsView ? tokenOnBobsView.substring(0, 20) + '...' : 'null'
    );

    expect(mgrForAlice).not.toBe(mgrForBob);
    expect(tokenOnBobsView).not.toBe(ALICE_FAKE_TOKEN);
    expect(tokenOnBobsView).toBeNull();
  }, TEST_TIMEOUT);

  it('session GitHubPortfolioIndexer and PortfolioHandler use the session PortfolioRepoManager', () => {
    const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
    const childA = registry.get(env.sessionContexts[0].sessionId);
    const childB = registry.get(env.sessionContexts[1].sessionId);

    const mgrA = childA!.resolve<PortfolioRepoManager>('PortfolioRepoManager');
    const mgrB = childB!.resolve<PortfolioRepoManager>('PortfolioRepoManager');
    const indexerA = childA!.resolve<GitHubPortfolioIndexer>('GitHubPortfolioIndexer') as unknown as {
      portfolioRepoManager: PortfolioRepoManager;
    };
    const indexerB = childB!.resolve<GitHubPortfolioIndexer>('GitHubPortfolioIndexer') as unknown as {
      portfolioRepoManager: PortfolioRepoManager;
    };
    const handlerA = childA!.resolve<PortfolioHandler>('PortfolioHandler') as unknown as {
      portfolioRepoManager: PortfolioRepoManager;
    };
    const handlerB = childB!.resolve<PortfolioHandler>('PortfolioHandler') as unknown as {
      portfolioRepoManager: PortfolioRepoManager;
    };

    expect(indexerA.portfolioRepoManager).toBe(mgrA);
    expect(indexerB.portfolioRepoManager).toBe(mgrB);
    expect(handlerA.portfolioRepoManager).toBe(mgrA);
    expect(handlerB.portfolioRepoManager).toBe(mgrB);
    expect(mgrA).not.toBe(mgrB);
  });

  it('token mutations remain independent across session managers', () => {
    const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
    const childA = registry.get(env.sessionContexts[0].sessionId);
    const childB = registry.get(env.sessionContexts[1].sessionId);
    const mgrA = childA!.resolve<PortfolioRepoManager>('PortfolioRepoManager');
    const mgrB = childB!.resolve<PortfolioRepoManager>('PortfolioRepoManager');

    mgrA.setToken(ALICE_FAKE_TOKEN);
    mgrB.setToken(BOB_FAKE_TOKEN);
    const tokenAfterAliceSet = (mgrA as unknown as { token: string | null }).token;
    const tokenAfterBobSet = (mgrB as unknown as { token: string | null }).token;

    console.log(
      '[portfolio-token] Token after Bob sets it:',
      tokenAfterBobSet ? tokenAfterBobSet.substring(0, 20) + '...' : 'null'
    );

    expect(tokenAfterAliceSet).toBe(ALICE_FAKE_TOKEN);
    expect(tokenAfterBobSet).toBe(BOB_FAKE_TOKEN);
  });
});
