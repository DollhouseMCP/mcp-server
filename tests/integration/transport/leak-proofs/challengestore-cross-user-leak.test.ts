/**
 * Leak proof #2: challengestore-cross-user-leak
 *
 * Audit claim: ChallengeStore is registered as a root-level singleton
 * (InMemoryChallengeStore). All HTTP sessions share the same instance.
 * The `verificationStore` field in MCPAQLHandler.handlers is bound at
 * bootstrapHandlers() time from the root container.
 *
 * Consequence: a challenge code issued for session A can be consumed by
 * session B, bypassing per-session security isolation.
 *
 * This test:
 * 1. Directly resolves the ChallengeStore from the container.
 * 2. Inserts a fake challenge as if session A issued it.
 * 3. Asks session B (a different HTTP client) to verify it.
 * 4. If the verify_challenge call succeeds, the store is shared.
 *
 * We inject directly because the UI for issuing challenges (blocked agents,
 * deadlock relief) requires specific preconditions that would make the test
 * fragile. Injecting directly is valid — it proves the store is the same
 * object.
 *
 * EXPECTED (audit correct — leak proven): Bob can verify Alice's challenge.
 * EXPECTED (audit wrong): Bob gets "challenge not found" because he resolves
 *   a different store instance.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createHttpTestEnvironment,
  connectHttpClient,
  execute,
  type HttpTestEnvironment,
  type HttpClientHandle,
} from '../../../helpers/httpTransportHelper.js';
import type { IChallengeStore } from '../../../../src/state/IChallengeStore.js';

const ENV_STARTUP_TIMEOUT = 20_000;
const TEST_TIMEOUT = 45_000;

const USER_A = 'alice';
const USER_B = 'bob';

describe('challengestore-cross-user-leak: shared ChallengeStore allows cross-session verification', () => {
  let env: HttpTestEnvironment;
  let homeOverride: string;
  let handleA: HttpClientHandle;
  let handleB: HttpClientHandle;

  beforeAll(async () => {
    homeOverride = await fs.mkdtemp(path.join(os.tmpdir(), 'challenge-leak-home-'));
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

  it('root container resolves a single ChallengeStore instance (singletons share object identity)', () => {
    const store1 = env.container.resolve<IChallengeStore>('ChallengeStore');
    const store2 = env.container.resolve<IChallengeStore>('ChallengeStore');

    // If singleton: same reference. This is EXPECTED but documents the root cause.
    expect(store1).toBe(store2);
    console.log('[challengestore] ChallengeStore is a singleton:', store1 === store2);
  });

  it('challenge injected for session A is visible to session B (proves shared store)', async () => {
    const store = env.container.resolve<IChallengeStore>('ChallengeStore');
    const challengeId = randomUUID();
    const code = 'ALICE01';

    // Simulate session A issuing a challenge.
    store.set(challengeId, {
      code,
      expiresAt: Date.now() + 60_000,
      reason: 'test-challenge-for-alice',
    });

    // Session B tries to consume Alice's challenge via verify_challenge.
    // The call goes over the wire through Bob's HTTP connection.
    const result = await execute(handleB.client, {
      operation: 'verify_challenge',
      params: {
        challenge_id: challengeId,
        code,
      },
    });

    console.log('[challengestore] Bob verify result:', result);

    // LEAK PROVEN: if Bob can verify Alice's challenge, store is shared.
    // "Verification failed" / "expired" / "not found" = store is isolated.
    const leakProven = !result.toLowerCase().includes('not found')
      && !result.toLowerCase().includes('expired')
      && !result.toLowerCase().includes('failed')
      && !result.toLowerCase().includes('error');

    if (leakProven) {
      // Explicitly fail with a descriptive message.
      throw new Error(
        `LEAK PROVEN: Session B (bob) successfully consumed a challenge that was ` +
        `issued for Session A (alice). The ChallengeStore is shared across HTTP sessions.\n` +
        `verify_challenge response: ${result}`
      );
    } else {
      // Audit finding is disproved — challenge was not accessible cross-session.
      console.log(
        '[challengestore] AUDIT DISPROVED: Bob could not consume Alice\'s challenge.\n' +
        'The ChallengeStore appears to have per-session isolation at the verification layer.'
      );
      expect(result).toMatch(/not found|expired|failed|error/i);
    }
  }, TEST_TIMEOUT);

  it('ChallengeStore is NOT registered in child session container (no per-session override)', () => {
    // Verify the child container does NOT override ChallengeStore.
    // We cannot directly inspect a SessionContainer from outside, but we can
    // check that the root container's singleton IS the one passed to MCPAQLHandler.
    //
    // The MCPAQLHandler stores handlers.verificationStore at construction time.
    // Accessing it via the registered instance.
    const mcpAqlHandler = env.container.resolve<{
      handlers: { verificationStore?: IChallengeStore };
    }>('mcpAqlHandler');
    const handlerStore = mcpAqlHandler.handlers.verificationStore;
    const rootStore = env.container.resolve<IChallengeStore>('ChallengeStore');

    console.log('[challengestore] MCPAQLHandler.verificationStore === root ChallengeStore:', handlerStore === rootStore);

    // If same instance: handler uses the shared root store (leak surface confirmed).
    // If different: something per-session is wired (audit wrong).
    expect(handlerStore).toBe(rootStore);
  });
});
