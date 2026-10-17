import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { SseStallWatcher } from '../../../src/server/http/SseStallWatcher.js';

function response() {
  const emitter = new EventEmitter();
  const state = Object.assign(emitter, {
    headersSent: true, statusCode: 200, writableEnded: false, destroyed: false, writableNeedDrain: false,
    contentType: 'text/event-stream; charset=utf-8',
    getHeader: () => state.contentType,
    write: jest.fn((_chunk: unknown) => true),
    end: jest.fn((_chunk?: unknown) => state),
    destroy: jest.fn(() => { state.destroyed = true; state.emit('close'); return state; }),
  });
  return { state, res: state as unknown as ServerResponse };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe('SSE stall watcher', () => {
  it.each(['headersSent', 'statusCode', 'contentType', 'writableEnded', 'destroyed'] as const)('gates %s at attach and every tick', field => {
    const { state, res } = response();
    const invalid = { headersSent: false, statusCode: 409, contentType: 'application/json', writableEnded: true, destroyed: true };
    const original = state[field];
    Object.assign(state, { [field]: invalid[field] });
    new SseStallWatcher(10).attach(res);
    expect(jest.getTimerCount()).toBe(0);
    Object.assign(state, { [field]: original });
    new SseStallWatcher(10).attach(res);
    jest.advanceTimersByTime(10);
    expect(state.write).not.toHaveBeenCalled();
    Object.assign(state, { [field]: invalid[field] });
    jest.advanceTimersByTime(10);
    expect(state.write).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('is disabled at zero and destroys a persistently stalled response after three intervals', () => {
    const { state, res } = response();
    new SseStallWatcher(0).attach(res);
    expect(jest.getTimerCount()).toBe(0);
    new SseStallWatcher(10).attach(res);
    state.writableNeedDrain = true;
    jest.advanceTimersByTime(20);
    expect(state.destroyed).toBe(false);
    jest.advanceTimersByTime(10);
    expect(state.destroyed).toBe(true);
    expect(state.write).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('recovers drain and removes only its own observers on repeated termination', () => {
    const { state, res } = response();
    const sdkClose = jest.fn(); state.on('close', sdkClose);
    const stop = new SseStallWatcher(10).attach(res);
    state.writableNeedDrain = true; jest.advanceTimersByTime(20);
    state.writableNeedDrain = false; jest.advanceTimersByTime(10);
    expect(state.write).not.toHaveBeenCalled();
    state.emit('finish'); state.emit('close'); stop();
    expect(sdkClose).toHaveBeenCalledTimes(1);
    expect(state.listenerCount('close')).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('resets consecutive stall ticks after drain', () => {
    const { state, res } = response();
    new SseStallWatcher(10).attach(res);
    state.writableNeedDrain = true; jest.advanceTimersByTime(20);
    state.writableNeedDrain = false; jest.advanceTimersByTime(10);
    state.writableNeedDrain = true; jest.advanceTimersByTime(20);
    expect(state.destroyed).toBe(false);
    jest.advanceTimersByTime(10);
    expect(state.destroyed).toBe(true);
    expect(state.write).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['close', 'finish', 'error'])('stops on %s without writing', event => {
    const { state, res } = response();
    new SseStallWatcher(10).attach(res);
    state.emit(event);
    jest.advanceTimersByTime(100);
    expect(state.write).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
