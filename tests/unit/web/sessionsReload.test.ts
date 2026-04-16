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

async function createBrowserEnv(options: {
  currentVersion: string;
  sessions: Array<Record<string, unknown>>;
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

  (dom.window as any).DollhouseAuth = { apiFetch };
  (dom.window as any).DollhouseConsole = {
    currentServerVersion: options.currentVersion,
    forceReload: reloadSpy,
  };
  (dom.window as any).DollhouseConsoleConfig = { sessionPollIntervalMs: 300000 };
  (dom.window as any).setInterval = jest.fn(() => 1);
  (dom.window as any).clearInterval = jest.fn();
  (dom.window as any).confirm = jest.fn(() => true);
  (dom.window as any).alert = jest.fn();

  dom.window.eval(source);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await tick();
  await tick();

  return {
    window: dom.window,
    apiFetch,
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
});
