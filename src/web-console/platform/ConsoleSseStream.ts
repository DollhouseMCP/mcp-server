import type { Request, Response } from 'express';

import type { ConsoleRequest, ConsoleSseEvent, ConsoleStreamPolicy } from './ConsolePlatformTypes.js';

export const DEFAULT_CONSOLE_STREAM_POLICY: ConsoleStreamPolicy = Object.freeze({
  lastEventId: 'bounded',
  heartbeatMs: 15_000,
  revalidateMs: 15_000,
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

  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();

  const writeEvent = (event: ConsoleSseEvent): void => {
    if (abortSignal.aborted) return;
    response.write(serializeConsoleSseEvent(projectEvent(event, options.projectEvent), policy));
  };

  try {
    writeEvent({
      event: 'init',
      data: createInitData(init, options.now ?? (() => new Date())),
    });
    heartbeat = startHeartbeat(response, abortSignal, policy);
    revalidation = startRevalidation(response, abortController, writeEvent, policy, options);
    for await (const event of stream) {
      if (abortSignal.aborted) break;
      writeEvent(event);
      if (event.event === 'error' || event.event === 'end') break;
    }
  } catch (error) {
    options.reportStreamError?.(error);
    writeTerminalError(response, abortSignal);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (revalidation) clearInterval(revalidation);
    if (!abortSignal.aborted) response.end();
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
  response: Response,
  abortSignal: AbortSignal,
  policy: ConsoleStreamPolicy,
): NodeJS.Timeout | null {
  if (policy.heartbeatMs <= 0) return null;
  const heartbeat = setInterval(() => {
    if (!abortSignal.aborted) response.write(':hb\n\n');
  }, policy.heartbeatMs);
  heartbeat.unref();
  return heartbeat;
}

function startRevalidation(
  response: Response,
  abortController: AbortController,
  writeEvent: (event: ConsoleSseEvent) => void,
  policy: ConsoleStreamPolicy,
  options: ConsoleSseSendOptions,
): NodeJS.Timeout | null {
  if (!options.revalidate) return null;
  const revalidation = setInterval(() => {
    void options.revalidate?.()
      .then(valid => {
        if (!valid && !abortController.signal.aborted) {
          writeEvent({
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
        writeTerminalError(response, abortController.signal);
        abortController.abort();
        response.end();
      });
  }, policy.revalidateMs);
  revalidation.unref();
  return revalidation;
}

function writeTerminalError(response: Response, abortSignal: AbortSignal): void {
  if (abortSignal.aborted || response.writableEnded) return;
  try {
    response.write(serializeConsoleSseEvent({
      event: 'error',
      data: {
        code: 'stream_error',
        detail: 'The stream could not continue.',
      },
    }));
  } catch {
    // The stream is already failing; closing it is the stable fallback.
  }
}

function createAbortController(response: Response, request?: Request): AbortController {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  response.once('close', abort);
  response.once('error', abort);
  request?.once('aborted', abort);
  return controller;
}
