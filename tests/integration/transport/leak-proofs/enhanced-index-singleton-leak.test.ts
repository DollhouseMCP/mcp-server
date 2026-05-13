/**
 * Leak proof #7: enhanced-index-singleton-leak
 *
 * Audit claim: EnhancedIndexManager is a root-level singleton. Its constructor
 * hardcodes `indexPath` to `~/.dollhouse/portfolio/capability-index.yaml`
 * using `process.env.HOME` regardless of which userId is active.
 *
 * See EnhancedIndexManager.ts lines 121-122:
 *   const portfolioPath = path.join(process.env.HOME || '', '.dollhouse', 'portfolio');
 *   this.indexPath = path.join(portfolioPath, 'capability-index.yaml');
 *
 * Consequences:
 * 1. All HTTP sessions read/write the same capability index file.
 * 2. Alice's indexed elements appear in Bob's capability index.
 * 3. The path is not per-user even in PER-USER filesystem layout mode.
 *
 * This test:
 * 1. Resolves the EnhancedIndexManager singleton.
 * 2. Inspects its `indexPath` field.
 * 3. Asserts the path is the per-operator hardcoded path (NOT per-user).
 * 4. Confirms the singleton is shared across both HTTP sessions.
 *
 * EXPECTED (audit correct): indexPath === `${HOME}/.dollhouse/portfolio/capability-index.yaml`
 *   for all sessions, regardless of userId.
 * EXPECTED (audit wrong): indexPath is per-user or constructed from PathService.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createHttpTestEnvironment,
  connectHttpClient,
  create,
  read,
  type HttpTestEnvironment,
  type HttpClientHandle,
} from '../../../helpers/httpTransportHelper.js';
import { preConfirmAllOperations } from '../../../helpers/portfolioTestHelper.js';
import { EnhancedIndexManager } from '../../../../src/portfolio/EnhancedIndexManager.js';

const ENV_STARTUP_TIMEOUT = 20_000;
const TEST_TIMEOUT = 60_000;

const USER_A = 'alice';
const USER_B = 'bob';

describe('enhanced-index-singleton-leak: EnhancedIndexManager hardcoded path and shared state', () => {
  let env: HttpTestEnvironment;
  let homeOverride: string;
  let handleA: HttpClientHandle;
  let handleB: HttpClientHandle;

  beforeAll(async () => {
    homeOverride = await fs.mkdtemp(path.join(os.tmpdir(), 'eindex-leak-home-'));
    env = await createHttpTestEnvironment({
      homeDirOverride: homeOverride,
      userIdSequence: [USER_A, USER_B],
    });
    preConfirmAllOperations(env.container);

    handleA = await connectHttpClient(env.runtime);
    handleB = await connectHttpClient(env.runtime);
  }, ENV_STARTUP_TIMEOUT);

  afterAll(async () => {
    await handleA?.disconnect();
    await handleB?.disconnect();
    await env?.cleanup();
    await fs.rm(homeOverride, { recursive: true, force: true }).catch(() => {});
  });

  it('EnhancedIndexManager is a root-scoped singleton', () => {
    const mgr1 = env.container.resolve<EnhancedIndexManager>('EnhancedIndexManager');
    const mgr2 = env.container.resolve<EnhancedIndexManager>('EnhancedIndexManager');

    expect(mgr1).toBe(mgr2);
    console.log('[eindex-leak] EnhancedIndexManager is singleton:', mgr1 === mgr2);
  });

  it('indexPath is hardcoded to the operator HOME/.dollhouse path, not per-user', () => {
    const mgr = env.container.resolve<EnhancedIndexManager>('EnhancedIndexManager');
    const indexPath = (mgr as unknown as { indexPath: string }).indexPath;

    console.log('[eindex-leak] EnhancedIndexManager.indexPath:', indexPath);

    // The expected hardcoded path (from the constructor source).
    const expectedHardcodedPath = path.join(
      process.env.HOME || os.homedir(),
      '.dollhouse',
      'portfolio',
      'capability-index.yaml'
    );

    // LEAK PROVEN: path is hardcoded to operator home, not per-user.
    if (indexPath === expectedHardcodedPath) {
      throw new Error(
        `HARDCODED PATH PROVEN: EnhancedIndexManager.indexPath is hardcoded to the ` +
        `operator-level path:\n  ${indexPath}\n` +
        `This path does not vary by userId. All HTTP sessions (alice, bob, etc.) read ` +
        `and write the same capability index, so alice's elements appear in bob's ` +
        `capability index search results.`
      );
    }

    // Audit wrong: indexPath is per-user or constructed from PathService.
    console.log('[eindex-leak] AUDIT DISPROVED: indexPath is not the hardcoded operator path.');
    expect(indexPath).not.toBe(expectedHardcodedPath);
  });

  it('EnhancedIndexManager indexPath is also not per-user even under DOLLHOUSE_HOME_DIR override', () => {
    const mgr = env.container.resolve<EnhancedIndexManager>('EnhancedIndexManager');
    const indexPath = (mgr as unknown as { indexPath: string }).indexPath;

    // The test was launched with homeDirOverride, which sets DOLLHOUSE_HOME_DIR.
    // If EnhancedIndexManager used PathService/DOLLHOUSE_HOME_DIR, indexPath would
    // reference homeOverride. Let's check.
    const usesHomeOverride = indexPath.startsWith(homeOverride);
    const usesPortfolioDir = env.testDir !== undefined && indexPath.startsWith(env.testDir);
    const usesAlicePath = indexPath.includes(USER_A);
    const usesBobPath = indexPath.includes(USER_B);

    console.log('[eindex-leak] indexPath starts with homeOverride:', usesHomeOverride);
    console.log('[eindex-leak] indexPath starts with testDir:', usesPortfolioDir);
    console.log('[eindex-leak] indexPath contains "alice":', usesAlicePath);
    console.log('[eindex-leak] indexPath contains "bob":', usesBobPath);

    // If the path contains neither user's name and doesn't use the override dir,
    // it confirms the hardcoded path is in effect regardless of per-user layout.
    const isPerUser = usesAlicePath || usesBobPath || usesHomeOverride || usesPortfolioDir;

    if (!isPerUser) {
      console.log(
        '[eindex-leak] CONFIRMED HARDCODED: indexPath does not use per-user dirs or the ' +
        'DOLLHOUSE_HOME_DIR override. All sessions share:', indexPath
      );
    }
    // Not asserting fail/pass here — the structural test above already throws.
    // This test provides supplementary evidence about the path.
    expect(typeof indexPath).toBe('string');
    expect(indexPath.endsWith('capability-index.yaml')).toBe(true);
  });

  it('Alice creates element and it appears in list for Bob (shared in-memory index if both use same singleton)', async () => {
    // Create a unique element for Alice.
    const aliceElementName = 'alice-eindex-probe-' + Date.now();

    await create(handleA.client, {
      operation: 'create_element',
      params: {
        element_name: aliceElementName,
        element_type: 'persona',
        description: 'Alice probe for index leak test',
        instructions: 'ALICE_EINDEX_PROBE',
      },
    });

    // Bob's list: if the EnhancedIndexManager's in-memory index is shared AND
    // has been populated by Alice's create, Bob may see Alice's element.
    // Note: list_elements uses PortfolioManager (file scan), not EnhancedIndex.
    // This test confirms the filesystem isolation is intact while the index path bug
    // is a separate surface.
    const bobList = await read(handleB.client, {
      operation: 'list_elements',
      params: { element_type: 'persona' },
    });

    console.log('[eindex-leak] Bob list result contains Alice element:', bobList.includes(aliceElementName));

    // File-layer isolation should hold (per per-user-filesystem-isolation.test.ts).
    // If Bob sees Alice's element, the filesystem isolation regressed.
    if (bobList.includes(aliceElementName)) {
      throw new Error(
        `FILESYSTEM ISOLATION REGRESSION: Bob can see Alice's element '${aliceElementName}' ` +
        `in list_elements. This contradicts per-user-filesystem-isolation.test.ts findings ` +
        `and suggests a broader regression beyond just the EnhancedIndexManager path bug.`
      );
    }

    console.log('[eindex-leak] Filesystem isolation holds (Bob cannot see Alice\'s element via list).');
    expect(bobList).not.toContain(aliceElementName);
  }, TEST_TIMEOUT);
});
