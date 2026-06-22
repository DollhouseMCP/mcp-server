/**
 * Per-User Filesystem Isolation in HTTP Multi-User Mode (Phase 4.5 follow-up)
 *
 * Pins the contract that, when running in PER-USER filesystem layout, two
 * HTTP sessions with distinct userIds get fully isolated portfolio storage:
 * user A's elements never leak into user B's view, and the on-disk layout
 * places each user's content under `<portfolioRoot>/users/<userId>/portfolio/`.
 *
 * **Why this test exists.** Per-user filesystem infrastructure (resolver,
 * layout detection, PathService.getUserElementDir, FileStorageLayerFactory's
 * elementDirResolverFactory slot) was built piecewise and the wiring into
 * the element-write path was never completed. The result was the same
 * failure mode that bit the original PoC: every HTTP user wrote to the
 * shared portfolio dir despite the per-user infrastructure being available.
 *
 * **Flat-layout contract** stays intact and is exercised by
 * `session-isolation.test.ts` — that test boots without a home dir
 * override, picks up the dev machine's layout (usually flat), and
 * documents the shared-portfolio semantics that legacy single-user
 * deployments rely on.
 *
 * **DB-mode contract** is enforced by Postgres RLS and is exercised by
 * `tests/integration/database/rls-isolation.test.ts`. This file is
 * filesystem-only.
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
} from '../../helpers/httpTransportHelper.js';
import { preConfirmAllOperations } from '../../helpers/portfolioTestHelper.js';

const ENV_STARTUP_TIMEOUT = 20_000;
const TEST_TIMEOUT = 45_000;

// Two userIds matching VALID_USERID = /^\w[\w-]{0,63}$/ at
// src/paths/validateUserId.ts. Distinct, no path-traversal concerns.
const USER_A = 'alice';
const USER_B = 'bob';

describe('Per-user filesystem isolation (HTTP multi-user)', () => {
  let env: HttpTestEnvironment;
  let homeOverride: string;
  let portfolioRoot: string;
  let handleA: HttpClientHandle;
  let handleB: HttpClientHandle;

  beforeAll(async () => {
    // Force per-user layout. The detection at
    // LegacyDetectingPathResolver.detect() picks per-user when the
    // legacy `~/.dollhouse/` root is missing — give it a brand-new home
    // dir that has no legacy state at all.
    homeOverride = await fs.mkdtemp(path.join(os.tmpdir(), 'perusertest-home-'));

    env = await createHttpTestEnvironment({
      homeDirOverride: homeOverride,
      userIdSequence: [USER_A, USER_B],
    });
    portfolioRoot = env.testDir;

    preConfirmAllOperations(env.container);

    // Two HTTP clients. The session factory assigns userIds[0] to the
    // first connection (alice) and userIds[1] to the second (bob).
    handleA = await connectHttpClient(env.runtime);
    handleB = await connectHttpClient(env.runtime);
  }, ENV_STARTUP_TIMEOUT);

  afterAll(async () => {
    await handleA?.disconnect();
    await handleB?.disconnect();
    await env?.cleanup();
    if (homeOverride) {
      await fs.rm(homeOverride, { recursive: true, force: true }).catch(() => {});
    }
  });

  // SCOPE — this test pins the FILESYSTEM-LAYER isolation contract:
  // each user's elements land in their own `users/<userId>/portfolio/<type>/`
  // subtree, and list_elements scoped to one user does not include another
  // user's elements (because list scans the per-user dir).
  //
  // NOT in scope here (separate cache-layer follow-up):
  // - cross-user lookup-by-name via the LRUCache (`findPersona` iterates
  //   the shared cache and would currently return user A's element to
  //   user B's get/activate-by-name request — a real security gap
  //   tracked separately, but a DIFFERENT layer from filesystem)
  // - same-name conflict avoidance (depends on the cache-lookup fix
  //   landing first; the create-duplicate-check consults the shared
  //   cache and rejects user B's same-name create until that is fixed)
  //
  // We use DISTINCT element names per user here so the test exercises
  // filesystem isolation cleanly, without entanglement with the cache
  // leak.

  it('user A creates a persona; user B does NOT see it in list_elements', async () => {
    await create(handleA.client, {
      operation: 'create_element',
      params: {
        element_name: 'alice-only-persona',
        element_type: 'persona',
        description: 'Created by alice',
        instructions: 'Persona authored by alice. Bob must not see this.',
      },
    });

    const listB = await read(handleB.client, {
      operation: 'list_elements',
      params: { element_type: 'persona' },
    });

    expect(listB).not.toContain('alice-only-persona');
  }, TEST_TIMEOUT);

  it('user B creates a different persona; user A does NOT see it in list_elements', async () => {
    await create(handleB.client, {
      operation: 'create_element',
      params: {
        element_name: 'bob-only-persona',
        element_type: 'persona',
        description: 'Created by bob',
        instructions: 'Persona authored by bob.',
      },
    });

    const listA = await read(handleA.client, {
      operation: 'list_elements',
      params: { element_type: 'persona' },
    });

    expect(listA).not.toContain('bob-only-persona');
  }, TEST_TIMEOUT);

  it('on-disk layout places each user under users/<userId>/portfolio/personas/', async () => {
    // Disk-level proof: each user's file lives in their own subtree, with
    // no shared/flat collision at the portfolioRoot/personas/ level.
    const aliceFile = path.join(portfolioRoot, 'users', USER_A, 'portfolio', 'personas', 'alice-only-persona.md');
    const bobFile = path.join(portfolioRoot, 'users', USER_B, 'portfolio', 'personas', 'bob-only-persona.md');

    await expect(fs.access(aliceFile)).resolves.toBeUndefined();
    await expect(fs.access(bobFile)).resolves.toBeUndefined();

    // Neither user's file landed in the flat shared dir.
    const sharedFlatAlice = path.join(portfolioRoot, 'personas', 'alice-only-persona.md');
    const sharedFlatBob = path.join(portfolioRoot, 'personas', 'bob-only-persona.md');
    await expect(fs.access(sharedFlatAlice)).rejects.toThrow();
    await expect(fs.access(sharedFlatBob)).rejects.toThrow();
  }, TEST_TIMEOUT);

  it('user A creates a skill; user B does NOT see it', async () => {
    await create(handleA.client, {
      operation: 'create_element',
      params: {
        element_name: 'alice-only-skill',
        element_type: 'skill',
        description: 'Created by alice',
        content: '# Skill body for alice',
      },
    });

    const listB = await read(handleB.client, {
      operation: 'list_elements',
      params: { element_type: 'skill' },
    });
    expect(listB).not.toContain('alice-only-skill');

    // Disk proof for the skill path too
    const aliceSkill = path.join(portfolioRoot, 'users', USER_A, 'portfolio', 'skills', 'alice-only-skill.md');
    await expect(fs.access(aliceSkill)).resolves.toBeUndefined();
  }, TEST_TIMEOUT);

  it('user A creates a memory; user B does NOT see it (MemoryStorageLayer per-user)', async () => {
    // Memory has a different storage layer (MemoryStorageLayer with
    // date-subfolder scanning). Covering it ensures the per-user
    // routing reaches the memory path too, not just the generic
    // ElementStorageLayer used by personas/skills/templates.
    await create(handleA.client, {
      operation: 'create_element',
      params: {
        element_name: 'alice-only-memory',
        element_type: 'memory',
        description: 'Created by alice',
      },
    });

    const listB = await read(handleB.client, {
      operation: 'list_elements',
      params: { element_type: 'memory' },
    });
    expect(listB).not.toContain('alice-only-memory');
  }, TEST_TIMEOUT);
});
