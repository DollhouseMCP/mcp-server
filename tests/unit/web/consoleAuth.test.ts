/**
 * Unit tests for consoleAuth.js 401 recovery (#1792).
 *
 * Uses JSDOM to simulate a browser environment where consoleAuth.js
 * runs. Tests the session-expired event dispatch, idempotency, and
 * apiFetch 401 detection.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Load consoleAuth.js source once for all tests. */
let consoleAuthSource: string;

async function loadSource(): Promise<string> {
  if (!consoleAuthSource) {
    // Use process.cwd() instead of __dirname for ESM compatibility —
    // CI runs with --experimental-vm-modules where __dirname is undefined.
    consoleAuthSource = await readFile(
      join(process.cwd(), 'src/web/public/consoleAuth.js'),
      'utf8',
    );
  }
  return consoleAuthSource;
}

/**
 * Create a JSDOM instance with a console token meta tag and execute
 * consoleAuth.js in its context. Returns the window object.
 */
async function createBrowserEnv(token: string = ''): Promise<{
  window: JSDOM['window'];
  cleanup: () => void;
}> {
  const source = await loadSource();
  const metaTag = token
    ? `<meta name="dollhouse-console-token" content="${token}">`
    : '';
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head>${metaTag}</head><body></body></html>`,
    {
      url: 'http://localhost:5907',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    },
  );

  // Provide a minimal fetch stub that consoleAuth.js can call
  (dom.window as any).fetch = jest.fn();

  // JSDOM doesn't provide EventSource. Stub it with the minimum shape
  // that consoleAuth.js needs (constructor stores url, addEventListener,
  // close, readyState constants).
  if (!(dom.window as any).EventSource) {
    (dom.window as any).EventSource = class EventSourceStub {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      url: string;
      readyState = 1;
      private readonly listeners: Record<string, Function[]> = {};
      constructor(url: string) { this.url = url; }
      addEventListener(type: string, fn: Function) {
        if (!this.listeners[type]) { this.listeners[type] = []; }
        this.listeners[type].push(fn);
      }
      close() { this.readyState = 2; }
    };
  }

  // Execute consoleAuth.js in the JSDOM context
  dom.window.eval(source);

  return {
    window: dom.window,
    cleanup: () => dom.window.close(),
  };
}

/** A valid 64-hex-char token for tests. */
const TEST_TOKEN = 'a'.repeat(64);

describe('consoleAuth.js — 401 recovery (#1792)', () => {
  describe('with auth enabled (token present)', () => {
    let win: JSDOM['window'];
    let cleanup: () => void;

    beforeEach(async () => {
      const env = await createBrowserEnv(TEST_TOKEN);
      win = env.window;
      cleanup = env.cleanup;
    });

    afterEach(() => cleanup());

    it('exposes DollhouseAuth on the global namespace', () => {
      expect((win as any).DollhouseAuth).toBeDefined();
      expect((win as any).DollhouseAuth.token).toBe(TEST_TOKEN);
    });

    it('fires dollhouse:session-expired on 401 from apiFetch', async () => {
      const events: Event[] = [];
      win.addEventListener('dollhouse:session-expired', (e) => events.push(e));

      // Stub fetch to return a 401 response
      (win as any).fetch = jest.fn().mockResolvedValue({ status: 401 });

      await (win as any).DollhouseAuth.apiFetch('/api/test');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('dollhouse:session-expired');
    });

    it('does not fire session-expired on 200 response', async () => {
      const events: Event[] = [];
      win.addEventListener('dollhouse:session-expired', (e) => events.push(e));

      (win as any).fetch = jest.fn().mockResolvedValue({ status: 200 });

      await (win as any).DollhouseAuth.apiFetch('/api/test');

      expect(events).toHaveLength(0);
    });

    it('fires session-expired at most once (idempotent)', async () => {
      const events: Event[] = [];
      win.addEventListener('dollhouse:session-expired', (e) => events.push(e));

      (win as any).fetch = jest.fn().mockResolvedValue({ status: 401 });

      await (win as any).DollhouseAuth.apiFetch('/api/test1');
      await (win as any).DollhouseAuth.apiFetch('/api/test2');
      await (win as any).DollhouseAuth.apiFetch('/api/test3');

      expect(events).toHaveLength(1);
    });

    it('returns the response even on 401 (does not swallow)', async () => {
      (win as any).fetch = jest.fn().mockResolvedValue({ status: 401, ok: false });

      const response = await (win as any).DollhouseAuth.apiFetch('/api/test');

      expect(response.status).toBe(401);
    });

    it('attaches Authorization header to fetch calls', async () => {
      (win as any).fetch = jest.fn().mockResolvedValue({ status: 200 });

      await (win as any).DollhouseAuth.apiFetch('/api/test');

      const [, init] = (win as any).fetch.mock.calls[0];
      const headers = new (win as any).Headers(init.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${TEST_TOKEN}`);
    });

    it('appends token to EventSource URL', () => {
      const es = (win as any).DollhouseAuth.apiEventSource('/api/logs/stream');
      expect(es.url).toContain(`token=${TEST_TOKEN}`);
      es.close();
    });
  });

  describe('with auth disabled (no token)', () => {
    let win: JSDOM['window'];
    let cleanup: () => void;

    beforeEach(async () => {
      const env = await createBrowserEnv('');
      win = env.window;
      cleanup = env.cleanup;
    });

    afterEach(() => cleanup());

    it('does not fire session-expired on 401 when no token is cached', async () => {
      const events: Event[] = [];
      win.addEventListener('dollhouse:session-expired', (e) => events.push(e));

      (win as any).fetch = jest.fn().mockResolvedValue({ status: 401 });

      await (win as any).DollhouseAuth.apiFetch('/api/test');

      expect(events).toHaveLength(0);
    });

    it('returns empty token', () => {
      expect((win as any).DollhouseAuth.token).toBe('');
    });
  });

  describe('refresh()', () => {
    let win: JSDOM['window'];
    let cleanup: () => void;

    beforeEach(async () => {
      const env = await createBrowserEnv(TEST_TOKEN);
      win = env.window;
      cleanup = env.cleanup;
    });

    afterEach(() => cleanup());

    it('accepts an explicit token and updates the cache', () => {
      const newToken = 'b'.repeat(64);
      const result = (win as any).DollhouseAuth.refresh(newToken);
      expect(result).toBe(newToken);
      expect((win as any).DollhouseAuth.token).toBe(newToken);
    });

    it('rejects non-hex tokens', () => {
      const result = (win as any).DollhouseAuth.refresh('not-a-valid-token');
      // Falls back to meta tag (which has the original token)
      expect(result).toBe(TEST_TOKEN);
    });

    it('falls back to meta tag when called without argument', () => {
      const result = (win as any).DollhouseAuth.refresh();
      expect(result).toBe(TEST_TOKEN);
    });
  });
});
