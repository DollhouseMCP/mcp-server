/**
 * JSDOM regressions for recent web-console cleanup issues.
 *
 * Covers:
 * - #1868 visible banners for collection/sessions/logs/metrics failures
 * - session filter injection into the current .log-controls container
 */

import { describe, it, expect, beforeAll, afterEach, jest } from '@jest/globals';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

let appSource = '';
let sessionsSource = '';
let logsSource = '';
let metricsSource = '';

beforeAll(async () => {
  const base = join(process.cwd(), 'src/web/public');
  [appSource, sessionsSource, logsSource, metricsSource] = await Promise.all([
    readFile(join(base, 'app.js'), 'utf8'),
    readFile(join(base, 'sessions.js'), 'utf8'),
    readFile(join(base, 'logs.js'), 'utf8'),
    readFile(join(base, 'metrics.js'), 'utf8'),
  ]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDom(html: string): { window: JSDOM['window']; cleanup: () => void } {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
    url: 'http://localhost:41715',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });

  const win = dom.window as JSDOM['window'] & Record<string, any>;
  const intervalIds: number[] = [];
  const timeoutIds: number[] = [];
  const nativeSetInterval = win.setInterval.bind(win);
  const nativeSetTimeout = win.setTimeout.bind(win);
  win.matchMedia = jest.fn().mockReturnValue({
    matches: false,
    media: '',
    onchange: null,
    addListener() { /* legacy no-op */ },
    removeListener() { /* legacy no-op */ },
    addEventListener() { /* no-op */ },
    removeEventListener() { /* no-op */ },
    dispatchEvent() { return false; },
  });
  win.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
    const id = nativeSetInterval(handler, timeout, ...args);
    intervalIds.push(id);
    return id;
  }) as typeof win.setInterval;
  win.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
    const id = nativeSetTimeout(handler, timeout, ...args);
    timeoutIds.push(id);
    return id;
  }) as typeof win.setTimeout;
  win.requestAnimationFrame = (cb: FrameRequestCallback) => win.setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = (id: number) => win.clearTimeout(id);
  win.scrollTo = jest.fn();
  win.CSS = { escape: (value: string) => value };
  win.fetch = jest.fn();
  win.DollhouseConsole = win.DollhouseConsole || {};
  win.DollhouseAuth = {
    apiFetch: jest.fn(),
    apiEventSource: jest.fn(),
  };

  return {
    window: win,
    cleanup: () => {
      for (const id of intervalIds) win.clearInterval(id);
      for (const id of timeoutIds) win.clearTimeout(id);
      dom.window.close();
    },
  };
}

function installBannerHelper(win: Record<string, any>) {
  win.DollhouseConsoleUI = {
    showBanner(targetId: string, bannerId: string, message: string) {
      const target = win.document.getElementById(targetId);
      if (!target) return;
      let banner = win.document.getElementById(bannerId);
      if (!banner) {
        banner = win.document.createElement('div');
        banner.id = bannerId;
        banner.className = 'tab-error-banner';
        target.prepend(banner);
      }
      banner.textContent = message;
      banner.hidden = false;
    },
    clearBanner(bannerId: string) {
      const banner = win.document.getElementById(bannerId);
      if (banner) banner.hidden = true;
    },
  };
}

describe('Web console cleanup regressions', () => {
  it('shows a visible collection banner when the community collection fetch fails', async () => {
    const { window: win, cleanup } = createDom(`
      <button id="theme-toggle"></button>
      <span id="theme-toggle-icon"></span>
      <span id="theme-toggle-label"></span>
      <link id="hljs-theme-light">
      <link id="hljs-theme-dark">
      <div id="view-toggle"><button class="view-btn" data-view="grid"></button></div>
      <select id="sort-select"><option value="date-desc">date-desc</option></select>
      <input id="search-input">
      <div id="source-toggle"><button data-source="all"></button></div>
      <button id="btn-portfolio"></button>
      <div id="console-tabs"><button class="console-tab active" data-tab="portfolio"></button></div>
      <div id="tab-portfolio" class="tab-panel active"></div>
      <div id="stats"></div>
      <div><div id="type-filters"></div></div>
      <div id="topic-filters"></div>
      <div id="results-count"></div>
      <div id="results-announcer"></div>
      <div id="elements-grid"></div>
      <div id="pagination" hidden><button id="btn-prev-page"></button><button id="btn-next-page"></button><span id="page-info"></span></div>
      <div id="footer-updated"></div>
    `);

    win.DollhouseAuth.apiFetch = jest.fn((url: string) => {
      if (url === '/api/elements') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ elements: { personas: [] }, totalCount: 0 }),
        });
      }
      if (url === '/api/collection') {
        return Promise.reject(new Error('collection request failed'));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    win.eval(appSource);
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await wait(25);

    const banner = win.document.getElementById('collection-error-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('Community collection unavailable');
    expect(win.document.getElementById('tab-portfolio')?.firstElementChild?.id).toBe('collection-error-banner');

    cleanup();
  });

  it('shows a visible sessions banner when session fetch fails', async () => {
    const { window: win, cleanup } = createDom(`
      <div id="session-indicator"></div>
      <div id="tab-logs"><div class="log-controls"></div></div>
    `);

    win.DollhouseAuth.apiFetch = jest.fn().mockRejectedValue(new Error('network down'));
    win.DollhouseConsole = { logs: { refilter: jest.fn() } };

    win.eval(sessionsSource);
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await wait(25);

    const banner = win.document.getElementById('sessions-error-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toBe('Failed to load sessions.');

    cleanup();
  });

  it('injects the log session filter into .log-controls and populates active sessions', async () => {
    const { window: win, cleanup } = createDom(`
      <div id="session-indicator"></div>
      <div id="tab-logs"><div class="log-controls"></div></div>
    `);

    win.DollhouseAuth.apiFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        sessions: [
          {
            sessionId: 'session-1',
            status: 'active',
            displayName: 'Barbie',
            startedAt: '2026-04-09T10:00:00.000Z',
            isLeader: true,
            color: '#ff00ff',
          },
          {
            sessionId: 'session-2',
            status: 'ended',
            displayName: 'Ken',
            startedAt: '2026-04-09T10:05:00.000Z',
          },
        ],
      }),
    });
    win.DollhouseConsole = { logs: { refilter: jest.fn() } };

    win.eval(sessionsSource);
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await wait(650);

    const select = win.document.getElementById('log-session-filter') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(win.document.querySelector('#tab-logs .log-controls #log-session-filter')).not.toBeNull();
    expect(select?.options).toHaveLength(2);
    expect(select?.options[1].value).toBe('session-1');
    expect(select?.options[1].textContent).toContain('Barbie');
    expect(select?.options[1].textContent).toContain('(leader)');

    cleanup();
  });

  it('shows a visible logs banner when the SSE stream disconnects', async () => {
    const { window: win, cleanup } = createDom(`
      <div id="tab-logs"></div>
      <div id="log-viewer-root"></div>
    `);
    installBannerHelper(win);

    const eventSource = {
      onopen: null as null | (() => void),
      onmessage: null as null | ((event: MessageEvent) => void),
      onerror: null as null | (() => void),
      close: jest.fn(),
    };
    win.DollhouseAuth.apiEventSource = jest.fn().mockReturnValue(eventSource);

    win.eval(logsSource);
    win.DollhouseConsole.logs.init();
    eventSource.onerror?.();

    const banner = win.document.getElementById('logs-error-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toBe('Connection lost - reconnecting...');

    cleanup();
  });

  it('shows a visible metrics banner when the latest metrics fetch fails', async () => {
    const { window: win, cleanup } = createDom(`
      <div id="tab-metrics"></div>
      <div id="metrics-dashboard-root"></div>
    `);
    installBannerHelper(win);

    win.DollhouseAuth.apiFetch = jest.fn().mockRejectedValue(new Error('metrics unavailable'));

    win.eval(metricsSource);
    win.DollhouseConsole.metrics.init();
    await wait(25);

    const banner = win.document.getElementById('metrics-error-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toBe('Failed to load metrics — retrying...');

    cleanup();
  });
});
