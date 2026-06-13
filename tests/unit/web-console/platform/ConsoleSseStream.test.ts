import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Response } from 'express';

import {
  DEFAULT_CONSOLE_STREAM_POLICY,
  parseConsoleLastEventId,
  sendConsoleSseStream,
  serializeConsoleSseEvent,
  type ConsoleRequest,
  type ConsoleSseEvent,
} from '../../../../src/web-console/index.js';

const NOW = new Date('2026-05-29T12:00:00.000Z');

describe('ConsoleSseStream', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('parses bounded Last-Event-ID headers without accepting control characters', () => {
    expect(parseConsoleLastEventId(requestWithLastEventId('event-7'))).toEqual({
      ok: true,
      value: 'event-7',
    });
    expect(parseConsoleLastEventId(requestWithLastEventId('event\n7'))).toEqual({
      ok: false,
      value: null,
      reason: 'invalid',
    });
    expect(parseConsoleLastEventId(requestWithLastEventId('x'.repeat(513)))).toEqual({
      ok: false,
      value: null,
      reason: 'too_large',
    });
    expect(parseConsoleLastEventId(requestWithLastEventId('event-7'), {
      ...DEFAULT_CONSOLE_STREAM_POLICY,
      lastEventId: 'unsupported',
    })).toEqual({
      ok: false,
      value: null,
      reason: 'unsupported',
    });
  });

  it('serializes JSON SSE events and rejects unsafe names, ids, and oversized payloads', () => {
    expect(serializeConsoleSseEvent({
      id: 'event-1',
      event: 'update',
      data: { ok: true },
    })).toBe('id: event-1\nevent: update\ndata: {"ok":true}\n\n');

    expect(() => serializeConsoleSseEvent({ event: 'BadEvent' })).toThrow('invalid event name');
    expect(() => serializeConsoleSseEvent({ id: 'bad\nid', event: 'update' })).toThrow('invalid id');
    expect(() => serializeConsoleSseEvent({
      event: 'update',
      data: { value: 'x'.repeat(20) },
    }, {
      ...DEFAULT_CONSOLE_STREAM_POLICY,
      maxEventBytes: 8,
    })).toThrow('byte limit');
  });

  it('keeps embedded newlines inside JSON data rather than allowing frame injection', () => {
    const serialized = serializeConsoleSseEvent({
      event: 'update',
      data: { message: 'first\n\nevent: error\ndata: {"code":"injected"}' },
    });

    expect(serialized).toContain(String.raw`data: {"message":"first\n\nevent: error\ndata: {\"code\":\"injected\"}"}`);
    expect(serialized).not.toContain('\n\nevent: error\n');
  });

  it('writes init/update/end events and closes finite streams without retaining timers', async () => {
    const response = fakeResponse();

    await sendConsoleSseStream(
      response,
      sseEvents([
        { id: 'event-1', event: 'update', data: { item: 1 } },
        { event: 'end', data: { reason: 'complete' } },
        { event: 'update', data: { item: 2 } },
      ]),
      { route: 'logs' },
      {
        now: () => NOW,
        policy: {
          ...DEFAULT_CONSOLE_STREAM_POLICY,
          heartbeatMs: 60_000,
        },
      },
    );

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(response.flushHeaders).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.writes.join('')).toContain('event: init\ndata: {"connected_at":"2026-05-29T12:00:00.000Z","route":"logs"}');
    expect(response.writes.join('')).toContain('id: event-1\nevent: update\ndata: {"item":1}');
    expect(response.writes.join('')).toContain('event: end\ndata: {"reason":"complete"}');
    expect(response.writes.join('')).not.toContain('"item":2');
  });

  it('stops after terminal error events', async () => {
    const response = fakeResponse();

    await sendConsoleSseStream(
      response,
      sseEvents([
        { event: 'error', data: { code: 'failed' } },
        { event: 'update', data: { item: 2 } },
      ]),
      undefined,
      { now: () => NOW, policy: { ...DEFAULT_CONSOLE_STREAM_POLICY, heartbeatMs: 60_000 } },
    );

    expect(response.writes.join('')).toContain('event: error\ndata: {"code":"failed"}');
    expect(response.writes.join('')).not.toContain('"item":2');
  });

  it('waits for response drain before writing additional stream events', async () => {
    const response = fakeResponse({
      writeResult: chunk => !chunk.includes('"item":1'),
    });

    const stream = sendConsoleSseStream(
      response,
      sseEvents([
        { event: 'update', data: { item: 1 } },
        { event: 'update', data: { item: 2 } },
        { event: 'end', data: { status: 'complete' } },
      ]),
      undefined,
      {
        now: () => NOW,
        policy: {
          ...DEFAULT_CONSOLE_STREAM_POLICY,
          heartbeatMs: 60_000,
          backpressureDrainTimeoutMs: 60_000,
        },
      },
    );

    await new Promise(resolve => setImmediate(resolve));
    expect(response.writes.join('')).toContain('"item":1');
    expect(response.writes.join('')).not.toContain('"item":2');

    response.emit('drain');
    await stream;
    expect(response.writes.join('')).toContain('"item":2');
    expect(response.writes.join('')).toContain('event: end');
  });

  it('reports and closes when response backpressure does not drain', async () => {
    jest.useFakeTimers();
    const response = fakeResponse({ writeResult: chunk => !chunk.includes('"item":1') });
    const reportStreamError = jest.fn();
    const stream = sendConsoleSseStream(
      response,
      sseEvents([
        { event: 'update', data: { item: 1 } },
        { event: 'update', data: { item: 2 } },
      ]),
      undefined,
      {
        now: () => NOW,
        reportStreamError,
        policy: {
          ...DEFAULT_CONSOLE_STREAM_POLICY,
          heartbeatMs: 60_000,
          backpressureDrainTimeoutMs: 10,
        },
      },
    );

    await jest.advanceTimersByTimeAsync(10);
    await stream;

    expect(reportStreamError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Console SSE backpressure drain timed out',
    }));
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.writes.join('')).not.toContain('"item":2');
  });

  it('stops writing when the request aborts', async () => {
    const response = fakeResponse();
    const request = new EventEmitter() as ConsoleRequest;
    let yielded = 0;

    await sendConsoleSseStream(response, abortingEvents(request, () => {
      yielded += 1;
    }), undefined, {
      request,
      now: () => NOW,
      policy: {
        ...DEFAULT_CONSOLE_STREAM_POLICY,
        heartbeatMs: 60_000,
      },
    });

    expect(yielded).toBe(1);
    expect(response.writes.join('')).toContain('"first":true');
    expect(response.writes.join('')).not.toContain('"second":true');
  });

  it('stops writing when the response closes or errors', async () => {
    const closedResponse = fakeResponse();
    await sendConsoleSseStream(closedResponse, responseAbortingEvents(closedResponse, 'close'), undefined, {
      now: () => NOW,
      policy: { ...DEFAULT_CONSOLE_STREAM_POLICY, heartbeatMs: 60_000 },
    });
    expect(closedResponse.writes.join('')).toContain('event: init');
    expect(closedResponse.writes.join('')).not.toContain('"afterAbort":true');

    const erroredResponse = fakeResponse();
    await sendConsoleSseStream(erroredResponse, responseAbortingEvents(erroredResponse, 'error'), undefined, {
      now: () => NOW,
      policy: { ...DEFAULT_CONSOLE_STREAM_POLICY, heartbeatMs: 60_000 },
    });
    expect(erroredResponse.writes.join('')).toContain('event: init');
    expect(erroredResponse.writes.join('')).not.toContain('"afterAbort":true');
  });

  it('projects events before enforcing the wire byte cap', async () => {
    const response = fakeResponse();

    await sendConsoleSseStream(
      response,
      sseEvents([{ event: 'update', data: { visible: true, rawPrivate: 'x'.repeat(200) } }]),
      { visible: true, rawPrivate: 'x'.repeat(200) },
      {
        now: () => NOW,
        projectEvent: event => ({
          ...event,
          data: { visible: (event.data as { visible: boolean }).visible },
        }),
        policy: {
          ...DEFAULT_CONSOLE_STREAM_POLICY,
          heartbeatMs: 60_000,
          maxEventBytes: 32,
        },
      },
    );

    expect(response.writes.join('')).toContain('data: {"visible":true}');
    expect(response.writes.join('')).not.toContain('rawPrivate');
  });

  it('emits a terminal stream_error and reports mid-stream serialization failures', async () => {
    const response = fakeResponse();
    const reportStreamError = jest.fn();

    await sendConsoleSseStream(
      response,
      sseEvents([{ event: 'BadEvent', data: { item: 1 } }]),
      undefined,
      {
        now: () => NOW,
        reportStreamError,
        policy: { ...DEFAULT_CONSOLE_STREAM_POLICY, heartbeatMs: 60_000 },
      },
    );

    expect(reportStreamError).toHaveBeenCalledWith(expect.any(Error));
    expect(response.writes.join('')).toContain('event: error\ndata: {"code":"stream_error","detail":"The stream could not continue."}');
  });

  it('writes heartbeats and clears timers when the stream ends', async () => {
    jest.useFakeTimers();
    const response = fakeResponse();
    const stream = sendConsoleSseStream(
      response,
      delayedEvents([{ event: 'end', data: { done: true } }], 50),
      undefined,
      {
        now: () => NOW,
        policy: { ...DEFAULT_CONSOLE_STREAM_POLICY, heartbeatMs: 10, revalidateMs: 60_000 },
      },
    );

    await jest.advanceTimersByTimeAsync(25);
    expect(response.writes.join('')).toContain(':hb\n\n');
    await jest.advanceTimersByTimeAsync(50);
    await stream;
    const heartbeatWrites = response.writes.filter(write => write === ':hb\n\n').length;
    await jest.advanceTimersByTimeAsync(50);
    expect(response.writes.filter(write => write === ':hb\n\n')).toHaveLength(heartbeatWrites);
  });

  it('closes long-lived streams at the configured maximum lifetime', async () => {
    jest.useFakeTimers();
    const response = fakeResponse();
    const stream = sendConsoleSseStream(
      response,
      neverEvents(),
      undefined,
      {
        now: () => NOW,
        policy: {
          ...DEFAULT_CONSOLE_STREAM_POLICY,
          heartbeatMs: 60_000,
          revalidateMs: 60_000,
          maxLifetimeMs: 10,
        },
      },
    );

    await jest.advanceTimersByTimeAsync(10);
    await stream;

    expect(response.writes.join('')).toContain('event: end\ndata: {"status":"closed","reason":"max_lifetime"}');
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('closes the stream when periodic revalidation fails', async () => {
    jest.useFakeTimers();
    const response = fakeResponse();
    const revalidate = jest.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const stream = sendConsoleSseStream(
      response,
      delayedEvents([{ event: 'update', data: { late: true } }], 50),
      undefined,
      {
        now: () => NOW,
        revalidate,
        policy: { ...DEFAULT_CONSOLE_STREAM_POLICY, heartbeatMs: 60_000, revalidateMs: 10 },
      },
    );

    await jest.advanceTimersByTimeAsync(10);
    await jest.advanceTimersByTimeAsync(50);
    await stream;

    expect(revalidate).toHaveBeenCalled();
    expect(response.writes.join('')).toContain('event: error\ndata: {"code":"unauthenticated"');
    expect(response.writes.join('')).not.toContain('"late":true');
  });
});

function requestWithLastEventId(value: string): ConsoleRequest {
  return { headers: { 'last-event-id': value } } as ConsoleRequest;
}

async function* sseEvents(events: readonly ConsoleSseEvent[]): AsyncIterable<ConsoleSseEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

async function* abortingEvents(request: EventEmitter, onYield: () => void): AsyncIterable<ConsoleSseEvent> {
  onYield();
  await Promise.resolve();
  yield { event: 'update', data: { first: true } };
  request.emit('aborted');
  yield { event: 'update', data: { second: true } };
}

async function* responseAbortingEvents(
  response: EventEmitter,
  eventName: 'close' | 'error',
): AsyncIterable<ConsoleSseEvent> {
  response.emit(eventName, new Error('client disconnected'));
  await Promise.resolve();
  yield { event: 'update', data: { afterAbort: true } };
}

async function* delayedEvents(
  events: readonly ConsoleSseEvent[],
  delayMs: number,
): AsyncIterable<ConsoleSseEvent> {
  await new Promise(resolve => setTimeout(resolve, delayMs));
  for (const event of events) yield event;
}

function neverEvents(): AsyncIterable<ConsoleSseEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<ConsoleSseEvent>>(() => {}),
    }),
  };
}

function fakeResponse(options: {
  readonly writeResult?: (chunk: string) => boolean;
} = {}): Response & { writes: string[] } {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  let writableEnded = false;
  let writableNeedDrain = false;
  const response = Object.assign(emitter, {
    writes,
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      writes.push(chunk);
      const accepted = options.writeResult ? options.writeResult(chunk) : true;
      writableNeedDrain = !accepted;
      return accepted;
    }),
    end: jest.fn(() => {
      writableEnded = true;
      emitter.emit('close');
    }),
    emit: jest.fn((eventName: string | symbol, ...args: unknown[]) => {
      if (eventName === 'drain') writableNeedDrain = false;
      return EventEmitter.prototype.emit.call(emitter, eventName, ...args);
    }),
  }) as unknown as Response & { writes: string[] };
  Object.defineProperties(response, {
    writableEnded: {
      get: () => writableEnded,
    },
    writableNeedDrain: {
      get: () => writableNeedDrain,
    },
  });
  return response;
}
