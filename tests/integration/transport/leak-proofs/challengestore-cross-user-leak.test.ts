/**
 * Leak proof #2: challengestore-cross-user-leak
 *
 * Regression coverage for Step 2 of HTTP multi-user correctness:
 * MCPAQLHandler must resolve ChallengeStore and DangerZoneEnforcer lazily
 * from the active HTTP session child container, while stdio/background
 * contexts continue to fall back to the root container.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createHttpTestEnvironment,
  connectHttpClient,
  create,
  type HttpTestEnvironment,
  type HttpClientHandle,
} from '../../../helpers/httpTransportHelper.js';
import type { IChallengeStore } from '../../../../src/state/IChallengeStore.js';
import type { SessionContainerRegistry } from '../../../../src/di/SessionContainerRegistry.js';
import type { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';
import type { DangerZoneEnforcer } from '../../../../src/security/DangerZoneEnforcer.js';

const ENV_STARTUP_TIMEOUT = 20_000;
const TEST_TIMEOUT = 45_000;

const USER_A = 'alice';
const USER_B = 'bob';

describe('challengestore-cross-user-leak: ChallengeStore and DangerZoneEnforcer are session-scoped', () => {
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

  it('HTTP child containers resolve distinct ChallengeStore instances', () => {
    const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
    const childA = registry.get(env.sessionContexts[0].sessionId);
    const childB = registry.get(env.sessionContexts[1].sessionId);

    expect(childA).toBeDefined();
    expect(childB).toBeDefined();

    const rootStore = env.container.resolve<IChallengeStore>('ChallengeStore');
    const storeA = childA!.resolve<IChallengeStore>('ChallengeStore');
    const storeB = childB!.resolve<IChallengeStore>('ChallengeStore');

    expect(storeA).not.toBe(rootStore);
    expect(storeB).not.toBe(rootStore);
    expect(storeA).not.toBe(storeB);
  });

  it('challenge injected for session A is not visible to session B via MCPAQLHandler', async () => {
    const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
    const childA = registry.get(env.sessionContexts[0].sessionId);
    expect(childA).toBeDefined();

    const store = childA!.resolve<IChallengeStore>('ChallengeStore');
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
    const result = await create(handleB.client, {
      operation: 'verify_challenge',
      params: {
        challenge_id: challengeId,
        code,
      },
    });

    console.log('[challengestore] Bob verify result:', result);

    expect(result).toMatch(/not found|expired|failed|error/i);
  }, TEST_TIMEOUT);

  it('MCPAQLHandler lazy getters resolve active session services and root fallback', async () => {
    const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
    const contextTracker = env.container.resolve<ContextTracker>('ContextTracker');
    const mcpAqlHandler = env.container.resolve<{
      handlers: {
        verificationStore?: IChallengeStore;
        dangerZoneEnforcer?: DangerZoneEnforcer;
      };
    }>('mcpAqlHandler');

    const rootStore = env.container.resolve<IChallengeStore>('ChallengeStore');
    const rootEnforcer = env.container.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');
    const childA = registry.get(env.sessionContexts[0].sessionId);
    const childB = registry.get(env.sessionContexts[1].sessionId);

    expect(mcpAqlHandler.handlers.verificationStore).toBe(rootStore);
    expect(mcpAqlHandler.handlers.dangerZoneEnforcer).toBe(rootEnforcer);

    await contextTracker.runAsync(
      contextTracker.createSessionContext('llm-request', env.sessionContexts[0], { toolName: 'mcp_aql_execute' }),
      async () => {
        expect(mcpAqlHandler.handlers.verificationStore).toBe(childA!.resolve<IChallengeStore>('ChallengeStore'));
        expect(mcpAqlHandler.handlers.dangerZoneEnforcer).toBe(childA!.resolve<DangerZoneEnforcer>('DangerZoneEnforcer'));
      },
    );

    await contextTracker.runAsync(
      contextTracker.createSessionContext('llm-request', env.sessionContexts[1], { toolName: 'mcp_aql_execute' }),
      async () => {
        expect(mcpAqlHandler.handlers.verificationStore).toBe(childB!.resolve<IChallengeStore>('ChallengeStore'));
        expect(mcpAqlHandler.handlers.dangerZoneEnforcer).toBe(childB!.resolve<DangerZoneEnforcer>('DangerZoneEnforcer'));
      },
    );
  });

  it('beetlejuice uses session-scoped ChallengeStore and DangerZoneEnforcer', async () => {
    const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
    const childA = registry.get(env.sessionContexts[0].sessionId);
    const childB = registry.get(env.sessionContexts[1].sessionId);
    expect(childA).toBeDefined();
    expect(childB).toBeDefined();

    const triggerText = await create(handleA.client, {
      operation: 'beetlejuice_beetlejuice_beetlejuice',
      params: { agent_name: 'session-a-danger-agent' },
    });
    const trigger = JSON.parse(triggerText) as { success?: boolean; data?: { challenge_id?: string } };
    const challengeId = trigger.data?.challenge_id;
    expect(challengeId).toBeTruthy();

    const storeA = childA!.resolve<IChallengeStore>('ChallengeStore');
    const storeB = childB!.resolve<IChallengeStore>('ChallengeStore');
    const enforcerA = childA!.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');
    const enforcerB = childB!.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');

    expect(storeA.get(challengeId!)).toBeDefined();
    expect(storeB.get(challengeId!)).toBeUndefined();
    expect(enforcerA.check('session-a-danger-agent').blocked).toBe(true);
    expect(enforcerB.check('session-a-danger-agent').blocked).toBe(false);
  }, TEST_TIMEOUT);
});
