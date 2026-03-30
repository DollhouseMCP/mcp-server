/**
 * Tests for PageEventDispatcher — the server-side event classifier
 * that enables element-driven web pages.
 *
 * Covers: event classification, debounce batching, long-poll delivery,
 * queue management, agent resolution, timeout handling, resource cleanup.
 *
 * @see https://github.com/DollhouseMCP/mcp-server/issues/1714
 */

import { jest } from '@jest/globals';
import {
  PageEventDispatcher,
  type PageEvent,
  type DispatchConfig,
} from '../../../src/web/PageEventDispatcher.js';

// ── Mock MCPAQLHandler ──────────────────────────────────────────────────────

function createMockHandler(overrides?: Record<string, unknown>) {
  return {
    handleRead: jest.fn().mockResolvedValue([{ success: true, data: '' }]),
    handleCreate: jest.fn().mockResolvedValue([{ success: true, data: {} }]),
    handleExecute: jest.fn().mockResolvedValue([{ success: true, data: {} }]),
    ...overrides,
  } as any;
}

function createEvent(overrides?: Partial<PageEvent>): PageEvent {
  return {
    template: 'test-page',
    event: 'chat-message',
    target: 'chat-input',
    data: { message: 'hello' },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PageEventDispatcher', () => {
  let handler: ReturnType<typeof createMockHandler>;
  let broadcast: jest.Mock;
  let dispatcher: PageEventDispatcher;

  beforeEach(() => {
    jest.useFakeTimers();
    handler = createMockHandler();
    broadcast = jest.fn();
    dispatcher = new PageEventDispatcher(handler, broadcast);
  });

  afterEach(() => {
    dispatcher.dispose();
    jest.useRealTimers();
  });

  // ── Event Classification ────────────────────────────────────────────────

  describe('Event Classification', () => {
    it('should classify chat-message as wake event by default', async () => {
      const result = await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'test-agent' }));
      expect(result.disposition).toBe('queued');
      expect(result.agentName).toBe('test-agent');
    });

    it('should classify form-submit as wake event by default', async () => {
      const result = await dispatcher.dispatch(createEvent({ event: 'form-submit', agentName: 'test-agent' }));
      expect(result.disposition).toBe('queued');
    });

    it('should classify search as wake event by default', async () => {
      const result = await dispatcher.dispatch(createEvent({ event: 'search', agentName: 'test-agent' }));
      expect(result.disposition).toBe('queued');
    });

    it('should classify scroll as background event by default', async () => {
      const result = await dispatcher.dispatch(createEvent({ event: 'scroll', agentName: 'test-agent' }));
      expect(result.disposition).toBe('background');
    });

    it('should classify hover as background event by default', async () => {
      const result = await dispatcher.dispatch(createEvent({ event: 'hover', agentName: 'test-agent' }));
      expect(result.disposition).toBe('background');
    });

    it('should classify unknown events as background when not in wake set', async () => {
      // Default config has specific wake events (chat-message, form-submit, search, command)
      // Events not in the wake set and not in the background set are background
      const result = await dispatcher.dispatch(createEvent({ event: 'custom-action', agentName: 'test-agent' }));
      expect(result.disposition).toBe('background');
    });

    it('should classify command as wake event by default', async () => {
      const result = await dispatcher.dispatch(createEvent({ event: 'command', agentName: 'test-agent' }));
      expect(result.disposition).toBe('queued');
    });

    it('should use custom config when provided', async () => {
      const customDispatcher = new PageEventDispatcher(handler, broadcast, {
        wakeEvents: new Set(['special-event']),
        backgroundEvents: new Set([]),
        debounceMs: 100,
      });
      const result = await customDispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'test-agent' }));
      // chat-message is NOT in the custom wake set, and background is empty, so it's background
      expect(result.disposition).toBe('background');
      customDispatcher.dispose();
    });
  });

  // ── Debounce Batching ───────────────────────────────────────────────────

  describe('Debounce Batching', () => {
    it('should batch rapid events into a single flush', async () => {
      // Dispatch 3 events rapidly
      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'agent-a', data: { msg: '1' } }));
      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'agent-a', data: { msg: '2' } }));
      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'agent-a', data: { msg: '3' } }));

      // Not flushed yet (within debounce window)
      expect(handler.handleExecute).not.toHaveBeenCalled();

      // Advance past debounce window
      jest.advanceTimersByTime(600);
      // Allow async flush to complete
      await jest.runAllTimersAsync();

      // Should have flushed once with continue_execution
      expect(handler.handleExecute).toHaveBeenCalledTimes(1);
      const callArgs = handler.handleExecute.mock.calls[0][0];
      expect(callArgs.operation).toBe('continue_execution');
      expect(callArgs.params.parameters.eventCount).toBe(3);
    });

    it('should keep separate debounce timers per agent', async () => {
      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'agent-a' }));
      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'agent-b' }));

      jest.advanceTimersByTime(600);
      await jest.runAllTimersAsync();

      // Both agents should have been flushed
      expect(handler.handleExecute).toHaveBeenCalledTimes(2);
    });

    it('should reset debounce timer on new event', async () => {
      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'agent-a' }));

      // Advance 400ms (before 500ms debounce)
      jest.advanceTimersByTime(400);
      expect(handler.handleExecute).not.toHaveBeenCalled();

      // Send another event — resets the timer
      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'agent-a' }));

      // Advance another 400ms (800ms total, but only 400ms since reset)
      jest.advanceTimersByTime(400);
      expect(handler.handleExecute).not.toHaveBeenCalled();

      // Advance past the reset debounce
      jest.advanceTimersByTime(200);
      await jest.runAllTimersAsync();
      expect(handler.handleExecute).toHaveBeenCalledTimes(1);
    });
  });

  // ── Long-Poll Delivery ──────────────────────────────────────────────────

  describe('Long-Poll Delivery (waitForEvents)', () => {
    it('should resolve when events are dispatched', async () => {
      const waitPromise = dispatcher.waitForEvents('test-agent', 5000);

      // Dispatch an event
      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'test-agent' }));

      // Advance past debounce
      jest.advanceTimersByTime(600);
      await jest.runAllTimersAsync();

      const events = await waitPromise;
      expect(events.length).toBe(1);
      expect(events[0].event).toBe('chat-message');
    });

    it('should return empty array on timeout', async () => {
      const waitPromise = dispatcher.waitForEvents('test-agent', 1000);

      // Advance past timeout
      jest.advanceTimersByTime(1100);

      const events = await waitPromise;
      expect(events).toEqual([]);
    });

    it('should deliver to waiter instead of calling continue_execution', async () => {
      const waitPromise = dispatcher.waitForEvents('test-agent', 5000);

      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'test-agent' }));

      jest.advanceTimersByTime(600);
      await jest.runAllTimersAsync();

      await waitPromise;

      // continue_execution should NOT have been called — events went to the waiter
      expect(handler.handleExecute).not.toHaveBeenCalled();
    });

    it('should return existing queued events immediately', async () => {
      // Queue events first (before setting up the waiter)
      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'test-agent' }));

      // Now wait — should get the already-queued events immediately
      // Need to advance past debounce first so events are in the queue
      // Actually, events go into pendingWakeEvents immediately, waitForEvents checks that
      const events = await dispatcher.waitForEvents('test-agent', 5000);
      expect(events.length).toBe(1);
    });

    it('should snap timeout to allowed values', async () => {
      // Request 7000ms — should snap to 5000ms
      const waitPromise = dispatcher.waitForEvents('test-agent', 7000);

      // Advance 5100ms — past the snapped timeout of 5000ms
      jest.advanceTimersByTime(5100);

      const events = await waitPromise;
      expect(events).toEqual([]);
    });

    it('should cancel old waiter when new wait is called for same agent', async () => {
      const wait1 = dispatcher.waitForEvents('test-agent', 5000);
      const wait2 = dispatcher.waitForEvents('test-agent', 5000);

      // First waiter should resolve with empty (cancelled)
      const events1 = await wait1;
      expect(events1).toEqual([]);

      // Second waiter is still active
      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'test-agent' }));
      jest.advanceTimersByTime(600);
      await jest.runAllTimersAsync();

      const events2 = await wait2;
      expect(events2.length).toBe(1);
    });
  });

  // ── Queue Management ────────────────────────────────────────────────────

  describe('Queue Management', () => {
    it('should drop oldest events when queue exceeds MAX_QUEUE_SIZE', async () => {
      // Dispatch 105 events (limit is 100)
      for (let i = 0; i < 105; i++) {
        await dispatcher.dispatch(createEvent({
          event: 'chat-message',
          agentName: 'test-agent',
          data: { index: i },
        }));
      }

      // Set up waiter and flush
      const waitPromise = dispatcher.waitForEvents('test-agent', 5000);
      // Events should already be available (queued before waiter)
      const events = await waitPromise;

      // Should have 100 events (5 oldest dropped)
      expect(events.length).toBe(100);
      // First event should be index 5 (0-4 were dropped)
      expect((events[0].data as any).index).toBe(5);
    });
  });

  // ── SSE Broadcast ───────────────────────────────────────────────────────

  describe('SSE Broadcast', () => {
    it('should broadcast for both wake and background events', async () => {
      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'test-agent' }));
      expect(broadcast).toHaveBeenCalledTimes(1);

      await dispatcher.dispatch(createEvent({ event: 'scroll', agentName: 'test-agent' }));
      expect(broadcast).toHaveBeenCalledTimes(2);
    });

    it('should broadcast even when no agent is bound', async () => {
      await dispatcher.dispatch(createEvent({ event: 'chat-message' }));
      expect(broadcast).toHaveBeenCalledTimes(1);
    });

    it('should include event details in broadcast', async () => {
      await dispatcher.dispatch(createEvent({
        event: 'chat-message',
        template: 'my-page',
        data: { message: 'hello' },
      }));

      expect(broadcast).toHaveBeenCalledWith(
        'my-page',
        expect.objectContaining({
          type: 'agent-notification',
          template: 'my-page',
        }),
      );
    });
  });

  // ── No Agent Bound ──────────────────────────────────────────────────────

  describe('No Agent Bound', () => {
    it('should fall back to background when no agent name provided and no ensemble match', async () => {
      const result = await dispatcher.dispatch(createEvent({ agentName: undefined }));
      expect(result.disposition).toBe('background');
      expect(result.agentName).toBeUndefined();
    });

    it('should attempt memory write for unbound events', async () => {
      await dispatcher.dispatch(createEvent({ agentName: undefined }));
      expect(handler.handleCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'addEntry',
          params: expect.objectContaining({
            element_name: 'page-events',
          }),
        }),
      );
    });

    it('should not fail if memory write fails', async () => {
      handler.handleCreate.mockRejectedValue(new Error('Memory not found'));
      const result = await dispatcher.dispatch(createEvent({ agentName: undefined }));
      expect(result.accepted).toBe(true);
    });
  });

  // ── Flush Fallback ──────────────────────────────────────────────────────

  describe('Flush Error Handling', () => {
    it('should fall back to memory when continue_execution fails', async () => {
      handler.handleExecute.mockRejectedValue(new Error('Agent not executing'));

      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'test-agent' }));

      jest.advanceTimersByTime(600);
      await jest.runAllTimersAsync();

      // Should have attempted continue_execution
      expect(handler.handleExecute).toHaveBeenCalled();
      // Should have fallen back to memory write
      expect(handler.handleCreate).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'addEntry' }),
      );
    });
  });

  // ── Resource Cleanup ────────────────────────────────────────────────────

  describe('Resource Cleanup', () => {
    it('should clear all timers on dispose', async () => {
      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'agent-a' }));
      await dispatcher.dispatch(createEvent({ event: 'chat-message', agentName: 'agent-b' }));
      dispatcher.waitForEvents('agent-c', 5000);

      dispatcher.dispose();

      // Advance time — no flushes should happen
      jest.advanceTimersByTime(10000);
      await jest.runAllTimersAsync();

      expect(handler.handleExecute).not.toHaveBeenCalled();
    });

    it('should resolve pending waiters with empty on dispose', async () => {
      const waitPromise = dispatcher.waitForEvents('test-agent', 5000);

      dispatcher.dispose();

      const events = await waitPromise;
      expect(events).toEqual([]);
    });
  });

  // ── Agent Resolution Caching ────────────────────────────────────────────

  describe('Agent Resolution', () => {
    it('should use explicit agent name when provided', async () => {
      const result = await dispatcher.dispatch(createEvent({ agentName: 'my-agent' }));
      expect(result.agentName).toBe('my-agent');
      // Should not have called handleRead for ensemble lookup
      expect(handler.handleRead).not.toHaveBeenCalled();
    });

    it('should cache agent resolution results', async () => {
      // First dispatch triggers ensemble lookup
      await dispatcher.dispatch(createEvent({ agentName: undefined }));
      const readCount1 = handler.handleRead.mock.calls.length;

      // Second dispatch for same template should use cache
      await dispatcher.dispatch(createEvent({ agentName: undefined }));
      const readCount2 = handler.handleRead.mock.calls.length;

      // No additional reads for the cached template
      expect(readCount2).toBe(readCount1);
    });
  });
});
