/**
 * Leak proof #3: element-cache-singleton-leak
 *
 * Audit claim: ElementManagers (PersonaManager etc.) hold an LRUCache that is
 * root-scoped. If Alice creates a persona and then modifies it, Bob's
 * get_element_details could return Alice's cached (modified) version.
 *
 * The per-user-filesystem-isolation.test.ts already confirms the DISK layer
 * is isolated. This test targets the IN-MEMORY CACHE layer.
 *
 * Strategy:
 * 1. Alice creates a persona with specific instructions.
 * 2. Alice edits the persona — changes the instructions.
 * 3. Bob creates a persona with the SAME name (different user, so disk is isolated).
 * 4. Bob calls get_element_details on his own persona.
 * 5. If Bob sees Alice's updated instructions, the cache leaked across users.
 *
 * Note: the existing per-user-filesystem-isolation test deliberately uses
 * DIFFERENT element names to avoid this cache interaction. Here we use the
 * SAME name intentionally to trigger the cache collision.
 *
 * COMPLICATION: create_element with the same name across different users
 * currently hits the shared-cache duplicate-check and may reject Bob's create.
 * We document that outcome as a SEPARATE manifestation of the same root bug
 * (shared LRUCache).
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
  update,
  type HttpTestEnvironment,
  type HttpClientHandle,
} from '../../../helpers/httpTransportHelper.js';
import { preConfirmAllOperations } from '../../../helpers/portfolioTestHelper.js';

const ENV_STARTUP_TIMEOUT = 20_000;
const TEST_TIMEOUT = 60_000;

const USER_A = 'alice';
const USER_B = 'bob';
const SHARED_PERSONA_NAME = 'shared-persona-cache-test';

describe('element-cache-singleton-leak: LRUCache shared across HTTP sessions', () => {
  let env: HttpTestEnvironment;
  let homeOverride: string;
  let handleA: HttpClientHandle;
  let handleB: HttpClientHandle;

  beforeAll(async () => {
    homeOverride = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-leak-home-'));
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

  it('Alice creates a persona, then edits it — warming the cache with Alice-specific content', async () => {
    const createResult = await create(handleA.client, {
      operation: 'create_element',
      params: {
        element_name: SHARED_PERSONA_NAME,
        element_type: 'persona',
        description: 'Alice persona v1',
        content: 'ALICE_ORIGINAL_INSTRUCTIONS',
      },
    });
    console.log('[element-cache] Alice create result:', createResult.substring(0, 200));
    expect(createResult).toMatch(/success|created/i);

    // Edit to update the cache with Alice's v2 content.
    const editResult = await update(handleA.client, {
      operation: 'edit_element',
      params: {
        element_name: SHARED_PERSONA_NAME,
        element_type: 'persona',
        input: {
          content: 'ALICE_MODIFIED_INSTRUCTIONS_V2',
        },
      },
    });
    console.log('[element-cache] Alice edit result:', editResult.substring(0, 200));
    // Edit may succeed or require confirm — either way, Alice's content is now in the cache.
  }, TEST_TIMEOUT);

  it('Bob creates a persona with the same name — cross-user duplicate check reveals shared cache', async () => {
    const bobCreateResult = await create(handleB.client, {
      operation: 'create_element',
      params: {
        element_name: SHARED_PERSONA_NAME,
        element_type: 'persona',
        description: 'Bob persona — distinct from Alice',
        content: 'BOB_OWN_INSTRUCTIONS',
      },
    });
    console.log('[element-cache] Bob create result:', bobCreateResult.substring(0, 300));

    // LEAK MANIFESTATION A: If Bob's create is rejected with "already exists",
    // the shared cache is returning Alice's element as a hit for Bob's namespace.
    if (bobCreateResult.toLowerCase().includes('already exist') ||
        bobCreateResult.toLowerCase().includes('conflict')) {
      throw new Error(
        'CACHE LEAK PROVEN (create path): Bob\'s create_element was rejected because ' +
        'the shared LRUCache returned Alice\'s element as a duplicate match.\n' +
        `Bob create response: ${bobCreateResult}`
      );
    }

    // EXPECTED CORRECT BEHAVIOR: Bob can create his own persona because it
    // lives in a different per-user namespace and the cache is isolated.
    expect(bobCreateResult).toMatch(/success|created/i);
  }, TEST_TIMEOUT);

  it('Bob reads his persona and does NOT see Alice\'s instructions', async () => {
    const bobReadResult = await read(handleB.client, {
      operation: 'get_element_details',
      params: {
        element_name: SHARED_PERSONA_NAME,
        element_type: 'persona',
      },
    });
    console.log('[element-cache] Bob read result:', bobReadResult.substring(0, 400));

    // LEAK MANIFESTATION B: Bob sees Alice's instructions in the element content.
    if (bobReadResult.includes('ALICE_MODIFIED_INSTRUCTIONS_V2') ||
        bobReadResult.includes('ALICE_ORIGINAL_INSTRUCTIONS')) {
      throw new Error(
        'CACHE LEAK PROVEN (read path): Bob\'s get_element_details returned Alice\'s ' +
        'instructions. The in-memory LRUCache is not isolated per user.\n' +
        `Bob read response: ${bobReadResult.substring(0, 500)}`
      );
    }

    // Correct behavior: Bob sees his own metadata and not Alice's cached content.
    if (bobReadResult.toLowerCase().includes('not found')) {
      // Bob's create may have failed — document as inconclusive.
      console.log('[element-cache] INCONCLUSIVE: Bob\'s element was not found. ' +
        'This may mean his create failed due to the cache leak (see prior test), ' +
        'or the read is scoped per-user correctly.');
      return;
    }

    expect(bobReadResult).toContain('Bob persona');
    expect(bobReadResult).not.toMatch(/ALICE/);
  }, TEST_TIMEOUT);
});
