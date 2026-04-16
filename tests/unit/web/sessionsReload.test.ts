/**
 * Unit tests for sessions.js forced reload behavior.
 *
 * Verifies that the session poller triggers a cache-busted reload when it
 * detects a newer leader version than the one currently loaded in the tab.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

let sessionsSource: string;

async function loadSource(): Promise<string> {
  if (!sessionsSource) {
    sessionsSource = await readFile(
      join(process.cwd(), 'src/web/public/sessions.js'),
      'utf8',
    );
  }
  return sessionsSource;
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function waitForReload(waitMs = 10): Promise<void> {
  await tick();
  await tick();
  await new Promise(resolve => setTimeout(resolve, waitMs));
}

async function createBrowserEnv(options: {
  currentVersion: string;
  sessions: Array<Record<string, unknown>>;
  leaderReloadDebounceMs?: number;
  waitAfterInitMs?: number;
}) {
  const source = await loadSource();
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head>
      <meta name="dollhouse-server-version" content="${options.currentVersion}">
    </head><body>
      <div id="session-indicator"></div>
    </body></html>`,
    {
      url: 'http://dollhouse.localhost:41715',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    },
  );

  const reloadSpy = jest.fn();
  const apiFetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ sessions: options.sessions }),
  });
  const intervalCallbacks: Array<() => void> = [];

  (dom.window as any).DollhouseAuth = { apiFetch };
  (dom.window as any).DollhouseConsole = {
    currentServerVersion: options.currentVersion,
    forceReload: reloadSpy,
  };
  (dom.window as any).DollhouseConsoleConfig = {
    sessionPollIntervalMs: 300000,
    leaderReloadDebounceMs: options.leaderReloadDebounceMs ?? 1,
  };
  (dom.window as any).setInterval = jest.fn((fn: () => void) => {
    intervalCallbacks.push(fn);
    return intervalCallbacks.length;
  });
  (dom.window as any).clearInterval = jest.fn();
  (dom.window as any).confirm = jest.fn(() => true);
  (dom.window as any).alert = jest.fn();

  dom.window.eval(source);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await waitForReload(options.waitAfterInitMs ?? ((options.leaderReloadDebounceMs ?? 1) + 10));

  return {
    window: dom.window,
    apiFetch,
    intervalCallbacks,
    reloadSpy,
    cleanup: () => dom.window.close(),
  };
}

describe('sessions.js forced reload path', () => {
  it('forces a reload when the leader version is newer than the loaded console', async () => {
    const env = await createBrowserEnv({
      currentVersion: '2.0.18',
      sessions: [{
        sessionId: 'leader-1',
        displayName: 'Kermit',
        color: '#00aa00',
        pid: 1234,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        status: 'active',
        isLeader: true,
        authenticated: true,
        kind: 'mcp',
        serverVersion: '2.0.19',
        consoleProtocolVersion: 1,
      }],
    });

    try {
      expect(env.apiFetch).toHaveBeenCalledWith('/api/sessions');
      expect(env.reloadSpy).toHaveBeenCalledWith('leader-upgraded', '2.0.19');
    } finally {
      env.cleanup();
    }
  });

  it('does not reload when the leader version matches the loaded console', async () => {
    const env = await createBrowserEnv({
      currentVersion: '2.0.18',
      sessions: [{
        sessionId: 'leader-1',
        displayName: 'Kermit',
        color: '#00aa00',
        pid: 1234,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        status: 'active',
        isLeader: true,
        authenticated: true,
        kind: 'mcp',
        serverVersion: '2.0.18',
        consoleProtocolVersion: 1,
      }],
    });

    try {
      expect(env.reloadSpy).not.toHaveBeenCalled();
    } finally {
      env.cleanup();
    }
  });

  it('treats a stable release as newer than a prerelease of the same version', async () => {
    const env = await createBrowserEnv({
      currentVersion: '2.0.18-beta.1',
      sessions: [{
        sessionId: 'leader-1',
        displayName: 'Kermit',
        color: '#00aa00',
        pid: 1234,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        status: 'active',
        isLeader: true,
        authenticated: true,
        kind: 'mcp',
        serverVersion: '2.0.18',
        consoleProtocolVersion: 1,
      }],
    });

    try {
      expect(env.reloadSpy).toHaveBeenCalledWith('leader-upgraded', '2.0.18');
    } finally {
      env.cleanup();
    }
  });

  it('reloads to the newest observed leader version when upgrades arrive in quick succession', async () => {
    const env = await createBrowserEnv({
      currentVersion: '2.0.18',
      leaderReloadDebounceMs: 50,
      waitAfterInitMs: 5,
      sessions: [{
        sessionId: 'leader-1',
        displayName: 'Kermit',
        color: '#00aa00',
        pid: 1234,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        status: 'active',
        isLeader: true,
        authenticated: true,
        kind: 'mcp',
        serverVersion: '2.0.19',
        consoleProtocolVersion: 1,
      }],
    });

    try {
      env.reloadSpy.mockClear();
      const newerSessions = [{
        sessionId: 'leader-1',
        displayName: 'Kermit',
        color: '#00aa00',
        pid: 1234,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        status: 'active',
        isLeader: true,
        authenticated: true,
        kind: 'mcp',
        serverVersion: '2.0.20',
        consoleProtocolVersion: 1,
      }];

      env.apiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: newerSessions }),
      });
      env.intervalCallbacks[0]();
      await waitForReload(60);

      expect(env.reloadSpy).toHaveBeenCalledTimes(1);
      expect(env.reloadSpy).toHaveBeenCalledWith('leader-upgraded', '2.0.20');
    } finally {
      env.cleanup();
    }
  });
});
