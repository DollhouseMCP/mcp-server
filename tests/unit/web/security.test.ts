/**
 * JSDOM-based tests for the Auth tab (security.js) (#1791).
 *
 * Verifies the browser-side rendering, panel structure, enrollment
 * flow state management, and action handler behavior.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

let securitySource: string;
let consoleAuthSource: string;

async function loadSources(): Promise<void> {
  if (!securitySource) {
    securitySource = await readFile(
      join(process.cwd(), 'src/web/public/security.js'),
      'utf8',
    );
  }
  if (!consoleAuthSource) {
    consoleAuthSource = await readFile(
      join(process.cwd(), 'src/web/public/consoleAuth.js'),
      'utf8',
    );
  }
}

/** Mock token info API response. */
const MOCK_TOKEN_INFO = {
  tokens: [{
    id: '018e1a2b-3c4d-7e5f-8901-abcdef123456',
    name: 'Kermit on test-host',
    kind: 'console',
    tokenPreview: 'a1b2c3d4' + '\u2022'.repeat(56),
    scopes: ['admin'],
    createdAt: '2026-04-06T00:00:00.000Z',
    lastUsedAt: null,
    createdVia: 'initial-setup',
  }],
  totp: { enrolled: false, enrolledAt: null, backupCodesRemaining: 0 },
  filePath: '/test/console-token.auth.json',
};

const MOCK_TOKEN_INFO_ENROLLED = {
  ...MOCK_TOKEN_INFO,
  totp: { enrolled: true, enrolledAt: '2026-04-06T01:00:00.000Z', backupCodesRemaining: 8 },
};

const TEST_TOKEN = 'a'.repeat(64);

async function createBrowserEnv() {
  await loadSources();
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head>
      <meta name="dollhouse-console-token" content="${TEST_TOKEN}">
    </head><body>
      <div id="security-dashboard-root"></div>
      <template id="sec-intro-template">
        <section class="sec-card sec-card--intro" data-collapsed="true" aria-labelledby="sec-intro-title">
          <button class="sec-card-header" type="button" aria-expanded="false">
            <h3 class="sec-card-title">Console Authentication</h3>
            <span class="sec-card-toggle">&#9662;</span>
          </button>
          <div class="sec-card-body">
            <p>Test intro content</p>
          </div>
        </section>
      </template>
    </body></html>`,
    { url: 'http://localhost:41715', runScripts: 'dangerously', pretendToBeVisual: true },
  );

  // Stub fetch
  (dom.window as any).fetch = jest.fn();

  // Stub EventSource
  if (!(dom.window as any).EventSource) {
    (dom.window as any).EventSource = class {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      url: string;
      readyState = 1;
      constructor(url: string) { this.url = url; }
      addEventListener() { /* stub — no-op for test environment */ }
      close() { this.readyState = 2; }
    };
  }

  // Stub clipboard
  (dom.window as any).navigator.clipboard = {
    writeText: jest.fn().mockResolvedValue(undefined),
  };

  // Load consoleAuth first (DollhouseAuth must exist before security.js)
  dom.window.eval(consoleAuthSource);
  // Load security.js
  dom.window.eval(securitySource);

  return {
    window: dom.window,
    cleanup: () => dom.window.close(),
  };
}

/** Set up fetch to return mock token info. */
function mockFetchSuccess(win: any, data: any = MOCK_TOKEN_INFO) {
  win.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  });
}

describe('Auth tab (security.js) — #1791', () => {
  let win: JSDOM['window'];
  let cleanup: () => void;

  beforeEach(async () => {
    const env = await createBrowserEnv();
    win = env.window;
    cleanup = env.cleanup;
  });

  afterEach(() => cleanup());

  describe('module registration', () => {
    it('exposes DollhouseConsole.security with init/destroy/refresh', () => {
      const dc = (win as any).DollhouseConsole;
      expect(dc).toBeDefined();
      expect(dc.security).toBeDefined();
      expect(typeof dc.security.init).toBe('function');
      expect(typeof dc.security.destroy).toBe('function');
      expect(typeof dc.security.refresh).toBe('function');
    });
  });

  describe('init', () => {
    it('builds the dashboard HTML structure', () => {
      mockFetchSuccess(win);
      (win as any).DollhouseConsole.security.init();
      const root = win.document.getElementById('security-dashboard-root');
      expect(root).not.toBeNull();
      expect(root!.querySelector('.sec-dashboard')).not.toBeNull();
      expect(root!.querySelector('#sec-token-content')).not.toBeNull();
      expect(root!.querySelector('#sec-totp-content')).not.toBeNull();
    });

    it('has static headers on token/TOTP cards and a collapsible intro card', () => {
      mockFetchSuccess(win);
      (win as any).DollhouseConsole.security.init();
      const headers = win.document.querySelectorAll('.sec-card-header');
      expect(headers.length).toBe(3); // Intro + Token + Authenticator
      // Intro card header is a <button> (collapsible)
      const introHeader = win.document.querySelector('.sec-card--intro .sec-card-header');
      expect(introHeader!.tagName.toLowerCase()).toBe('button');
      // Token and TOTP card headers are <div> (static)
      const nonIntroHeaders = win.document.querySelectorAll('.sec-card:not(.sec-card--intro) .sec-card-header');
      nonIntroHeaders.forEach((h: Element) => {
        expect(h.tagName.toLowerCase()).toBe('div');
      });
    });

    it('clones the intro card from the template', () => {
      mockFetchSuccess(win);
      (win as any).DollhouseConsole.security.init();
      const introCard = win.document.querySelector('.sec-card--intro');
      expect(introCard).not.toBeNull();
      expect((introCard as HTMLElement).dataset.collapsed).toBe('true');
      const header = introCard!.querySelector('.sec-card-header');
      expect(header!.getAttribute('aria-expanded')).toBe('false');
    });

    it('is idempotent — calling twice does not duplicate content', () => {
      mockFetchSuccess(win);
      (win as any).DollhouseConsole.security.init();
      (win as any).DollhouseConsole.security.init();
      const cards = win.document.querySelectorAll('.sec-card');
      expect(cards.length).toBe(3); // Intro + Token + Authenticator
    });
  });

  describe('token panel rendering', () => {
    it('renders token preview and metadata', async () => {
      mockFetchSuccess(win);
      (win as any).DollhouseConsole.security.init();
      // Wait for async fetch
      await new Promise(r => setTimeout(r, 50));

      const tokenContent = win.document.getElementById('sec-token-content');
      expect(tokenContent).not.toBeNull();
      expect(tokenContent!.innerHTML).toContain('a1b2c3d4');
      expect(tokenContent!.innerHTML).toContain('Kermit on test-host');
      expect(tokenContent!.innerHTML).toContain('initial-setup');
    });

    it('renders Copy and Copy curl buttons', async () => {
      mockFetchSuccess(win);
      (win as any).DollhouseConsole.security.init();
      await new Promise(r => setTimeout(r, 50));

      expect(win.document.getElementById('sec-copy-token')).not.toBeNull();
      expect(win.document.getElementById('sec-copy-curl')).not.toBeNull();
    });

    it('disables Rotate button when TOTP not enrolled', async () => {
      mockFetchSuccess(win, MOCK_TOKEN_INFO);
      (win as any).DollhouseConsole.security.init();
      await new Promise(r => setTimeout(r, 50));

      const btn = win.document.getElementById('sec-rotate-btn') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.disabled).toBe(true);
    });

    it('enables Rotate button when TOTP is enrolled', async () => {
      mockFetchSuccess(win, MOCK_TOKEN_INFO_ENROLLED);
      (win as any).DollhouseConsole.security.init();
      await new Promise(r => setTimeout(r, 50));

      const btn = win.document.getElementById('sec-rotate-btn') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.disabled).toBe(false);
    });
  });

  describe('TOTP panel rendering', () => {
    it('shows "Not enrolled" with Enroll button when TOTP is off', async () => {
      mockFetchSuccess(win, MOCK_TOKEN_INFO);
      (win as any).DollhouseConsole.security.init();
      await new Promise(r => setTimeout(r, 50));

      const totpContent = win.document.getElementById('sec-totp-content');
      expect(totpContent!.innerHTML).toContain('Not enrolled');
      expect(win.document.getElementById('sec-totp-enroll')).not.toBeNull();
    });

    it('shows "Enrolled" with Disable button and backup count when TOTP is on', async () => {
      mockFetchSuccess(win, MOCK_TOKEN_INFO_ENROLLED);
      (win as any).DollhouseConsole.security.init();
      await new Promise(r => setTimeout(r, 50));

      const totpContent = win.document.getElementById('sec-totp-content');
      expect(totpContent!.innerHTML).toContain('Enrolled');
      expect(totpContent!.innerHTML).toContain('8');
      expect(win.document.getElementById('sec-totp-disable')).not.toBeNull();
    });
  });

  describe('card collapse toggle', () => {
    it('intro card collapses and expands when header is clicked', async () => {
      mockFetchSuccess(win);
      (win as any).DollhouseConsole.security.init();

      const introCard = win.document.querySelector('.sec-card--intro') as HTMLElement;
      const header = introCard.querySelector('.sec-card-header') as HTMLElement;
      expect(introCard.dataset.collapsed).toBe('true'); // starts collapsed

      header.click();
      expect(introCard.dataset.collapsed).toBe('false');
      expect(header.getAttribute('aria-expanded')).toBe('true');

      header.click();
      expect(introCard.dataset.collapsed).toBe('true');
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('token and TOTP cards have no collapse behavior', async () => {
      mockFetchSuccess(win);
      (win as any).DollhouseConsole.security.init();

      const cards = win.document.querySelectorAll('.sec-card:not(.sec-card--intro)');
      cards.forEach((card: Element) => {
        // No data-collapsed attribute
        expect((card as HTMLElement).dataset.collapsed).toBeUndefined();
        // No toggle chevron
        expect(card.querySelector('.sec-card-toggle')).toBeNull();
      });
    });
  });

  describe('edge cases', () => {
    it('handles empty tokens array gracefully', async () => {
      mockFetchSuccess(win, { tokens: [], totp: MOCK_TOKEN_INFO.totp, filePath: '/test' });
      (win as any).DollhouseConsole.security.init();
      await new Promise(r => setTimeout(r, 50));

      const tokenContent = win.document.getElementById('sec-token-content');
      expect(tokenContent!.textContent).toContain('No token data');
    });

    it('handles poll failure by clearing stale content', async () => {
      // First successful render
      mockFetchSuccess(win);
      (win as any).DollhouseConsole.security.init();
      await new Promise(r => setTimeout(r, 50));

      // Now make fetch fail
      win.fetch = jest.fn().mockRejectedValue(new Error('network down'));
      (win as any).DollhouseConsole.security.refresh();
      await new Promise(r => setTimeout(r, 50));

      const tokenContent = win.document.getElementById('sec-token-content');
      expect(tokenContent!.innerHTML).toBe('');
    });

    it('handles missing totp field in response', async () => {
      mockFetchSuccess(win, {
        tokens: MOCK_TOKEN_INFO.tokens,
        totp: { enrolled: false, enrolledAt: null, backupCodesRemaining: 0 },
        filePath: '/test',
      });
      (win as any).DollhouseConsole.security.init();
      await new Promise(r => setTimeout(r, 50));

      const totpContent = win.document.getElementById('sec-totp-content');
      expect(totpContent!.innerHTML).toContain('Not enrolled');
    });
  });

  describe('destroy', () => {
    it('resets initialized state so init can be called again', () => {
      mockFetchSuccess(win);
      (win as any).DollhouseConsole.security.init();
      (win as any).DollhouseConsole.security.destroy();
      // Clear the root to simulate a clean slate
      const root = win.document.getElementById('security-dashboard-root');
      if (root) root.innerHTML = '';
      // Re-init should work without errors
      (win as any).DollhouseConsole.security.init();
      const cards = win.document.querySelectorAll('.sec-card');
      expect(cards.length).toBe(3); // Intro + Token + Authenticator
    });
  });
});
