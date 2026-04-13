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
let permissionsSource = '';

type TestWindow = JSDOM['window'] & typeof globalThis & Record<string, any>;

const DEFAULT_WAIT_MS = 25;
const TEST_SESSION_FILTER_INJECTION_RETRY_INTERVAL_MS = 10;
const SESSION_FILTER_INJECTION_WAIT_MS = 40;

beforeAll(async () => {
  const base = join(process.cwd(), 'src/web/public');
  [appSource, sessionsSource, logsSource, metricsSource, permissionsSource] = await Promise.all([
    readFile(join(base, 'app.js'), 'utf8'),
    readFile(join(base, 'sessions.js'), 'utf8'),
    readFile(join(base, 'logs.js'), 'utf8'),
    readFile(join(base, 'metrics.js'), 'utf8'),
    readFile(join(base, 'permissions.js'), 'utf8'),
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

  const win = dom.window as unknown as TestWindow;
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
    await wait(DEFAULT_WAIT_MS);

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
    await wait(DEFAULT_WAIT_MS);

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
    win.DollhouseConsoleConfig = {
      sessionFilterInjectionRetryIntervalMs: TEST_SESSION_FILTER_INJECTION_RETRY_INTERVAL_MS,
      sessionFilterInjectionMaxRetries: 5,
    };

    win.eval(sessionsSource);
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await wait(SESSION_FILTER_INJECTION_WAIT_MS);

    const select = win.document.getElementById('log-session-filter') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(win.document.querySelector('#tab-logs .log-controls #log-session-filter')).not.toBeNull();
    expect(select?.options).toHaveLength(2);
    expect(select?.options[1].value).toBe('session-1');
    expect(select?.options[1].textContent).toContain('Barbie');
    expect(select?.options[1].textContent).toContain('(leader)');

    cleanup();
  });

  it('keeps aggregate policy sources visible when selecting a persisted policy session', async () => {
    const { window: win, cleanup } = createDom(`
      <div id="session-indicator"></div>
      <div id="tab-logs"><div class="log-controls"></div></div>
      <div id="console-tabs"><button class="console-tab" data-tab="permissions">Permissions</button></div>
      <div id="permissions-dashboard-root"></div>
    `);

    const apiFetch = jest.fn((url: string) => {
      if (url === '/api/sessions') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            sessions: [{
              sessionId: 'console-1',
              status: 'active',
              displayName: 'Web Console',
              startedAt: '2026-04-13T20:00:00.000Z',
              isLeader: false,
              authenticated: true,
              kind: 'console',
              color: '#6366f1',
            }],
          }),
        });
      }

      if (url === '/api/permissions/status?sessionId=session-focus') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            sessionId: 'session-focus',
            activeElementCount: 1,
            hasAllowlist: false,
            denyPatterns: ['mcp__DollhouseMCP__mcp_aql_delete*'],
            allowPatterns: ['mcp__DollhouseMCP__mcp_aql_read*'],
            confirmPatterns: ['mcp__DollhouseMCP__mcp_aql_execute*'],
            elements: [{
              type: 'agent',
              element_name: 'autonomy-scout-demo',
              description: 'Selected session details',
            }],
            recentDecisions: [],
            permissionPromptActive: false,
          }),
        });
      }

      if (url === '/api/permissions/status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            activeElementCount: 2,
            hasAllowlist: true,
            denyPatterns: ['Bash:rm -rf *', 'Bash:git clean -f*'],
            allowPatterns: ['Bash:git status*'],
            confirmPatterns: ['Bash:git push*'],
            elements: [
              {
                type: 'ensemble',
                element_name: 'drawing-room-safety',
                description: 'Shared baseline restrictions',
                sessionIds: ['session-alpha'],
              },
              {
                type: 'agent',
                element_name: 'autonomy-scout-demo',
                description: 'Selected session details',
                sessionIds: ['session-focus'],
              },
            ],
            knownSessions: [
              { sessionId: 'session-alpha', displayName: 'session-alpha', source: 'policy' },
              { sessionId: 'session-focus', displayName: 'session-focus', source: 'policy' },
            ],
            recentDecisions: [],
            permissionPromptActive: false,
          }),
        });
      }

      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    win.DollhouseAuth.apiFetch = apiFetch;
    win.DollhouseConsole = { logs: { refilter: jest.fn() } };
    win.DollhouseConsoleConfig = {
      sessionFilterInjectionRetryIntervalMs: TEST_SESSION_FILTER_INJECTION_RETRY_INTERVAL_MS,
      sessionFilterInjectionMaxRetries: 5,
    };

    win.eval(sessionsSource);
    win.eval(permissionsSource);
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    win.DollhouseConsole.permissions.init();
    await wait(SESSION_FILTER_INJECTION_WAIT_MS);

    const sessionBox = win.document.querySelector('.session-box') as HTMLButtonElement | null;
    expect(sessionBox).not.toBeNull();
    sessionBox?.click();
    await wait(DEFAULT_WAIT_MS);

    const debugHeading = Array.from(win.document.querySelectorAll('.session-dropdown-heading'))
      .map(node => node.textContent);
    expect(debugHeading).toContain('Persisted Policy State (Debug Info)');

    const persistedItem = win.document.querySelector('.session-dropdown-item[data-session-id="session-focus"]') as HTMLElement | null;
    expect(persistedItem).not.toBeNull();
    persistedItem?.click();
    await wait(DEFAULT_WAIT_MS);

    const sourceItems = Array.from(win.document.querySelectorAll('#perm-source-list .perm-source-item'));
    expect(sourceItems).toHaveLength(2);
    expect(win.document.getElementById('perm-source-list')?.textContent).toContain('drawing-room-safety');
    expect(win.document.getElementById('perm-source-list')?.textContent).toContain('autonomy-scout-demo');

    const highlighted = win.document.querySelectorAll('#perm-source-list .perm-source-item--selected');
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]?.textContent).toContain('autonomy-scout-demo');

    const selectedCard = win.document.getElementById('perm-selected-card');
    expect(selectedCard?.hidden).toBe(false);
    expect(win.document.getElementById('perm-selected-title')?.textContent).toContain('session-focus');
    expect(win.document.getElementById('perm-selected-badge')?.textContent).toContain('Persisted Policy State (Debug Info)');
    expect(win.document.getElementById('perm-selected-source-list')?.textContent).toContain('autonomy-scout-demo');
    expect(win.document.getElementById('perm-selected-deny-list')?.textContent).toContain('mcp__DollhouseMCP__mcp_aql_delete*');

    cleanup();
  });

  it('ignores malformed persisted policy session entries in the picker', async () => {
    const { window: win, cleanup } = createDom(`
      <div id="session-indicator"></div>
      <div id="tab-logs"><div class="log-controls"></div></div>
    `);

    win.DollhouseAuth.apiFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        sessions: [{
          sessionId: 'console-1',
          status: 'active',
          displayName: 'Web Console',
          startedAt: '2026-04-13T20:00:00.000Z',
          isLeader: false,
          authenticated: true,
          kind: 'console',
          color: '#6366f1',
        }],
      }),
    });
    win.DollhouseConsole = { logs: { refilter: jest.fn() } };
    win.DollhouseConsoleConfig = {
      sessionFilterInjectionRetryIntervalMs: TEST_SESSION_FILTER_INJECTION_RETRY_INTERVAL_MS,
      sessionFilterInjectionMaxRetries: 5,
    };

    win.eval(sessionsSource);
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await wait(SESSION_FILTER_INJECTION_WAIT_MS);

    win.DollhouseSessions.setPolicySessions([
      null,
      { sessionId: '', displayName: 'empty' },
      { sessionId: 'session-good', displayName: 'session-good' },
      { sessionId: 'session-good', displayName: 'duplicate' },
      { sessionId: 42, displayName: 'bad-type' },
    ]);

    const select = win.document.getElementById('log-session-filter') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    const options = Array.from(select?.options ?? []).map(option => ({
      value: option.value,
      label: option.textContent,
    }));

    expect(options).toEqual([
      { value: '', label: 'All Sessions' },
      { value: 'console-1', label: 'Web Console' },
      { value: 'session-good', label: 'session-good (policy only)' },
    ]);

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
    await wait(DEFAULT_WAIT_MS);

    const banner = win.document.getElementById('metrics-error-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toBe('Failed to load metrics — retrying...');

    cleanup();
  });
});
