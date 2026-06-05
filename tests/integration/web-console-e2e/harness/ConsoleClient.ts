import { randomUUID } from 'node:crypto';

import { getConfig } from './config.js';
import type { ForgedSession } from './forgeSession.js';

export interface ConsoleResponse<T = any> {
  readonly status: number;
  readonly body: T;
  readonly text: string;
  readonly headers: Headers;
  readonly etag: string | undefined;
  /** RFC 7807 problem `code` when the body is a problem document. */
  readonly problemCode: string | undefined;
}

export interface RequestOptions {
  readonly body?: unknown;
  /** Value for the `If-Match` header (ETag-guarded writes). */
  readonly ifMatch?: string;
  /** Override/disable the auto Idempotency-Key (a fresh UUID is sent by default on mutations). */
  readonly idempotencyKey?: string | null;
  /** Extra headers (escape hatch for negative tests). */
  readonly headers?: Record<string, string>;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A cookie- and CSRF-aware HTTP client for the console API. Construct one per
 * identity (anonymous, user, admin) from a forged or real session. Mutations
 * automatically satisfy the double-submit CSRF gate and idempotency middleware.
 */
export class ConsoleClient {
  private readonly baseUrl: string;
  private readonly cookies: string[];
  private readonly csrf: string | undefined;

  private constructor(session: ForgedSession | undefined) {
    this.baseUrl = getConfig().baseUrl;
    this.cookies = session ? [`dh_session=${session.session}`, `dh_csrf=${session.csrf}`] : [];
    this.csrf = session?.csrf;
  }

  /** An unauthenticated client (no cookies) — for 401/public-endpoint tests. */
  static anonymous(): ConsoleClient {
    return new ConsoleClient(undefined);
  }

  /** A client bound to a forged or real session. */
  static forSession(session: ForgedSession): ConsoleClient {
    return new ConsoleClient(session);
  }

  get(path: string, options: RequestOptions = {}): Promise<ConsoleResponse> {
    return this.request('GET', path, options);
  }
  post(path: string, options: RequestOptions = {}): Promise<ConsoleResponse> {
    return this.request('POST', path, options);
  }
  put(path: string, options: RequestOptions = {}): Promise<ConsoleResponse> {
    return this.request('PUT', path, options);
  }
  patch(path: string, options: RequestOptions = {}): Promise<ConsoleResponse> {
    return this.request('PATCH', path, options);
  }
  delete(path: string, options: RequestOptions = {}): Promise<ConsoleResponse> {
    return this.request('DELETE', path, options);
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<ConsoleResponse> {
    const headers = this.buildHeaders(method, options);
    const init: RequestInit = { method, headers, redirect: 'manual' };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(this.url(path), init);
    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    const problemCode =
      body && typeof body === 'object' && typeof (body as any).code === 'string'
        ? (body as any).code
        : undefined;
    return {
      status: res.status,
      body,
      text,
      headers: res.headers,
      etag: res.headers.get('etag') ?? undefined,
      problemCode,
    };
  }

  private buildHeaders(method: string, options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.cookies.length > 0) headers.cookie = this.cookies.join('; ');
    if (MUTATING.has(method)) {
      // Double-submit CSRF: cookie value echoed in the header, plus same-origin proof.
      if (this.csrf) headers['x-csrf-token'] = this.csrf;
      headers.origin = this.baseUrl;
      headers['x-console-request'] = '1';
      if (options.idempotencyKey !== null) {
        headers['idempotency-key'] = options.idempotencyKey ?? randomUUID();
      }
    }
    if (options.ifMatch) headers['if-match'] = options.ifMatch;
    return { ...headers, ...options.headers };
  }

  /**
   * Open an SSE stream and collect events until `maxEvents` arrive or `timeoutMs`
   * elapses, whichever first. Always aborts the request on return.
   */
  async readStream(
    path: string,
    { maxEvents = 1, timeoutMs = 4000 }: { maxEvents?: number; timeoutMs?: number } = {},
  ): Promise<{ status: number; contentType: string | null; events: Array<{ event?: string; data: string; id?: string }>; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const events: Array<{ event?: string; data: string; id?: string }> = [];
    let opened = false;
    let contentType: string | null = null;
    try {
      const res = await fetch(this.url(path), {
        method: 'GET',
        headers: {
          ...(this.cookies.length > 0 ? { cookie: this.cookies.join('; ') } : {}),
          accept: 'text/event-stream',
          // SSE routes enforce a same-origin check (ConsoleSecuredRouterAssembler).
          origin: this.baseUrl,
        },
        signal: controller.signal,
      });
      opened = true;
      contentType = res.headers.get('content-type');
      if (res.status !== 200 || !res.body) {
        const text = await res.text().catch(() => '');
        return { status: res.status, contentType, events, text };
      }
      await drainSseEvents(res.body, maxEvents, events);
      return { status: 200, contentType, events, text: '' };
    } catch (err) {
      // A timeout AFTER the response opened is the normal end of reading a
      // long-lived SSE connection — report what we collected. A timeout BEFORE
      // any response means the endpoint never answered; surface that as a non-200
      // (status 0) so a hung endpoint can never be mistaken for a working stream.
      if (controller.signal.aborted) {
        return { status: opened ? 200 : 0, contentType, events, text: '' };
      }
      throw err;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private url(path: string): string {
    return path.startsWith('http') ? path : `${this.baseUrl}${path}`;
  }
}

function parseSseFrame(raw: string): { event?: string; data: string; id?: string } | undefined {
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // comment / heartbeat
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  if (data.length === 0 && event === undefined && id === undefined) return undefined;
  return { event, data: data.join('\n'), id };
}

/** Read SSE frames from a response body until `maxEvents` are collected or the stream ends. */
async function drainSseEvents(
  body: ReadableStream<Uint8Array>,
  maxEvents: number,
  events: Array<{ event?: string; data: string; id?: string }>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (events.length < maxEvents) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    // Events are separated by a blank line.
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseSseFrame(raw);
      if (parsed) events.push(parsed);
    }
  }
}
