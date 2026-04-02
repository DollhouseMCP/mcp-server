/**
 * Setup Routes — Unit Tests
 *
 * Tests the setup tab API endpoints: install, open-config.
 * Tests HTML content integrity: links, configs, data attributes.
 * Tests install-mcp dependency resolution.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..', '..', 'src');
const PUBLIC_DIR = join(SRC_ROOT, 'web', 'public');

// ── Setup route handler tests ─────────────────────────────────────────

describe('Setup Routes — API Endpoints', () => {
  let app: express.Express;

  beforeEach(async () => {
    // Dynamic import to avoid module caching issues
    const { createSetupRoutes } = await import('../../../src/web/routes/setupRoutes.js');
    const { installHandler, openConfigHandler, versionHandler, mcpbRedirectHandler, detectHandler } = createSetupRoutes();

    app = express();
    app.use(express.json());
    app.post('/api/setup/install', installHandler);
    app.post('/api/setup/open-config', openConfigHandler);
    app.get('/api/setup/version', versionHandler);
    app.get('/api/setup/mcpb', mcpbRedirectHandler);
    app.get('/api/setup/detect', detectHandler);
  });

  describe('POST /api/setup/install', () => {
    it('rejects missing client field', async () => {
      const res = await request(app)
        .post('/api/setup/install')
        .send({})
        .expect(400);

      expect(res.body.error).toMatch(/Missing required field/);
    });

    it('rejects non-string client field', async () => {
      const res = await request(app)
        .post('/api/setup/install')
        .send({ client: 123 })
        .expect(400);

      expect(res.body.error).toMatch(/Missing required field/);
    });

    it('rejects unsupported client names', async () => {
      const res = await request(app)
        .post('/api/setup/install')
        .send({ client: 'not-a-real-client' })
        .expect(400);

      expect(res.body.error).toMatch(/Unsupported client/);
      expect(res.body.supported).toBeInstanceOf(Array);
      expect(res.body.supported.length).toBeGreaterThan(0);
    });

    it('rejects path traversal attempts in client name', async () => {
      const res = await request(app)
        .post('/api/setup/install')
        .send({ client: '../../../etc/passwd' })
        .expect(400);

      expect(res.body.error).toMatch(/Unsupported client/);
    });

    it('accepts all documented client names', async () => {
      const validClients = [
        'claude', 'claude-code', 'cursor', 'vscode', 'cline',
        'roo-cline', 'windsurf', 'witsy', 'enconvo', 'gemini-cli',
        'goose', 'zed', 'warp', 'codex',
      ];

      for (const client of validClients) {
        const res = await request(app)
          .post('/api/setup/install')
          .send({ client });

        // Should not get 400 (bad request) — may get 500 if install-mcp
        // isn't available in test env, but the validation passed
        expect(res.status).not.toBe(400);
      }
    });

    it('accepts version parameter for pinned installs', async () => {
      const res = await request(app)
        .post('/api/setup/install')
        .send({ client: 'claude', version: '2.0.2' });

      // Should not get 400 — version format is valid
      expect(res.status).not.toBe(400);
    });

    it('rejects invalid version format', async () => {
      const res = await request(app)
        .post('/api/setup/install')
        .send({ client: 'claude', version: '../../../etc' });

      // May get 429 if rate limited from prior tests, but should never succeed
      expect([400, 429]).toContain(res.status);
      if (res.status === 400) {
        expect(res.body.error).toMatch(/Invalid version/);
      }
    });

    it('normalizes client name to lowercase', async () => {
      const res = await request(app)
        .post('/api/setup/install')
        .send({ client: 'CLAUDE' });

      // Should not reject as unsupported
      expect(res.status).not.toBe(400);
    });
  });

  describe('GET /api/setup/version', () => {
    it('returns running version info', async () => {
      const res = await request(app)
        .get('/api/setup/version')
        .expect(200);

      expect(res.body.running).toBeDefined();
      expect(res.body.running.version).toBeDefined();
      expect(res.body.running.mcpbUrl).toContain('dollhousemcp-');
      expect(res.body.running.mcpbUrl).toContain('.mcpb');
      expect(res.body.latest).toBeDefined();
      expect(typeof res.body.isLatest).toBe('boolean');
    });

    it('mcpb URL contains the running version', async () => {
      const res = await request(app).get('/api/setup/version');
      expect(res.body.running.mcpbUrl).toContain(res.body.running.version);
    });
  });

  describe('GET /api/setup/mcpb', () => {
    it('returns a redirect (302)', async () => {
      const res = await request(app)
        .get('/api/setup/mcpb')
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('github.com/DollhouseMCP/mcp-server/releases');
      expect(res.headers.location).toContain('.mcpb');
    });
  });

  describe('GET /api/setup/detect', () => {
    it('returns detection results for known clients', async () => {
      const res = await request(app)
        .get('/api/setup/detect')
        .expect(200);

      expect(typeof res.body).toBe('object');
      // Should have entries for the detectable clients
      const knownClients = ['claude', 'claude-code', 'cursor', 'windsurf', 'lmstudio', 'gemini-cli', 'codex'];
      for (const client of knownClients) {
        expect(res.body[client]).toBeDefined();
        expect(res.body[client].name).toBeDefined();
        expect(typeof res.body[client].installed).toBe('boolean');
        expect(res.body[client].configPath).toBeDefined();
      }
    });

    it('includes currentConfig when installed', async () => {
      const res = await request(app)
        .get('/api/setup/detect')
        .expect(200);

      // At least check the structure — on CI there may be no installs
      for (const info of Object.values(res.body) as Array<Record<string, unknown>>) {
        if (info.installed) {
          // Installed entries should have configPath
          expect(info.configPath).toBeTruthy();
        }
      }
    });
  });

  describe('POST /api/setup/open-config', () => {
    it('rejects missing client field', async () => {
      const res = await request(app)
        .post('/api/setup/open-config')
        .send({})
        .expect(400);

      expect(res.body.error).toMatch(/Missing required field/);
    });

    it('rejects non-string client field', async () => {
      const res = await request(app)
        .post('/api/setup/open-config')
        .send({ client: null })
        .expect(400);

      expect(res.body.error).toMatch(/Missing required field/);
    });

    it('rejects clients without known config paths', async () => {
      const res = await request(app)
        .post('/api/setup/open-config')
        .send({ client: 'vscode' })
        .expect(400);

      expect(res.body.error).toMatch(/Cannot open config/);
    });

    it('rejects unsupported clients', async () => {
      const res = await request(app)
        .post('/api/setup/open-config')
        .send({ client: 'not-real' })
        .expect(400);

      expect(res.body.error).toMatch(/Cannot open config/);
    });

    it('does not reject valid openable client names', async () => {
      const openableClients = [
        'claude', 'claude-code', 'cursor', 'windsurf', 'lmstudio', 'gemini-cli', 'codex',
      ];

      // Only test that the validation passes (not 400) — don't actually open editors
      // as that blocks on Windows CI (notepad waits for user interaction).
      // We test one client to verify the route works, with a short timeout.
      const res = await request(app)
        .post('/api/setup/open-config')
        .send({ client: openableClients[0] })
        .timeout(5000);

      // 400 = validation rejected, anything else = validation passed
      expect(res.status).not.toBe(400);
    });

    it('rejects clients not in the openable set', () => {
      // VS Code and Cline are not in OPENABLE_CLIENTS
      const nonOpenable = ['vscode', 'cline', 'roo-cline', 'random'];
      return Promise.all(nonOpenable.map(async (client) => {
        const res = await request(app)
          .post('/api/setup/open-config')
          .send({ client });
        expect(res.status).toBe(400);
      }));
    });
  });
});

// ── HTML content integrity tests ──────────────────────────────────────

describe('Setup Tab — HTML Content Integrity', () => {
  let html: string;

  beforeAll(async () => {
    html = await readFileAsync(join(PUBLIC_DIR, 'index.html'), 'utf-8');
  });

  describe('Tab structure', () => {
    it('has a Setup tab button', () => {
      expect(html).toContain('data-tab="setup"');
    });

    it('has a tab-setup panel', () => {
      expect(html).toContain('id="tab-setup"');
    });

    it('has setup.css linked', () => {
      expect(html).toContain('href="setup.css"');
    });

    it('has setup.js loaded', () => {
      expect(html).toContain('src="setup.js"');
    });

    it('loads setup.js before app.js', () => {
      const setupIdx = html.indexOf('src="setup.js"');
      const appIdx = html.indexOf('src="app.js"');
      expect(setupIdx).toBeLessThan(appIdx);
    });
  });

  describe('Platform tabs', () => {
    const expectedPlatforms = [
      'claude-desktop', 'claude-code', 'cursor', 'vscode',
      'codex', 'gemini', 'windsurf', 'cline', 'lmstudio',
    ];

    it.each(expectedPlatforms)('has tab button for %s', (platform) => {
      expect(html).toContain(`id="setup-tab-${platform}"`);
    });

    it.each(expectedPlatforms)('has panel for %s', (platform) => {
      expect(html).toContain(`id="setup-panel-${platform}"`);
    });

    it.each(expectedPlatforms)('tab aria-controls matches panel id for %s', (platform) => {
      expect(html).toContain(`aria-controls="setup-panel-${platform}"`);
    });
  });

  describe('Install Now buttons', () => {
    const installClients = [
      'claude', 'claude-code', 'cursor', 'vscode',
      'codex', 'gemini-cli', 'windsurf', 'cline',
    ];

    it.each(installClients)('has Install Now button for %s', (client) => {
      expect(html).toContain(`data-install-client="${client}"`);
    });

    it.each(installClients)('has status element for %s', (client) => {
      expect(html).toContain(`data-install-status="${client}"`);
    });

    it('LM Studio does not have Install Now button (not supported by install-mcp)', () => {
      // LM Studio panel should not have an install button
      const lmPanel = html.slice(
        html.indexOf('id="setup-panel-lmstudio"'),
        html.indexOf('</section>', html.indexOf('id="setup-panel-lmstudio"'))
      );
      expect(lmPanel).not.toContain('data-install-client');
    });
  });

  describe('Open config file buttons', () => {
    const openClients = [
      'claude', 'claude-code', 'cursor', 'codex',
      'gemini-cli', 'windsurf', 'lmstudio',
    ];

    it.each(openClients)('has Open config button for %s', (client) => {
      expect(html).toContain(`data-open-client="${client}"`);
    });
  });

  describe('Config snippets', () => {
    it('all JSON copy-text attributes are valid JSON', () => {
      const copyTextRegex = /data-copy-text='(\{[^']+\})'/g;
      let match;
      let count = 0;

      while ((match = copyTextRegex.exec(html)) !== null) {
        count++;
        const jsonStr = match[1];
        expect(() => JSON.parse(jsonStr)).not.toThrow();

        const parsed = JSON.parse(jsonStr);
        // Should contain dollhousemcp server config
        const hasServer =
          parsed.mcpServers?.dollhousemcp ||
          parsed.servers?.dollhousemcp;
        expect(hasServer).toBeTruthy();
      }

      expect(count).toBeGreaterThan(0);
    });

    it('VS Code config uses "servers" not "mcpServers"', () => {
      const start = html.indexOf('id="setup-panel-vscode"');
      const end = html.indexOf('</section>', start) + '</section>'.length;
      const vscodePanel = html.slice(start, end);
      // The copy-text and displayed code should use "servers"
      expect(vscodePanel).toContain('"servers"');
      // Should not have mcpServers in copy-text attributes
      const copyTexts = vscodePanel.match(/data-copy-text='([^']+)'/g) || [];
      for (const ct of copyTexts) {
        expect(ct).not.toContain('mcpServers');
      }
    });

    it('all non-VS Code JSON configs use "mcpServers"', () => {
      const panelsToCheck = ['claude-desktop', 'cursor', 'windsurf', 'cline', 'lmstudio', 'gemini'];
      for (const panel of panelsToCheck) {
        const start = html.indexOf(`id="setup-panel-${panel}"`);
        if (start === -1) continue;
        const end = html.indexOf('</section>', start);
        const panelHtml = html.slice(start, end);
        if (panelHtml.includes('data-copy-text=\'{')) {
          expect(panelHtml).toContain('"mcpServers"');
        }
      }
    });

    it('all configs reference @dollhousemcp/mcp-server@latest', () => {
      // No @rc references should remain
      expect(html).not.toContain('@dollhousemcp/mcp-server@rc');
      expect(html).toContain('@dollhousemcp/mcp-server@latest');
    });

    it('Codex TOML config is valid TOML syntax', () => {
      const codexPanel = html.slice(
        html.indexOf('id="setup-panel-codex"'),
        html.indexOf('</section>', html.indexOf('id="setup-panel-codex"'))
      );
      expect(codexPanel).toContain('[mcp_servers.dollhousemcp]');
      expect(codexPanel).toContain('command = "npx"');
    });

    it('Claude Code terminal command uses claude mcp add', () => {
      expect(html).toContain('claude mcp add dollhousemcp -- npx -y @dollhousemcp/mcp-server@latest');
    });

    it('Codex terminal command uses codex mcp add', () => {
      expect(html).toContain('codex mcp add dollhousemcp -- npx -y @dollhousemcp/mcp-server@latest');
    });

    it('Gemini terminal command uses gemini mcp add', () => {
      expect(html).toContain('gemini mcp add dollhousemcp -- npx -y @dollhousemcp/mcp-server@latest');
    });
  });

  describe('External links', () => {
    it('.mcpb button uses local redirect endpoint', () => {
      expect(html).toContain('href="/api/setup/mcpb"');
    });

    it('.mcpb download is inside Claude Desktop panel only', () => {
      const claudePanel = html.slice(
        html.indexOf('id="setup-panel-claude-desktop"'),
        html.indexOf('<!-- Claude Code -->')
      );
      expect(claudePanel).toContain('/api/setup/mcpb');
      expect(claudePanel).toContain('double-click');
      expect(claudePanel).toContain('pinned version');
    });

    it('.mcpb section is hidden by default (shown only for pinned method)', () => {
      const mcpbSection = /id="setup-mcpb-section"[^>]*/.exec(html);
      expect(mcpbSection?.[0]).toContain('hidden');
    });

    it('does not contain broken .mcpb direct download link', () => {
      expect(html).not.toContain('/download/dollhousemcp.mcpb');
    });

    it('does not hardcode .mcpb version in URL', () => {
      expect(html).not.toContain('dollhousemcp-2.');
    });

    it('quick start guide link points to main branch', () => {
      expect(html).toContain('https://github.com/DollhouseMCP/mcp-server/blob/main/docs/guides/quick-start.md');
    });
  });

  describe('Install method toggle', () => {
    it('has npx method button', () => {
      expect(html).toContain('data-method="npx"');
    });

    it('has global method button', () => {
      expect(html).toContain('data-method="global"');
    });

    it('npx is active by default', () => {
      // The button with data-method="npx" should have is-active class
      const npxBtn = /class="[^"]*is-active[^"]*"[^>]*data-method="npx"/.exec(html);
      expect(npxBtn).not.toBeNull();
    });

    it('has pinned install prerequisite section', () => {
      expect(html).toContain('id="setup-pinned-prereq"');
    });

    it('pinned prereq is hidden by default', () => {
      const prereq = /id="setup-pinned-prereq"[^>]*/.exec(html);
      expect(prereq?.[0]).toContain('hidden');
    });

    it('shows global install command', () => {
      expect(html).toContain('npm install -g @dollhousemcp/mcp-server');
    });

    it('shows local project install command', () => {
      expect(html).toContain('mkdir -p ~/mcp-servers');
      expect(html).toContain('npm install @dollhousemcp/mcp-server');
    });

    it('shows local install node path hint', () => {
      expect(html).toContain('node ~/mcp-servers/node_modules/@dollhousemcp/mcp-server/dist/index.js');
    });
  });

  describe('Verify section', () => {
    it('has verification prompt', () => {
      expect(html).toContain('What DollhouseMCP tools do you have available?');
    });

    it('has example try prompts', () => {
      expect(html).toContain('List all available Dollhouse personas');
      expect(html).toContain('Activate the debug detective persona');
      expect(html).toContain('Open the portfolio browser');
    });
  });
});

// ── Setup.js content integrity tests ──────────────────────────────────

describe('Setup Tab — JavaScript Integrity', () => {
  let js: string;

  beforeAll(async () => {
    js = await readFileAsync(join(PUBLIC_DIR, 'setup.js'), 'utf-8');
  });

  describe('Config data', () => {
    it('has config entries for all platforms with JSON configs', () => {
      // Keys may be quoted or unquoted in the JS object literal
      const platforms = [
        'claude-desktop', 'cursor', 'windsurf', 'cline',
        'gemini', 'lmstudio', 'vscode',
      ];
      for (const p of platforms) {
        const hasQuoted = js.includes(`'${p}':`);
        const hasUnquoted = js.includes(`${p}:`);
        expect(hasQuoted || hasUnquoted).toBe(true);
      }
    });

    it('has config entries for CLI-based platforms', () => {
      // claude-code must be quoted (has hyphen), codex can be unquoted
      expect(js).toContain("'claude-code':");
      const hasCodex = js.includes("'codex':") || js.includes("codex:");
      expect(hasCodex).toBe(true);
    });

    it('VS Code uses "servers" key', () => {
      // The platformJson/platformCli call for vscode should use 'servers'
      expect(js).toContain("vscode: platformJson('servers'");
    });

    it('references @latest not @rc', () => {
      expect(js).not.toContain('@rc');
      expect(js).toContain('@latest');
    });

    it('builds pinned configs with version parameter', () => {
      expect(js).toContain('buildConfigs');
      expect(js).toContain('pinnedVersion');
    });

    it('fetches version from API', () => {
      expect(js).toContain('/api/setup/version');
      expect(js).toContain('fetchVersion');
    });
  });

  describe('Functions', () => {
    it('exports OS detection', () => {
      expect(js).toContain('detectOS');
    });

    it('exports method toggle init', () => {
      expect(js).toContain('initMethodToggle');
    });

    it('exports platform tabs init', () => {
      expect(js).toContain('initPlatformTabs');
    });

    it('exports copy buttons init', () => {
      expect(js).toContain('initCopyButtons');
    });

    it('exports install buttons init', () => {
      expect(js).toContain('initInstallButtons');
    });

    it('exports open buttons init', () => {
      expect(js).toContain('initOpenButtons');
    });
  });
});

// ── Setup.css integrity tests ─────────────────────────────────────────

describe('Setup Tab — CSS Integrity', () => {
  let css: string;

  beforeAll(async () => {
    css = await readFileAsync(join(PUBLIC_DIR, 'setup.css'), 'utf-8');
  });

  it('defines setup-page layout', () => {
    expect(css).toContain('.setup-page');
  });

  it('defines platform tab styles', () => {
    expect(css).toContain('.setup-platform-tab');
    expect(css).toContain('.setup-platform-tab.is-active');
  });

  it('defines install button states', () => {
    expect(css).toContain('.setup-install-btn.is-loading');
    expect(css).toContain('.setup-install-btn.is-success');
  });

  it('defines method toggle', () => {
    expect(css).toContain('.setup-method-toggle');
    expect(css).toContain('.setup-method-btn');
    expect(css).toContain('.setup-method-btn.is-active');
  });

  it('defines open config button', () => {
    expect(css).toContain('.setup-open-btn');
  });

  it('defines copy button styles', () => {
    expect(css).toContain('.setup-copy-btn');
    expect(css).toContain('.setup-copy-btn[data-copied]');
  });

  it('has dark mode support', () => {
    expect(css).toContain('[data-theme="dark"]');
  });

  it('has responsive styles', () => {
    expect(css).toContain('@media');
    expect(css).toContain('max-width: 640px');
  });
});

// ── Regression tests ──────────────────────────────────────────────────
// Lock down fixes and refinements to prevent backsliding.

describe('Setup Tab — Regressions', () => {
  let html: string;
  let js: string;
  let css: string;

  beforeAll(async () => {
    html = await readFileAsync(join(PUBLIC_DIR, 'index.html'), 'utf-8');
    js = await readFileAsync(join(PUBLIC_DIR, 'setup.js'), 'utf-8');
    css = await readFileAsync(join(PUBLIC_DIR, 'setup.css'), 'utf-8');
  });

  describe('No @rc references anywhere', () => {
    it('HTML has no @rc package references', () => {
      expect(html).not.toContain('@dollhousemcp/mcp-server@rc');
    });

    it('JS has no @rc package references', () => {
      expect(js).not.toContain('@dollhousemcp/mcp-server@rc');
    });
  });

  describe('.mcpb link never hardcoded', () => {
    it('no direct /download/dollhousemcp.mcpb URL', () => {
      expect(html).not.toContain('/download/dollhousemcp.mcpb');
    });

    it('no hardcoded versioned .mcpb filename in HTML', () => {
      // Should never have dollhousemcp-X.Y.Z.mcpb in the HTML
      expect(html).not.toMatch(/dollhousemcp-\d+\.\d+\.\d+\.mcpb/);
    });

    it('uses /api/setup/mcpb endpoint for download', () => {
      expect(html).toContain('href="/api/setup/mcpb"');
    });
  });

  describe('UX copy quality', () => {
    it('auto-install leads with action not mechanism', () => {
      // "Pulls the latest version" should come before "Uses npx"
      const pullsIdx = html.indexOf('Pulls the latest version');
      const usesNpxIdx = html.indexOf('Uses <code>npx @latest</code>');
      expect(pullsIdx).toBeGreaterThan(-1);
      expect(usesNpxIdx).toBeGreaterThan(-1);
      expect(pullsIdx).toBeLessThan(usesNpxIdx);
    });

    it('method toggle says "Auto-updating" not "npx"', () => {
      // The toggle button label should lead with the benefit
      const toggleSection = html.slice(
        html.indexOf('setup-method-toggle'),
        html.indexOf('setup-pinned-prereq')
      );
      expect(toggleSection).toContain('<strong>Auto-updating</strong>');
      expect(toggleSection).toContain('<strong>Pinned version</strong>');
    });
  });

  describe('Pinned version has all three sub-options', () => {
    it('shows npx pinned option (no install needed badge)', () => {
      expect(html).toContain('no install needed');
    });

    it('shows global install option', () => {
      expect(html).toContain('id="pinned-global-cmd"');
    });

    it('shows project-local install option', () => {
      expect(html).toContain('id="pinned-local-cmd"');
    });

    it('has version label that gets populated dynamically', () => {
      expect(html).toContain('id="pinned-version-label"');
    });
  });

  describe('Version fetching in JS', () => {
    it('fetches from /api/setup/version', () => {
      expect(js).toContain("fetch('/api/setup/version')");
    });

    it('updates pinned-version-label element', () => {
      expect(js).toContain('pinned-version-label');
    });

    it('updates pinned-global-cmd element', () => {
      expect(js).toContain('pinned-global-cmd');
    });

    it('updates pinned-local-cmd element', () => {
      expect(js).toContain('pinned-local-cmd');
    });

    it('rebuilds configs with fetched version', () => {
      expect(js).toContain('configs = buildConfigs(pinnedVersion)');
    });
  });

  describe('Tab persistence', () => {
    it('saves active tab to localStorage on click', () => {
      // app.js should store tab in localStorage
      const appJs = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf-8');
      expect(appJs).toContain('dollhousemcp-active-tab');
      expect(appJs).toContain("localStorage.setItem(TAB_KEY, tab)");
    });

    it('restores saved tab on page load', () => {
      const appJs = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf-8');
      expect(appJs).toContain("localStorage.getItem(TAB_KEY)");
    });

    it('first visit defaults to setup tab', () => {
      const appJs = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf-8');
      expect(appJs).toContain("switchToTab('setup')");
      expect(appJs).toContain('dollhousemcp-setup-seen');
    });
  });

  describe('Claude Code has manual config option', () => {
    it('Claude Code panel has Open config file button', () => {
      expect(html).toContain('data-open-client="claude-code"');
    });

    it('Claude Code panel has manual JSON config block', () => {
      const panel = html.slice(
        html.indexOf('id="setup-panel-claude-code"'),
        html.indexOf('</section>', html.indexOf('id="setup-panel-claude-code"'))
      );
      expect(panel).toContain('~/.claude.json');
      expect(panel).toContain('Or add manually');
    });
  });

  describe('All platforms have consistent structure', () => {
    const allPlatforms = [
      'claude-desktop', 'claude-code', 'cursor', 'vscode',
      'codex', 'gemini', 'windsurf', 'cline', 'lmstudio',
    ];

    it.each(allPlatforms)('%s panel has at least one copy button', (platform) => {
      const start = html.indexOf(`id="setup-panel-${platform}"`);
      const end = html.indexOf('</section>', start);
      const panel = html.slice(start, end);
      expect(panel).toContain('setup-copy-btn');
    });

    it.each(allPlatforms)('%s panel has at least one code block', (platform) => {
      const start = html.indexOf(`id="setup-panel-${platform}"`);
      const end = html.indexOf('</section>', start);
      const panel = html.slice(start, end);
      expect(panel).toContain('setup-code-block');
    });
  });

  describe('Config comparison logic', () => {
    it('JS has configsMatch function', () => {
      expect(js).toContain('configsMatch');
    });

    it('JS has compareJsonConfig function', () => {
      expect(js).toContain('compareJsonConfig');
    });

    it('JS has updateDetectionState function', () => {
      expect(js).toContain('updateDetectionState');
    });

    it('JS stores detected configs for comparison', () => {
      expect(js).toContain('detectedConfigs');
    });

    it('JS re-evaluates on method toggle', () => {
      // updateDetectionState should be called when toggle changes
      expect(js).toContain('updateDetectionState()');
    });

    it('JS shows green match state when configs match', () => {
      expect(js).toContain('is-match');
      expect(js).toContain('No changes would be made');
      expect(js).toContain('Already configured');
    });

    it('JS shows amber warning when configs differ', () => {
      expect(js).toContain('overwrite the existing configuration');
    });

    it('JS disables Install button when config matches', () => {
      // When matched, button should be disabled
      expect(js).toContain("installBtn.disabled = true");
      expect(js).toContain("installBtn.classList.add('is-match')");
    });

    it('JS re-enables Install button when config differs', () => {
      expect(js).toContain("installBtn.disabled = false");
      expect(js).toContain("installBtn.classList.remove('is-match')");
    });

    it('JS passes version to install API when in pinned mode', () => {
      expect(js).toContain('payload.version = pinnedVersion');
    });

    it('JS updates button label to show pinned version', () => {
      expect(js).toContain('updateInstallButtonLabels');
      expect(js).toContain('Install v${pinnedVersion}');
    });
  });

  describe('Detection UI', () => {
    it('JS fetches from /api/setup/detect', () => {
      expect(js).toContain('/api/setup/detect');
      expect(js).toContain('fetchDetection');
    });

    it('JS creates installed notice with overwrite warning', () => {
      expect(js).toContain('already configured');
      expect(js).toContain('overwrite');
    });

    it('JS adds tab badge for installed clients', () => {
      expect(js).toContain('setup-tab-badge');
    });

    it('JS shows current config in expandable details', () => {
      expect(js).toContain('<details>');
      expect(js).toContain('Current config');
    });

    it('JS escapes HTML in config display', () => {
      expect(js).toContain('escapeHtml');
    });

    it('CSS defines tab badge', () => {
      expect(css).toContain('.setup-tab-badge');
    });

    it('CSS defines installed notice', () => {
      expect(css).toContain('.setup-installed-notice');
    });

    it('CSS defines green match state for notice', () => {
      expect(css).toContain('.setup-installed-notice.is-match');
    });

    it('CSS defines green match state for tab badge', () => {
      expect(css).toContain('.setup-tab-badge.is-match');
    });

    it('CSS defines match state for install button', () => {
      expect(css).toContain('.setup-install-btn.is-match');
    });
  });

  describe('CSS covers all interactive states', () => {
    it('has hover state for platform tabs', () => {
      expect(css).toContain('.setup-platform-tab:hover');
    });

    it('has disabled state for open button', () => {
      expect(css).toContain('.setup-open-btn[disabled]');
    });

    it('has success state for install button', () => {
      expect(css).toContain('.setup-install-btn.is-success');
    });

    it('has loading state for install button', () => {
      expect(css).toContain('.setup-install-btn.is-loading');
    });

    it('has success/error states for install status', () => {
      expect(css).toContain('.setup-install-status.is-success');
      expect(css).toContain('.setup-install-status.is-error');
    });

    it('has h4 styling for pinned sub-options', () => {
      expect(css).toContain('.setup-method h4');
    });
  });
});

// ── Dependency check ──────────────────────────────────────────────────

describe('Setup Tab — Dependencies', () => {
  let packageJson: Record<string, unknown>;

  beforeAll(async () => {
    const raw = await readFileAsync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8');
    packageJson = JSON.parse(raw);
  });

  it('install-mcp is a runtime dependency', () => {
    const deps = packageJson.dependencies as Record<string, string>;
    expect(deps['install-mcp']).toBeDefined();
  });

  it('install-mcp is not a devDependency', () => {
    const devDeps = (packageJson.devDependencies || {}) as Record<string, string>;
    expect(devDeps['install-mcp']).toBeUndefined();
  });
});
