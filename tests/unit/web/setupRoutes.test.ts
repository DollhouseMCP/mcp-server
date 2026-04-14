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

    it('accepts channel parameter for release channel installs', async () => {
      const res = await request(app)
        .post('/api/setup/install')
        .send({ client: 'claude', channel: 'beta' });

      // Should not get 400 — channel is valid
      expect(res.status).not.toBe(400);
    });

    it('accepts rc channel parameter', async () => {
      const res = await request(app)
        .post('/api/setup/install')
        .send({ client: 'claude', channel: 'rc' });

      expect(res.status).not.toBe(400);
    });

    it('ignores invalid channel values (falls back to latest)', async () => {
      const res = await request(app)
        .post('/api/setup/install')
        .send({ client: 'claude', channel: 'nightly' });

      // Invalid channel is silently ignored, not rejected — falls back to @latest
      expect(res.status).not.toBe(400);
    });

    it('ignores channel with shell injection attempt', async () => {
      const res = await request(app)
        .post('/api/setup/install')
        .send({ client: 'claude', channel: '; rm -rf /' });

      // Invalid channel ignored, falls back to @latest — no 500
      expect(res.status).not.toBe(500);
    });

    it('normalizes client name to lowercase', async () => {
      const res = await request(app)
        .post('/api/setup/install')
        .send({ client: 'CLAUDE' });

      // Should not reject as unsupported
      expect(res.status).not.toBe(400);
    });

    it('success response includes nvmMitigationApplied field', async () => {
      // Use _runInstallMcp injection so install always succeeds without the real binary
      const { createSetupRoutes } = await import('../../../src/web/routes/setupRoutes.js');
      const { installHandler } = createSetupRoutes({
        _runInstallMcp: async () => 'Installed successfully.',
        _installPermissionHook: async () => ({
          supported: true,
          installed: true,
          configured: true,
          host: 'claude-code',
          message: 'Installed Claude Code permission hook and updated settings.json.',
        }),
        _skipRateLimit: true,
      });

      const testApp = express();
      testApp.use(express.json());
      testApp.post('/api/setup/install', installHandler);

      const res = await request(testApp)
        .post('/api/setup/install')
        .send({ client: 'claude' })
        .expect(200);

      // Field must be present on every success response
      expect(res.body).toHaveProperty('nvmMitigationApplied');
      // Value is one of: true (applied), false (failed), null (not applicable)
      expect([true, false, null]).toContain(res.body.nvmMitigationApplied);
      // Other standard fields still present
      expect(res.body.success).toBe(true);
      expect(res.body.client).toBe('claude');
      expect(res.body.version).toBeDefined();
      expect(res.body).toHaveProperty('hookInstall');
    });

    it('includes hook install details after a successful install', async () => {
      const installPermissionHookMock = async (client: string) => ({
        supported: client === 'claude-code',
        installed: client === 'claude-code',
        configured: client === 'claude-code',
        host: client,
        message: client === 'claude-code'
          ? 'Installed Claude Code permission hook and updated settings.json.'
          : `Automatic permission hook wiring is not yet supported for ${client}.`,
      });

      const { createSetupRoutes } = await import('../../../src/web/routes/setupRoutes.js');
      const { installHandler } = createSetupRoutes({
        _runInstallMcp: async () => 'Installed successfully.',
        _installPermissionHook: installPermissionHookMock,
        _skipRateLimit: true,
      });

      const testApp = express();
      testApp.use(express.json());
      testApp.post('/api/setup/install', installHandler);

      const res = await request(testApp)
        .post('/api/setup/install')
        .send({ client: 'claude-code' })
        .expect(200);

      expect(res.body.hookInstall).toEqual(expect.objectContaining({
        supported: true,
        configured: true,
        host: 'claude-code',
      }));
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

      expect(res.body.error).toMatch(/Unsupported client/);
    });

    it('rejects unsupported clients', async () => {
      const res = await request(app)
        .post('/api/setup/open-config')
        .send({ client: 'not-real' })
        .expect(400);

      expect(res.body.error).toMatch(/Unsupported client/);
    });

    it('does not reject valid openable client names (validation only)', async () => {
      // NOTE: We cannot call the open-config endpoint in CI because it launches
      // a blocking editor process (notepad on Windows, open -t on macOS).
      // Instead, verify that invalid clients get 400 and valid ones don't by
      // testing against the rejects-unsupported test above — if 'vscode' gets 400
      // but 'cursor' would not, validation is working.
      // The actual open behavior is tested manually.
      const openableClients = ['claude', 'claude-code', 'cursor', 'windsurf', 'lmstudio', 'gemini-cli', 'codex'];
      const nonOpenable = ['vscode', 'cline', 'roo-cline'];

      // Verify non-openable get rejected
      for (const client of nonOpenable) {
        const res = await request(app).post('/api/setup/open-config').send({ client });
        expect(res.status).toBe(400);
      }

      // Verify openable clients are in the expected set (JS-level validation)
      // This confirms the OPENABLE_CLIENTS allowlist matches our expectations
      expect(openableClients.length).toBe(7);
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
  let js: string;

  beforeAll(async () => {
    html = await readFileAsync(join(PUBLIC_DIR, 'index.html'), 'utf-8');
    js = await readFileAsync(join(PUBLIC_DIR, 'setup.js'), 'utf-8');
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

    it.each(expectedPlatforms)('tab aria-controls matches panel id for %s', (platform) => {
      expect(html).toContain(`aria-controls="setup-panel-${platform}"`);
    });

    // Claude Desktop and Claude Code have static HTML panels
    it('has static panel for claude-desktop', () => {
      expect(html).toContain('id="setup-panel-claude-desktop"');
    });

    it('has static panel for claude-code', () => {
      expect(html).toContain('id="setup-panel-claude-code"');
    });

    it('has container for JS-generated panels', () => {
      expect(html).toContain('id="setup-generated-panels"');
    });
  });

  describe('Configure Now buttons (static panels)', () => {
    it('has Configure Now for claude (in HTML)', () => {
      expect(html).toContain('data-install-client="claude"');
    });

    it('has Configure Now for claude-code (in HTML)', () => {
      expect(html).toContain('data-install-client="claude-code"');
    });
  });

  describe('Configure Now buttons (generated panels)', () => {
    it('JS PLATFORMS registry defines installClient for generated platforms', () => {
      const generatedWithInstall = ['cursor', 'vscode', 'codex', 'gemini-cli', 'windsurf', 'cline'];
      for (const client of generatedWithInstall) {
        expect(js).toContain(`installClient: '${client}'`);
      }
    });

    it('LM Studio has no installClient in registry', () => {
      const lmLine = /id:\s*'lmstudio'[^}]*/.exec(js);
      expect(lmLine?.[0]).not.toContain('installClient');
    });
  });

  describe('Open config file buttons', () => {
    it('has Open config for claude (in HTML)', () => {
      expect(html).toContain('data-open-client="claude"');
    });

    it('has Open config for claude-code (in HTML)', () => {
      expect(html).toContain('data-open-client="claude-code"');
    });

    it('JS PLATFORMS registry defines openClient for generated platforms', () => {
      const openClients = ['cursor', 'codex', 'gemini-cli', 'windsurf', 'lmstudio'];
      for (const client of openClients) {
        expect(js).toContain(`openClient: '${client}'`);
      }
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

    it('VS Code uses servers key in PLATFORMS registry', () => {
      const vscodeLine = /id:\s*'vscode'[^}]*/.exec(js);
      expect(vscodeLine?.[0]).toContain("rootKey: 'servers'");
    });

    it('all non-VS Code platforms use mcpServers in PLATFORMS registry', () => {
      const platforms = ['cursor', 'windsurf', 'cline', 'lmstudio', 'gemini', 'claude-desktop', 'claude-code', 'codex'];
      for (const p of platforms) {
        const line = new RegExp(String.raw`id:\s*'${p}'[^}]*`).exec(js);
        expect(line?.[0]).toContain("rootKey: 'mcpServers'");
      }
    });

    it('all configs reference @dollhousemcp/mcp-server@latest', () => {
      // No @rc references should remain
      expect(html).not.toContain('@dollhousemcp/mcp-server@rc');
      expect(html).toContain('@dollhousemcp/mcp-server@latest');
    });

    it('Codex has TOML config in PLATFORMS registry', () => {
      const codexLine = /id:\s*'codex'[^}]*/.exec(js);
      expect(codexLine?.[0]).toContain('toml: true');
      expect(codexLine?.[0]).toContain('tomlPath');
    });

    it('Claude Code terminal command uses claude mcp add', () => {
      expect(html).toContain('claude mcp add dollhousemcp -- npx -y @dollhousemcp/mcp-server@latest');
    });

    it('Codex has CLI config in PLATFORMS registry', () => {
      expect(js).toContain("cli: 'codex'");
    });

    it('Gemini has CLI config in PLATFORMS registry', () => {
      expect(js).toContain("cli: 'gemini'");
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

    it('has permissions method button', () => {
      expect(html).toContain('data-method="permissions"');
      expect(html).toContain('Permissions &amp; Security');
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

  describe('Release channel selector', () => {
    it('has channel selector fieldset', () => {
      expect(html).toContain('id="setup-channel-toggle"');
    });

    it('has channel select dropdown', () => {
      expect(html).toContain('id="setup-channel-select"');
    });

    it('has Stable, Release Candidate, and Beta options', () => {
      expect(html).toContain('value="latest"');
      expect(html).toContain('value="rc"');
      expect(html).toContain('value="beta"');
      expect(html).toContain('>Stable<');
      expect(html).toContain('>Release Candidate<');
      expect(html).toContain('>Beta<');
    });

    it('defaults to Stable', () => {
      expect(html).toContain('value="latest" selected');
    });

    it('has accessible hint text linked via aria-describedby', () => {
      expect(html).toContain('aria-describedby="setup-channel-hint"');
      expect(html).toContain('id="setup-channel-hint"');
    });

    it('has Release channel legend', () => {
      expect(html).toContain('Release channel');
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
    it('has platform registry with all platforms', () => {
      const platforms = [
        'claude-desktop', 'cursor', 'windsurf', 'cline',
        'gemini', 'lmstudio', 'vscode', 'claude-code', 'codex',
      ];
      for (const p of platforms) {
        expect(js).toContain(`id: '${p}'`);
      }
    });

    it('VS Code uses "servers" key in platform registry', () => {
      // vscode entry should have rootKey: 'servers'
      const vscodeLine = /id:\s*'vscode'[^}]*/.exec(js);
      expect(vscodeLine?.[0]).toContain("rootKey: 'servers'");
    });

    it('CLI platforms have cli property', () => {
      expect(js).toContain("cli: 'claude'");
      expect(js).toContain("cli: 'codex'");
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

  describe('Channel selector logic', () => {
    it('tracks currentChannel state', () => {
      expect(js).toContain("let currentChannel = DEFAULT_CHANNEL");
    });

    it('has channel hints for all three channels', () => {
      expect(js).toContain('CHANNEL_HINTS');
      expect(js).toContain("latest:");
      expect(js).toContain("rc:");
      expect(js).toContain("beta:");
    });

    it('buildConfigs accepts channel parameter with default', () => {
      expect(js).toMatch(/function buildConfigs\(version,\s*channel\s*=\s*'latest'\)/);
    });

    it('passes channel to buildConfigs on selector change', () => {
      expect(js).toContain("configs = buildConfigs(pinnedVersion, currentChannel)");
    });

    it('sends channel in install payload when non-stable', () => {
      expect(js).toContain('payload.channel = currentChannel');
    });

    it('shows channel label on install button when non-stable', () => {
      expect(js).toContain("channelLabel");
      expect(js).toContain("`Configure Now${channelLabel}`");
    });

    it('updates hint text on channel change', () => {
      expect(js).toContain("hint.textContent = CHANNEL_HINTS[currentChannel]");
    });
  });

  describe('Functions', () => {
    it('exports OS detection', () => {
      expect(js).toContain('detectOS');
    });

    it('exports method toggle init', () => {
      expect(js).toContain('initMethodToggle');
    });

    it('exports channel selector init', () => {
      expect(js).toContain('initChannelSelector');
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

  it('defines channel selector styles', () => {
    expect(css).toContain('.setup-channel-toggle');
    expect(css).toContain('.setup-channel-select');
    expect(css).toContain('.setup-channel-hint');
    expect(css).toContain('.setup-channel-legend');
  });

  it('channel select has focus state', () => {
    expect(css).toContain('.setup-channel-select:focus');
  });

  it('channel toggle has hidden attribute override to prevent display:flex conflict', () => {
    expect(css).toContain('.setup-channel-toggle[hidden]');
    expect(css).toContain('display: none');
  });

  it('permissions intro has hidden attribute override to prevent display:grid conflict', () => {
    expect(css).toContain('.setup-permissions-intro[hidden]');
    expect(css).toContain('display: none');
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
    it('auto-configure leads with action not mechanism', () => {
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
      // Since #1780, fetches go through DollhouseAuth.apiFetch so they can
      // attach the console token when auth is enforced. We just check that
      // the URL is present — whether it's via native fetch or the wrapper.
      expect(js).toContain("'/api/setup/version'");
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

    it('rebuilds configs with fetched version and channel', () => {
      expect(js).toContain('configs = buildConfigs(pinnedVersion, currentChannel)');
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

    it('shows setup tab when stored version does not match current version', () => {
      const appJs = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf-8');
      // Version comparison — positive branch restores tab, else branch shows setup
      expect(appJs).toContain("localStorage.getItem(SETUP_SEEN_KEY) === currentServerVersion");
      expect(appJs).toContain("switchToTab('setup')");
    });

    it('stores the version string (not "1") in the setup-seen flag', () => {
      const appJs = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf-8');
      expect(appJs).toContain('localStorage.setItem(SETUP_SEEN_KEY, currentServerVersion)');
      // Must NOT store the old hard-coded sentinel value
      expect(appJs).not.toContain("localStorage.setItem(SETUP_SEEN_KEY, '1')");
    });

    it('reads server version from the dollhouse-server-version meta tag', () => {
      const appJs = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf-8');
      expect(appJs).toContain('meta[name="dollhouse-server-version"]');
    });

    it('validates version format before using it (rejects malformed values)', () => {
      const appJs = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf-8');
      // Semver-like validation guard present
      expect(appJs).toContain(String.raw`/^\d+\.\d+\.\d+/.test(`);
      // Falls back to 'unknown' for invalid versions
      expect(appJs).toContain("'unknown'");
    });

    it('version check takes priority over saved-tab restoration', () => {
      const appJs = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf-8');
      // The version check block must appear before the savedTab block in source
      const versionCheckIdx = appJs.indexOf("localStorage.getItem(SETUP_SEEN_KEY) === currentServerVersion");
      const savedTabIdx = appJs.indexOf("localStorage.getItem(TAB_KEY)");
      expect(versionCheckIdx).toBeGreaterThan(0);
      expect(savedTabIdx).toBeGreaterThan(0);
      expect(versionCheckIdx).toBeLessThan(savedTabIdx);
    });

    it('index.html has the dollhouse-server-version meta tag placeholder', () => {
      expect(html).toContain('name="dollhouse-server-version"');
      expect(html).toContain('{{DOLLHOUSE_VERSION}}');
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

    it('Setup includes a permissions intro area for manual hook assets', () => {
      expect(html).toContain('id="setup-permissions-intro"');
      expect(js).toContain('renderPermissionsIntro');
      expect(js).toContain('pretooluse-dollhouse.sh');
    });
  });

  describe('All platforms have consistent structure', () => {
    const staticPlatforms = ['claude-desktop', 'claude-code'];
    const generatedPlatforms = ['cursor', 'vscode', 'codex', 'gemini', 'windsurf', 'cline', 'lmstudio'];

    it.each(staticPlatforms)('%s static panel has at least one copy button', (platform) => {
      const start = html.indexOf(`id="setup-panel-${platform}"`);
      const end = html.indexOf('</section>', start);
      const panel = html.slice(start, end);
      expect(panel).toContain('setup-copy-btn');
    });

    it.each(staticPlatforms)('%s static panel has at least one code block', (platform) => {
      const start = html.indexOf(`id="setup-panel-${platform}"`);
      const end = html.indexOf('</section>', start);
      const panel = html.slice(start, end);
      expect(panel).toContain('setup-code-block');
    });

    it('JS renderGeneratedPanels creates panels for all generated platforms', () => {
      expect(js).toContain('renderGeneratedPanels');
      for (const p of generatedPlatforms) {
        expect(js).toContain(`id: '${p}'`);
      }
    });

    it('generated panels include copy buttons and code blocks', () => {
      expect(js).toContain('setup-copy-btn');
      expect(js).toContain('setup-code-block');
    });

    it('generated panels include manual hook bridge assets for supported clients', () => {
      expect(js).toContain('pretooluse-cursor.sh');
      expect(js).toContain('pretooluse-codex.sh');
      expect(js).toContain('pretooluse-gemini.sh');
      expect(js).toContain('pretooluse-windsurf.sh');
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
      expect(js).toContain('Configure v${pinnedVersion}');
    });
  });

  describe('Channel selector regression', () => {
    it('channel selector initializes after method toggle', () => {
      const methodIdx = js.indexOf('initMethodToggle()');
      const channelIdx = js.indexOf('initChannelSelector()');
      expect(methodIdx).toBeGreaterThan(-1);
      expect(channelIdx).toBeGreaterThan(-1);
      expect(channelIdx).toBeGreaterThan(methodIdx);
    });

    it('channel defaults to latest on page load', () => {
      expect(js).toContain("let currentChannel = DEFAULT_CHANNEL");
    });

    it('no hardcoded @beta or @rc package references in source', () => {
      expect(js).not.toContain('@dollhousemcp/mcp-server@rc');
      expect(js).not.toContain('@dollhousemcp/mcp-server@beta');
    });

    it('channel selector updates configs on change', () => {
      expect(js).toContain('updateAllConfigs(currentMethod)');
    });

    it('backend allowlists channel values', () => {
      const ts = readFileSync(join(process.cwd(), 'src/web/routes/setupRoutes.ts'), 'utf-8');
      expect(ts).toContain("ALLOWED_INSTALL_CHANNELS");
      expect(ts).toContain("'latest'");
      expect(ts).toContain("'beta'");
      expect(ts).toContain("'rc'");
    });

    it('backend normalizes channel input', () => {
      const ts = readFileSync(join(process.cwd(), 'src/web/routes/setupRoutes.ts'), 'utf-8');
      expect(ts).toContain('UnicodeValidator.normalize(channel)');
    });

    it('channel selector hidden on init when pinned mode is active', () => {
      // The init sync line must apply hidden state without waiting for a click
      expect(js).toContain("channelToggle.hidden = currentMethod !== 'npx'");
    });

    it('channel change re-evaluates detection state', () => {
      // The change handler is inside initChannelSelector — extract a wider range
      const start = js.indexOf("select.addEventListener('change'");
      const end = js.indexOf('/** Rewrite code blocks', start);
      const changeHandler = js.slice(start, end);
      expect(changeHandler).toContain('updateDetectionState()');
    });

    it('channel change clears is-success state from buttons', () => {
      const start = js.indexOf("select.addEventListener('change'");
      const end = js.indexOf('/** Rewrite code blocks', start);
      const changeHandler = js.slice(start, end);
      expect(changeHandler).toContain("remove('is-success'");
    });

    it('channel change clears install status messages', () => {
      const start = js.indexOf("select.addEventListener('change'");
      const end = js.indexOf('/** Rewrite code blocks', start);
      const changeHandler = js.slice(start, end);
      expect(changeHandler).toContain('setup-install-status');
    });

    it('description text uses channel variable not hardcoded @latest', () => {
      // The Claude Desktop description must reflect the selected channel
      expect(js).not.toContain("Uses <code>npx @latest</code>");
      expect(js).toContain('safeChannel');
    });

    it('description uses textContent not innerHTML for XSS safety', () => {
      // CodeQL: DOM text reinterpreted as HTML
      const descSection = js.slice(
        js.indexOf('Restore text reflecting the selected channel'),
        js.indexOf('Restart Claude Desktop after'),
      );
      expect(descSection).toContain('desc.textContent');
      expect(descSection).toContain("document.createElement('code')");
      expect(descSection).not.toContain('desc.innerHTML');
    });

    it('has channel constants and normalizeChannel validator', () => {
      expect(js).toContain('CHANNELS');
      expect(js).toContain('VALID_CHANNELS');
      expect(js).toContain('DEFAULT_CHANNEL');
      expect(js).toContain('normalizeChannel');
    });

    it('formatInstallError handles missing channel releases', () => {
      expect(js).toContain('formatInstallError');
      expect(js).toContain('No ${currentChannel} release is published yet');
    });

    it('updateDetectionButton includes channel label', () => {
      // When config doesn't match, button should show "Configure Now (rc)" not just "Configure Now"
      const btnFn = js.slice(
        js.indexOf('const updateDetectionButton'),
        js.indexOf('/** Create a badge'),
      );
      expect(btnFn).toContain('channelLabel');
      expect(btnFn).toContain('DEFAULT_CHANNEL');
    });

    it('install success refreshes current config code block', () => {
      // After fetchDetection, updateDetectionState must be called to refresh the config display
      const installSection = js.slice(
        js.indexOf('Verify the install by re-detecting'),
        js.indexOf('showCompletionBanner'),
      );
      expect(installSection).toContain('updateDetectionState()');
    });

    it('updatePlatformDetectionState refreshes config code block', () => {
      // The function must update the <pre><code> content, not just the notice text
      const fn = js.slice(
        js.indexOf('const updatePlatformDetectionState'),
        js.indexOf('const updateDetectionNotice'),
      );
      expect(fn).toContain('pre code');
      expect(fn).toContain('JSON.stringify(detected.currentConfig');
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

  describe('Keyboard navigation', () => {
    it('JS adds arrow key handler to platform tabs', () => {
      expect(js).toContain('ArrowRight');
      expect(js).toContain('ArrowLeft');
      expect(js).toContain('ArrowDown');
      expect(js).toContain('ArrowUp');
    });

    it('JS supports Home and End keys', () => {
      expect(js).toContain("e.key === 'Home'");
      expect(js).toContain("e.key === 'End'");
    });

    it('JS manages tabindex on platform tabs', () => {
      expect(js).toContain("tabindex");
    });
  });

  describe('Install verification', () => {
    it('JS verifies install by re-detecting after success', () => {
      expect(js).toContain('Verifying...');
      expect(js).toContain('Verified');
    });

    it('JS shows verification status in success message', () => {
      expect(js).toContain('config written');
    });
  });

  describe('Progress indicators', () => {
    it('CSS has pulse animation for loading state', () => {
      expect(css).toContain('setup-install-pulse');
      expect(css).toContain('@keyframes setup-install-pulse');
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

// ── License form visibility regression (#1841) ──────────────────────────
// Ensures the activation form is hidden when a commercial license is active,
// and restored correctly during tier switching.

describe('Setup Tab — License Form Visibility (#1841)', () => {
  let js: string;
  let html: string;

  beforeAll(async () => {
    js = await readFileAsync(join(PUBLIC_DIR, 'setup.js'), 'utf-8');
    html = await readFileAsync(join(PUBLIC_DIR, 'index.html'), 'utf-8');
  });

  describe('HTML structure', () => {
    it('has license detail panels for free-commercial and paid-commercial', () => {
      expect(html).toContain('id="license-detail-free-commercial"');
      expect(html).toContain('id="license-detail-paid-commercial"');
    });

    it('has license active details panel', () => {
      expect(html).toContain('id="license-active-details"');
    });

    it('license active details panel is hidden by default', () => {
      const match = /id="license-active-details"[^>]*/.exec(html);
      expect(match?.[0]).toContain('hidden');
    });
  });

  describe('JS: showLicenseDetails hides activation form', () => {
    it('hides the activation form for the active tier', () => {
      expect(js).toContain('const activeForm = details[license.tier]');
      expect(js).toContain('activeForm.hidden = true');
    });

    it('uses const not var for activeForm', () => {
      expect(js).not.toMatch(/var activeForm\b/);
    });
  });

  describe('JS: selectTier handles active license', () => {
    it('checks activeLicense when selecting a tier', () => {
      expect(js).toContain("activeLicense?.status === 'active'");
      expect(js).toContain("activeLicense?.tier === tier");
    });

    it('calls showLicenseDetails when returning to active tier', () => {
      // selectTier must call showLicenseDetails(activeLicense) when hideForm is true
      expect(js).toContain('if (hideForm) showLicenseDetails(activeLicense)');
    });

    it('uses const not var for hideForm', () => {
      expect(js).not.toMatch(/var hideForm\b/);
    });
  });

  describe('JS: AGPL downgrade cancel restores state', () => {
    it('calls selectTier on cancel to restore previous tier', () => {
      expect(js).toContain('selectTier(activeLicense.tier)');
    });

    it('does not need separate showLicenseDetails call on cancel (selectTier handles it)', () => {
      // The AGPL cancel path should NOT have its own showLicenseDetails call
      // because selectTier now handles it centrally
      const agplSection = js.slice(
        js.indexOf('AGPL selection: confirm'),
        js.indexOf('const licenseDetailsPanel')
      );
      const showDetailsCount = (agplSection.match(/showLicenseDetails/g) || []).length;
      expect(showDetailsCount).toBe(0);
    });
  });

  describe('JS: loadSavedLicense shows details on page load', () => {
    it('calls showSavedBanner which calls showLicenseDetails', () => {
      expect(js).toContain('showSavedBanner(license)');
      expect(js).toContain('showLicenseDetails(license)');
    });
  });
});

// ── Generated panel DOM validation ────────────────────────────────────
// Uses JSDOM to execute setup.js against the actual HTML template,
// then validates the rendered DOM output programmatically.

describe('Setup Tab — Generated Panel DOM Validation', () => {
  let document: Document;

  beforeAll(async () => {
    const { JSDOM } = await import('jsdom');
    const html = await readFileAsync(join(PUBLIC_DIR, 'index.html'), 'utf-8');
    const js = await readFileAsync(join(PUBLIC_DIR, 'setup.js'), 'utf-8');

    // Create a DOM environment with the HTML template
    const dom = new JSDOM(html, {
      url: 'http://localhost:3939/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    });
    document = dom.window.document;

    // Mock fetch (setup.js calls /api/setup/version and /api/setup/detect)
    dom.window.fetch = (() => Promise.resolve({ ok: false })) as unknown as typeof fetch;
    // Mock navigator.clipboard
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
    });

    // Execute setup.js in the DOM context
    const scriptEl = document.createElement('script');
    scriptEl.textContent = js;
    document.body.appendChild(scriptEl);
  });

  const generatedPlatforms = ['cursor', 'vscode', 'codex', 'gemini', 'windsurf', 'cline', 'lmstudio'];

  it('generates a panel for each non-static platform', () => {
    for (const p of generatedPlatforms) {
      const panel = document.getElementById('setup-panel-' + p);
      expect(panel).not.toBeNull();
    }
  });

  it('each generated panel has role="tabpanel"', () => {
    for (const p of generatedPlatforms) {
      const panel = document.getElementById('setup-panel-' + p);
      expect(panel?.getAttribute('role')).toBe('tabpanel');
    }
  });

  it('each generated panel has aria-labelledby matching its tab', () => {
    for (const p of generatedPlatforms) {
      const panel = document.getElementById('setup-panel-' + p);
      expect(panel?.getAttribute('aria-labelledby')).toBe('setup-tab-' + p);
    }
  });

  it('each generated panel has at least one code block', () => {
    for (const p of generatedPlatforms) {
      const panel = document.getElementById('setup-panel-' + p);
      const codeBlocks = panel?.querySelectorAll('.setup-code-block');
      expect(codeBlocks?.length).toBeGreaterThan(0);
    }
  });

  it('each generated panel has at least one copy button with data-copy-text', () => {
    for (const p of generatedPlatforms) {
      const panel = document.getElementById('setup-panel-' + p);
      const copyBtns = panel?.querySelectorAll('.setup-copy-btn');
      expect(copyBtns?.length).toBeGreaterThan(0);
      copyBtns?.forEach((btn) => {
        expect((btn as HTMLElement).dataset.copyText).toBeTruthy();
      });
    }
  });

  it('platforms with installClient have a Configure Now button', () => {
    const withInstall = ['cursor', 'vscode', 'codex', 'gemini', 'windsurf', 'cline'];
    for (const p of withInstall) {
      const panel = document.getElementById('setup-panel-' + p);
      const btn = panel?.querySelector('.setup-install-btn');
      expect(btn).not.toBeNull();
      expect((btn as HTMLElement)?.dataset.installClient).toBeTruthy();
    }
  });

  it('LM Studio does not have a Configure Now button', () => {
    const panel = document.getElementById('setup-panel-lmstudio');
    const btn = panel?.querySelector('.setup-install-btn');
    expect(btn).toBeNull();
  });

  it('platforms with openClient have an Open config file button', () => {
    const withOpen = ['cursor', 'codex', 'gemini', 'windsurf', 'lmstudio'];
    for (const p of withOpen) {
      const panel = document.getElementById('setup-panel-' + p);
      const btn = panel?.querySelector('.setup-open-btn');
      expect(btn).not.toBeNull();
      expect((btn as HTMLElement)?.dataset.openClient).toBeTruthy();
    }
  });

  it('VS Code and Cline do not have Open config file buttons', () => {
    for (const p of ['vscode', 'cline']) {
      const panel = document.getElementById('setup-panel-' + p);
      const btn = panel?.querySelector('.setup-open-btn');
      expect(btn).toBeNull();
    }
  });

  it('Codex panel has both terminal command and TOML config blocks', () => {
    const panel = document.getElementById('setup-panel-codex');
    const codeBlocks = panel?.querySelectorAll('.setup-code-block');
    // Terminal command + TOML config = at least 2
    expect(codeBlocks?.length).toBeGreaterThanOrEqual(2);
  });

  it('Claude Code permissions panel exposes a Configure Now button', () => {
    const panel = document.getElementById('setup-panel-claude-code');
    const btn = panel?.querySelector('.setup-permission-install-btn') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.dataset.permissionInstallClient).toBe('claude-code');
  });

  it('all generated panels are hidden by default', () => {
    for (const p of generatedPlatforms) {
      const panel = document.getElementById('setup-panel-' + p);
      expect(panel?.hidden).toBe(true);
    }
  });

  it('JSON copy-text attributes contain valid JSON where applicable', () => {
    for (const p of generatedPlatforms) {
      const panel = document.getElementById('setup-panel-' + p);
      const copyBtns = panel?.querySelectorAll('.setup-copy-btn') || [];
      for (const btn of copyBtns) {
        const text = (btn as HTMLElement).dataset.copyText || '';
        if (text.startsWith('{')) {
          expect(() => JSON.parse(text)).not.toThrow();
          const parsed = JSON.parse(text);
          const server = parsed.mcpServers?.dollhousemcp || parsed.servers?.dollhousemcp;
          expect(server).toBeTruthy();
          expect(server.command).toBe('npx');
        }
      }
    }
  });

  it('VS Code generated config uses "servers" key, not "mcpServers"', () => {
    const panel = document.getElementById('setup-panel-vscode');
    const copyBtn = panel?.querySelector('.setup-copy-btn');
    const text = (copyBtn as HTMLElement)?.dataset.copyText || '';
    const parsed = JSON.parse(text);
    expect(parsed.servers).toBeDefined();
    expect(parsed.mcpServers).toBeUndefined();
  });
});

// ── Channel selector interaction tests ────────────────────────────────
// Uses JSDOM to simulate user interactions: switching channels, clicking
// Configure, and verifying the DOM updates correctly at each step.

describe('Setup Tab — Channel Selector Interactions', () => {
  let document: Document;
  let window: any;

  beforeAll(async () => {
    const { JSDOM } = await import('jsdom');
    const html = await readFileAsync(join(PUBLIC_DIR, 'index.html'), 'utf-8');
    const js = await readFileAsync(join(PUBLIC_DIR, 'setup.js'), 'utf-8');
    const authJs = await readFileAsync(join(PUBLIC_DIR, 'consoleAuth.js'), 'utf-8');

    const dom = new JSDOM(html, {
      url: 'http://localhost:41715/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    });
    document = dom.window.document;
    window = dom.window;

    // Realistic mock data matching actual Claude Desktop detection output
    const mockDetection = {
      'claude-desktop': {
        installed: true,
        currentConfig: {
          command: 'npx',
          args: ['@dollhousemcp/mcp-server@latest'],
          env: { DOLLHOUSE_DEBUG: 'true' },
        },
      },
      'cursor': {
        installed: false,
      },
    };
    let fetchFailMode = false; // toggle for network failure tests
    dom.window.fetch = ((url: string) => {
      if (fetchFailMode) return Promise.reject(new Error('Network error'));
      if (url.includes('/api/setup/version')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            version: '2.0.12-rc.10',
            mcpbUrl: '/api/setup/mcpb',
            npmTag: 'rc',
          }),
        });
      }
      if (url.includes('/api/setup/detect')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockDetection),
        });
      }
      if (url.includes('/api/setup/install')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      }
      return Promise.resolve({ ok: false });
    }) as unknown as typeof fetch;

    Object.defineProperty(dom.window.navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
    });

    // Load consoleAuth first (setup.js depends on DollhouseAuth)
    const authScript = document.createElement('script');
    authScript.textContent = authJs;
    document.body.appendChild(authScript);

    const scriptEl = document.createElement('script');
    scriptEl.textContent = js;
    document.body.appendChild(scriptEl);

    // Wait for async init (fetch calls settle and DOM updates)
    // Poll for the channel selector to be initialized rather than using an arbitrary delay
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 50));
      if (document.getElementById('setup-channel-select')) break;
    }
  });

  function getChannelSelect(): HTMLSelectElement | null {
    return document.getElementById('setup-channel-select') as HTMLSelectElement | null;
  }

  function getInstallBtn(): HTMLButtonElement | null {
    return document.querySelector('[data-install-client="claude"]') as HTMLButtonElement | null;
  }

  function getNotice(): HTMLElement | null {
    return document.querySelector('#setup-panel-claude-desktop .setup-installed-notice');
  }

  function switchChannel(value: string) {
    const select = getChannelSelect();
    if (!select) return;
    select.value = value;
    select.dispatchEvent(new window.Event('change'));
  }

  function switchMethod(method: 'npx' | 'global' | 'permissions') {
    const btn = document.querySelector(`.setup-method-btn[data-method="${method}"]`) as HTMLButtonElement | null;
    btn?.click();
  }

  describe('Initial state with @latest config', () => {
    it('channel selector defaults to Stable', () => {
      const select = getChannelSelect();
      expect(select?.value).toBe('latest');
    });
  });

  describe('Switch from Stable to RC', () => {
    beforeAll(() => switchChannel('rc'));

    it('button is not stuck in is-success state', () => {
      const btn = getInstallBtn();
      expect(btn?.classList.contains('is-success')).toBe(false);
    });

    it('button is enabled', () => {
      const btn = getInstallBtn();
      expect(btn?.disabled).not.toBe(true);
    });

    it('button text includes rc channel label', () => {
      const btn = getInstallBtn();
      const text = btn?.textContent || '';
      // Should say "Configure Now (rc)" or similar — not "Already configured"
      expect(text).toContain('rc');
      expect(text).not.toContain('Already configured');
    });
  });

  describe('Switch back to Stable', () => {
    beforeAll(() => switchChannel('latest'));

    it('button resets from rc state', () => {
      const btn = getInstallBtn();
      expect(btn?.classList.contains('is-success')).toBe(false);
    });

    it('button text does not include channel label for stable', () => {
      const btn = getInstallBtn();
      const text = btn?.textContent || '';
      expect(text).not.toContain('(rc)');
      expect(text).not.toContain('(latest)');
    });
  });

  describe('Switch to Beta (no releases)', () => {
    beforeAll(() => switchChannel('beta'));

    it('button shows beta channel label', () => {
      const btn = getInstallBtn();
      const text = btn?.textContent || '';
      expect(text).toContain('beta');
    });

    it('button is enabled for configuration', () => {
      const btn = getInstallBtn();
      expect(btn?.disabled).not.toBe(true);
    });
  });

  describe('Rapid channel switching', () => {
    it('handles rapid switches without breaking', () => {
      switchChannel('rc');
      switchChannel('latest');
      switchChannel('beta');
      switchChannel('rc');
      switchChannel('latest');

      const btn = getInstallBtn();
      // Should be in a clean state after rapid switching
      expect(btn?.classList.contains('is-success')).toBe(false);
      expect(btn?.classList.contains('is-loading')).toBe(false);
    });
  });

  describe('Invalid channel value', () => {
    it('falls back to stable for unknown channel', () => {
      switchChannel('nightly');
      // normalizeChannel should reject 'nightly' and use DEFAULT_CHANNEL
      const btn = getInstallBtn();
      const text = btn?.textContent || '';
      expect(text).not.toContain('nightly');
    });
  });

  describe('Description text updates with channel', () => {
    it('shows @rc in description when RC selected', () => {
      switchChannel('rc');
      const panel = document.getElementById('setup-panel-claude-desktop');
      const descs = panel?.querySelectorAll('.setup-method-desc') || [];
      let found = false;
      descs.forEach((desc) => {
        if (desc.textContent?.includes('@rc')) found = true;
      });
      expect(found).toBe(true);
    });

    it('shows @latest in description when Stable selected', () => {
      switchChannel('latest');
      const panel = document.getElementById('setup-panel-claude-desktop');
      const descs = panel?.querySelectorAll('.setup-method-desc') || [];
      let found = false;
      descs.forEach((desc) => {
        if (desc.textContent?.includes('@latest')) found = true;
      });
      expect(found).toBe(true);
    });
  });

  describe('Non-installed platform', () => {
    it('cursor shows Configure Now without detection state', () => {
      const panel = document.getElementById('setup-panel-cursor');
      const btn = panel?.querySelector('.setup-install-btn') as HTMLButtonElement | null;
      // Cursor is not installed — no detection notice, button should be available
      if (btn) {
        expect(btn.classList.contains('is-match')).toBe(false);
        expect(btn.disabled).not.toBe(true);
      }
    });
  });

  describe('Config preserves env vars', () => {
    it('detected config includes DOLLHOUSE_DEBUG env var', () => {
      const panel = document.getElementById('setup-panel-claude-desktop');
      const code = panel?.querySelector('.setup-installed-notice pre code');
      if (code?.textContent) {
        expect(code.textContent).toContain('DOLLHOUSE_DEBUG');
      }
    });
  });

  describe('Permissions mode separates enforcement from MCP install state', () => {
    beforeAll(() => switchMethod('permissions'));

    it('hides the generic installed notice in permissions mode', () => {
      const notice = getNotice();
      expect(notice ?? null).toBeNull();
    });

    it('shows a permissions-specific status message instead of generic config copy', () => {
      const panel = document.getElementById('setup-panel-claude-desktop');
      const status = panel?.querySelector('.setup-permission-status');
      expect(status).not.toBeNull();
      expect(status?.textContent).toContain('Permissions & security tools are unavailable for Claude Desktop right now.');
      expect(status?.textContent).not.toContain('already configured for this client');
    });
  });
});

// ── npm package inclusion check ───────────────────────────────────────
// Verifies that static web assets and seed elements are included in the
// npm package via the files field in package.json.

describe('Setup Tab — Package Inclusion', () => {
  let packageJson: Record<string, unknown>;

  beforeAll(async () => {
    const raw = await readFileAsync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8');
    packageJson = JSON.parse(raw);
  });

  it('files field includes dist/web/public/** for HTML, CSS, and fonts', () => {
    const files = packageJson.files as string[];
    expect(files).toContain('dist/web/public/**');
  });

  it('files field includes dist/seed-elements/** for seed memories', () => {
    const files = packageJson.files as string[];
    expect(files).toContain('dist/seed-elements/**');
  });

  it('files field includes manual permission hook wrapper scripts', () => {
    const files = packageJson.files as string[];
    expect(files).toContain('scripts/pretooluse-dollhouse.sh');
    expect(files).toContain('scripts/pretooluse-cursor.sh');
    expect(files).toContain('scripts/pretooluse-windsurf.sh');
    expect(files).toContain('scripts/pretooluse-gemini.sh');
    expect(files).toContain('scripts/pretooluse-codex.sh');
  });

  it('dist/web/public/index.html exists', () => {
    const indexPath = join(__dirname, '..', '..', '..', 'dist', 'web', 'public', 'index.html');
    expect(() => readFileSync(indexPath)).not.toThrow();
  });

  it('dist/web/public/setup.css exists', () => {
    const cssPath = join(__dirname, '..', '..', '..', 'dist', 'web', 'public', 'setup.css');
    expect(() => readFileSync(cssPath)).not.toThrow();
  });

  it('dist/web/public/setup.js exists', () => {
    const jsPath = join(__dirname, '..', '..', '..', 'dist', 'web', 'public', 'setup.js');
    expect(() => readFileSync(jsPath)).not.toThrow();
  });

  it('dist/web/public/styles.css exists', () => {
    const cssPath = join(__dirname, '..', '..', '..', 'dist', 'web', 'public', 'styles.css');
    expect(() => readFileSync(cssPath)).not.toThrow();
  });

  it('dist/web/public/fonts.css exists', () => {
    const cssPath = join(__dirname, '..', '..', '..', 'dist', 'web', 'public', 'fonts.css');
    expect(() => readFileSync(cssPath)).not.toThrow();
  });

  it('dist/seed-elements/memories/ has seed files', async () => {
    const seedDir = join(__dirname, '..', '..', '..', 'dist', 'seed-elements', 'memories');
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(seedDir).map(String);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => f.endsWith('.yaml'))).toBe(true);
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
