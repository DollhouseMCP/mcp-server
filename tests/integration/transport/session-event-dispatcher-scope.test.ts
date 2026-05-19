/**
 * HTTP session ElementEventDispatcher scoping
 *
 * Session-owned listeners must only receive events from their own
 * SessionContainer dispatcher, while root observers receive cross-session
 * fan-out with explicit user/session attribution.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  createHttpTestEnvironment,
  connectHttpClient,
  type HttpTestEnvironment,
  type HttpClientHandle,
} from '../../helpers/httpTransportHelper.js';
import type { SessionContainerRegistry } from '../../../src/di/SessionContainerRegistry.js';
import { ElementEventDispatcher, type ElementEventPayload } from '../../../src/events/ElementEventDispatcher.js';
import type { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { ElementType } from '../../../src/portfolio/types.js';

const ENV_STARTUP_TIMEOUT = 20_000;

describe('HTTP session ElementEventDispatcher scoping', () => {
  let env: HttpTestEnvironment;
  let handleA: HttpClientHandle;
  let handleB: HttpClientHandle;

  beforeAll(async () => {
    env = await createHttpTestEnvironment({
      userIdSequence: ['event-user-a', 'event-user-b'],
    });
    handleA = await connectHttpClient(env.runtime);
    handleB = await connectHttpClient(env.runtime);
  }, ENV_STARTUP_TIMEOUT);

  afterAll(async () => {
    await handleA?.disconnect();
    await handleB?.disconnect();
    await env?.cleanup();
  });

  it('isolates session listeners and fans out attributed copies to root observers', async () => {
    const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
    const contextTracker = env.container.resolve<ContextTracker>('ContextTracker');
    const rootDispatcher = env.container.resolve<ElementEventDispatcher>('ElementEventDispatcher');
    const childA = registry.get(env.sessionContexts[0].sessionId);
    const childB = registry.get(env.sessionContexts[1].sessionId);

    expect(childA).toBeDefined();
    expect(childB).toBeDefined();

    const dispatcherA = childA!.resolve<ElementEventDispatcher>('ElementEventDispatcher');
    const dispatcherB = childB!.resolve<ElementEventDispatcher>('ElementEventDispatcher');

    expect(dispatcherA).not.toBe(rootDispatcher);
    expect(dispatcherB).not.toBe(rootDispatcher);
    expect(dispatcherA).not.toBe(dispatcherB);

    const seenByA: ElementEventPayload[] = [];
    const seenByB: ElementEventPayload[] = [];
    const seenByRoot: ElementEventPayload[] = [];
    const cleanup = [
      dispatcherA.on('element:activate', payload => { seenByA.push(payload); }),
      dispatcherB.on('element:activate', payload => { seenByB.push(payload); }),
      rootDispatcher.on('element:activate', payload => { seenByRoot.push(payload); }),
    ];

    try {
      await contextTracker.runAsync(
        contextTracker.createSessionContext('llm-request', env.sessionContexts[0], { toolName: 'mcp_aql_read' }),
        async () => {
          rootDispatcher.emit('element:activate', {
            correlationId: 'event-scope-a',
            elementType: ElementType.PERSONA,
            elementId: 'persona-a',
          });
        },
      );

      expect(seenByA).toHaveLength(1);
      expect(seenByB).toHaveLength(0);
      expect(seenByRoot).toHaveLength(1);
      expect(seenByA[0]).toMatchObject({
        elementId: 'persona-a',
        userId: 'event-user-a',
        sessionId: env.sessionContexts[0].sessionId,
      });
      expect(seenByRoot[0]).toMatchObject({
        elementId: 'persona-a',
        userId: 'event-user-a',
        sessionId: env.sessionContexts[0].sessionId,
      });

      dispatcherB.emit('element:activate', {
        correlationId: 'event-scope-b',
        elementType: ElementType.PERSONA,
        elementId: 'persona-b',
      });

      expect(seenByA).toHaveLength(1);
      expect(seenByB).toHaveLength(1);
      expect(seenByRoot).toHaveLength(2);
      expect(seenByB[0]).toMatchObject({
        elementId: 'persona-b',
        userId: 'event-user-b',
        sessionId: env.sessionContexts[1].sessionId,
      });
      expect(seenByRoot[1]).toMatchObject({
        elementId: 'persona-b',
        userId: 'event-user-b',
        sessionId: env.sessionContexts[1].sessionId,
      });
    } finally {
      cleanup.forEach(unsub => unsub());
    }
  });
});
