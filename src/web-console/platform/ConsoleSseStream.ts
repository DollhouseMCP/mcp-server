import type { Request, Response } from 'express';

import type { ConsoleRequest, ConsoleSseEvent, ConsoleStreamPolicy } from './ConsolePlatformTypes.js';

export const DEFAULT_CONSOLE_STREAM_POLICY: ConsoleStreamPolicy = Object.freeze({
  lastEventId: 'bounded',
  heartbeatMs: 15_000,
  revalidateMs: 15_000,
  maxLifetimeMs: 15 * 60_000,
  backpressureDrainTimeoutMs: 30_000,
  maxEventBytes: 64 * 1024,
  maxLastEventIdBytes: 512,
});

export interface ConsoleSseSendOptions {
  readonly request?: Request;
  readonly policy?: ConsoleStreamPolicy;
  readonly projectEvent?: (event: ConsoleSseEvent) => ConsoleSseEvent;
  readonly revalidate?: () => Promise<boolean>;
  readonly reportStreamError?: (error: unknown) => void;
  readonly now?: () => Date;
}

export interface ConsoleLastEventIdParseResult {
  readonly ok: boolean;
  readonly value: string | null;
  readonly reason?: 'unsupported' | 'too_large' | 'invalid';
}

export function parseConsoleLastEventId(
  req: ConsoleRequest,
  policy: ConsoleStreamPolicy = DEFAULT_CONSOLE_STREAM_POLICY,
): ConsoleLastEventIdParseResult {
  const header = req.headers['last-event-id'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return { ok: true, value: null };
  if (policy.lastEventId === 'unsupported') return { ok: false, value: null, reason: 'unsupported' };
  if (Buffer.byteLength(value, 'utf8') > policy.maxLastEventIdBytes) {
    return { ok: false, value: null, reason: 'too_large' };
  }
  if (!isSafeSseLineValue(value)) return { ok: false, value: null, reason: 'invalid' };
  return { ok: true, value };
}

export async function sendConsoleSseStream(
  response: Response,
  stream: AsyncIterable<ConsoleSseEvent>,
  init: unknown,
  options: ConsoleSseSendOptions = {},
): Promise<void> {
  const policy = options.policy ?? DEFAULT_CONSOLE_STREAM_POLICY;
  const abortController = createAbortController(response, options.request);
  const abortSignal = abortController.signal;
  let heartbeat: NodeJS.Timeout | null = null;
  let revalidation: NodeJS.Timeout | null = null;
  let maxLifetime: NodeJS.Timeout | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();

  const writeRaw = (chunk: string): Promise<boolean> => {
    const write = writeChain.then(
      () => writeSseChunk(response, chunk, abortSignal, policy.backpressureDrainTimeoutMs),
      () => writeSseChunk(response, chunk, abortSignal, policy.backpressureDrainTimeoutMs),
    );
    writeChain = write.then(() => {}, () => {});
    return write;
  };

  const writeEvent = (event: ConsoleSseEvent): Promise<boolean> => {
    if (abortSignal.aborted) return Promise.resolve(false);
    return writeRaw(serializeConsoleSseEvent(projectEvent(event, options.projectEvent), policy));
  };
  const iterator = stream[Symbol.asyncIterator]();

  try {
    await writeEvent({
      event: 'init',
      data: createInitData(init, options.now ?? (() => new Date())),
    });
    heartbeat = startHeartbeat(writeRaw, abortController, policy, options);
    revalidation = startRevalidation(response, abortController, writeEvent, policy, options);
    maxLifetime = startMaxLifetime(response, abortController, writeEvent, policy, options);
    while (!abortSignal.aborted) {
      const next = await nextSseEvent(iterator, abortSignal);
      if (next.done) break;
      const event = next.value;
      await writeEvent(event);
      if (event.event === 'error' || event.event === 'end') break;
    }
  } catch (error) {
    options.reportStreamError?.(error);
    if (!abortSignal.aborted) await writeTerminalError(writeEvent, abortSignal);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (revalidation) clearInterval(revalidation);
    if (maxLifetime) clearTimeout(maxLifetime);
    abortController.abort();
    void iterator.return?.();
    await writeChain;
    if (!response.writableEnded) response.end();
  }
}

function createInitData(init: unknown, now: () => Date): unknown {
  const connectedAt = now().toISOString();
  if (init === undefined) return { connected_at: connectedAt };
  if (init && typeof init === 'object' && !Array.isArray(init)) {
    return { connected_at: connectedAt, ...init };
  }
  return { connected_at: connectedAt, value: init };
}

export function serializeConsoleSseEvent(
  event: ConsoleSseEvent,
  policy: ConsoleStreamPolicy = DEFAULT_CONSOLE_STREAM_POLICY,
): string {
  validateSseEvent(event, policy);
  const lines: string[] = [];
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  lines.push(`event: ${event.event}`);
  if (event.data !== undefined) {
    for (const line of JSON.stringify(event.data).split('\n')) {
      lines.push(`data: ${line}`);
    }
  }
  lines.push('', '');
  return lines.join('\n');
}

function validateSseEvent(event: ConsoleSseEvent, policy: ConsoleStreamPolicy): void {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(event.event)) {
    throw new Error('Console SSE event has an invalid event name');
  }
  if (event.id !== undefined && !isSafeSseLineValue(event.id)) {
    throw new Error('Console SSE event has an invalid id');
  }
  const serializedData = event.data === undefined ? '' : JSON.stringify(event.data);
  if (typeof serializedData !== 'string') {
    throw new TypeError('Console SSE event data is not JSON serializable');
  }
  if (Buffer.byteLength(serializedData, 'utf8') > policy.maxEventBytes) {
    throw new Error('Console SSE event exceeds the configured byte limit');
  }
}

function projectEvent(
  event: ConsoleSseEvent,
  projector: ConsoleSseSendOptions['projectEvent'],
): ConsoleSseEvent {
  return projector ? projector(event) : event;
}

function isSafeSseLineValue(value: string): boolean {
  return value.length > 0 && /^[\t\x20-\x7E]+$/.test(value) && !/[\r\n]/.test(value);
}

function startHeartbeat(
  writeRaw: (chunk: string) => Promise<boolean>,
  abortController: AbortController,
  policy: ConsoleStreamPolicy,
  options: ConsoleSseSendOptions,
): NodeJS.Timeout | null {
  if (policy.heartbeatMs <= 0) return null;
  let inFlight = false;
  const heartbeat = setInterval(() => {
    if (abortController.signal.aborted || inFlight) return;
    inFlight = true;
    void writeRaw(':hb\n\n')
      .catch(error => {
        options.reportStreamError?.(error);
        abortController.abort();
      })
      .finally(() => {
        inFlight = false;
      });
  }, policy.heartbeatMs);
  heartbeat.unref();
  return heartbeat;
}

function startRevalidation(
  response: Response,
  abortController: AbortController,
  writeEvent: (event: ConsoleSseEvent) => Promise<boolean>,
  policy: ConsoleStreamPolicy,
  options: ConsoleSseSendOptions,
): NodeJS.Timeout | null {
  if (!options.revalidate) return null;
  let inFlight = false;
  const revalidation = setInterval(() => {
    if (abortController.signal.aborted || inFlight) return;
    inFlight = true;
    void options.revalidate?.()
      .then(async valid => {
        if (!valid && !abortController.signal.aborted) {
          await writeEvent({
            event: 'error',
            data: {
              code: 'unauthenticated',
              detail: 'The stream authorization is no longer valid.',
            },
          });
          abortController.abort();
          response.end();
        }
      })
      .catch(error => {
        options.reportStreamError?.(error);
        abortController.abort();
        response.end();
      })
      .finally(() => {
        inFlight = false;
      });
  }, policy.revalidateMs);
  revalidation.unref();
  return revalidation;
}

function startMaxLifetime(
  response: Response,
  abortController: AbortController,
  writeEvent: (event: ConsoleSseEvent) => Promise<boolean>,
  policy: ConsoleStreamPolicy,
  options: ConsoleSseSendOptions,
): NodeJS.Timeout | null {
  if (policy.maxLifetimeMs <= 0) return null;
  const maxLifetime = setTimeout(() => {
    if (abortController.signal.aborted) return;
    void writeEvent({
      event: 'end',
      data: {
        status: 'closed',
        reason: 'max_lifetime',
      },
    })
      .catch(error => {
        options.reportStreamError?.(error);
      })
      .finally(() => {
        abortController.abort();
        response.end();
      });
  }, policy.maxLifetimeMs);
  maxLifetime.unref();
  return maxLifetime;
}

async function writeTerminalError(
  writeEvent: (event: ConsoleSseEvent) => Promise<boolean>,
  abortSignal: AbortSignal,
): Promise<void> {
  if (abortSignal.aborted) return;
  try {
    await writeEvent({
      event: 'error',
      data: {
        code: 'stream_error',
        detail: 'The stream could not continue.',
      },
    });
  } catch {
    // The stream is already failing; closing it is the stable fallback.
  }
}

async function nextSseEvent(
  iterator: AsyncIterator<ConsoleSseEvent>,
  abortSignal: AbortSignal,
): Promise<IteratorResult<ConsoleSseEvent>> {
  if (abortSignal.aborted) return { done: true, value: undefined };
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve({ done: true, value: undefined });
    abortSignal.addEventListener('abort', onAbort, { once: true });
    void iterator.next()
      .then(result => {
        abortSignal.removeEventListener('abort', onAbort);
        resolve(result);
      })
      .catch(error => {
        abortSignal.removeEventListener('abort', onAbort);
        reject(error);
      });
  });
}

async function writeSseChunk(
  response: Response,
  chunk: string,
  abortSignal: AbortSignal,
  drainTimeoutMs: number,
): Promise<boolean> {
  if (abortSignal.aborted || response.writableEnded) return false;
  const accepted = response.write(chunk);
  if (accepted && !responseNeedsDrain(response)) return true;
  await waitForResponseDrain(response, abortSignal, drainTimeoutMs);
  return streamStillWritable(response, abortSignal);
}

function streamStillWritable(response: Response, abortSignal: AbortSignal): boolean {
  return !abortSignal.aborted && !response.writableEnded;
}

function responseNeedsDrain(response: Response): boolean {
  const writable = response as Response & {
    readonly writableNeedDrain?: boolean;
    readonly writableNeedsDrain?: boolean;
  };
  return writable.writableNeedDrain === true || writable.writableNeedsDrain === true;
}

function waitForResponseDrain(
  response: Response,
  abortSignal: AbortSignal,
  drainTimeoutMs: number,
): Promise<void> {
  if (abortSignal.aborted || response.writableEnded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    const cleanup = (): void => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
      abortSignal.removeEventListener('abort', onAbort);
      if (timeout) clearTimeout(timeout);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    abortSignal.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Console SSE backpressure drain timed out'));
    }, drainTimeoutMs);
    timeout.unref();
  });
}

function createAbortController(response: Response, request?: Request): AbortController {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  response.once('close', abort);
  response.once('error', abort);
  request?.once('aborted', abort);
  return controller;
}
