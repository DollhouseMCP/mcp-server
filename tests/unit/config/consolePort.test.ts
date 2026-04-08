/**
 * Tests for console port configuration hierarchy (#1840).
 *
 * Verifies the resolution order:
 *   1. CLI flag (--port=N) — standalone --web mode only
 *   2. Config file (~/.dollhouse/config.yml → console.port)
 *   3. DOLLHOUSE_WEB_CONSOLE_PORT env var
 *   4. Default: 41715
 */

import { describe, it, expect } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = process.cwd();

describe('Console port configuration (#1840)', () => {

  // ── Config schema ──────────────────────────────────────────────────────

  describe('ConfigManager schema', () => {
    it('defines ConsoleConfig interface with port field', async () => {
      const source = await readFile(join(SRC, 'src/config/ConfigManager.ts'), 'utf8');
      expect(source).toContain('export interface ConsoleConfig');
      expect(source).toContain('port: number');
    });

    it('DollhouseConfig includes console property', async () => {
      const source = await readFile(join(SRC, 'src/config/ConfigManager.ts'), 'utf8');
      expect(source).toContain('console: ConsoleConfig');
    });

    it('default config sets console.port to 41715', async () => {
      const source = await readFile(join(SRC, 'src/config/ConfigManager.ts'), 'utf8');
      expect(source).toMatch(/console:\s*\{\s*\n\s*port:\s*41715/);
    });

    it('documents the resolution hierarchy in the interface', async () => {
      const source = await readFile(join(SRC, 'src/config/ConfigManager.ts'), 'utf8');
      expect(source).toContain('--port CLI flag');
      expect(source).toContain('DOLLHOUSE_WEB_CONSOLE_PORT env var');
      expect(source).toContain('Default: 41715');
    });
  });

  // ── Container wiring ──────────────────────────────────────────────────

  describe('Container passes config port to UnifiedConsole', () => {
    it('resolves port from ConfigManager', async () => {
      const source = await readFile(join(SRC, 'src/di/Container.ts'), 'utf8');
      expect(source).toContain("getSetting<number>('console.port')");
    });

    it('passes resolved port in UnifiedConsole options', async () => {
      const source = await readFile(join(SRC, 'src/di/Container.ts'), 'utf8');
      expect(source).toContain('port: configPort');
    });
  });

  // ── UnifiedConsole port resolution ─────────────────────────────────────

  describe('UnifiedConsole accepts port option', () => {
    it('options interface has port field', async () => {
      const source = await readFile(join(SRC, 'src/web/console/UnifiedConsole.ts'), 'utf8');
      expect(source).toContain('port?: number');
    });

    it('resolves port with fallback to DEFAULT_CONSOLE_PORT', async () => {
      const source = await readFile(join(SRC, 'src/web/console/UnifiedConsole.ts'), 'utf8');
      expect(source).toContain('options.port || DEFAULT_CONSOLE_PORT');
    });

    it('passes resolved port to startAsLeader', async () => {
      const source = await readFile(join(SRC, 'src/web/console/UnifiedConsole.ts'), 'utf8');
      expect(source).toContain('startAsLeader(options, election, consolePort)');
    });

    it('startAsLeader uses consolePort for web server binding', async () => {
      const source = await readFile(join(SRC, 'src/web/console/UnifiedConsole.ts'), 'utf8');
      expect(source).toContain('port: consolePort,');
    });

    it('DEFAULT_CONSOLE_PORT reads from env var', async () => {
      const source = await readFile(join(SRC, 'src/web/console/UnifiedConsole.ts'), 'utf8');
      expect(source).toContain('DEFAULT_CONSOLE_PORT = env.DOLLHOUSE_WEB_CONSOLE_PORT');
    });
  });

  // ── Standalone --web mode CLI integration ──────────────────────────────

  describe('standalone --web mode port resolution', () => {
    it('parses --port CLI flag', async () => {
      const source = await readFile(join(SRC, 'src/index.ts'), 'utf8');
      expect(source).toContain("startsWith('--port=')");
      expect(source).toContain('cliPort');
    });

    it('reads config file for port when no CLI flag', async () => {
      const source = await readFile(join(SRC, 'src/index.ts'), 'utf8');
      expect(source).toContain("parsed?.console?.port");
    });

    it('validates config port is in valid range (1024-65535)', async () => {
      const source = await readFile(join(SRC, 'src/index.ts'), 'utf8');
      expect(source).toContain('configPort >= 1024');
      expect(source).toContain('configPort <= 65535');
    });

    it('uses FAILSAFE_SCHEMA for secure YAML parsing', async () => {
      const source = await readFile(join(SRC, 'src/index.ts'), 'utf8');
      expect(source).toContain('FAILSAFE_SCHEMA');
    });

    it('passes resolvedPort to startWebServer', async () => {
      const source = await readFile(join(SRC, 'src/index.ts'), 'utf8');
      expect(source).toContain('port: resolvedPort');
    });

    it('CLI flag takes precedence over config file', async () => {
      const source = await readFile(join(SRC, 'src/index.ts'), 'utf8');
      // cliPort is checked first, config file only if !cliPort
      const cliIdx = source.indexOf('let resolvedPort = cliPort');
      const configIdx = source.indexOf("parsed?.console?.port");
      expect(cliIdx).toBeGreaterThan(-1);
      expect(configIdx).toBeGreaterThan(cliIdx);
    });
  });

  // ── YAML parsing edge cases ────────────────────────────────────────────

  describe('YAML port parsing edge cases', () => {
    it('handles valid port number', async () => {
      const yaml = await import('js-yaml');
      const parsed = yaml.load('console:\n  port: 9000\n', { schema: yaml.FAILSAFE_SCHEMA }) as any;
      const port = Number(parsed?.console?.port);
      expect(port).toBe(9000);
      expect(port >= 1024 && port <= 65535).toBe(true);
    });

    it('rejects non-numeric port', async () => {
      const yaml = await import('js-yaml');
      const parsed = yaml.load('console:\n  port: "abc"\n', { schema: yaml.FAILSAFE_SCHEMA }) as any;
      const port = Number(parsed?.console?.port);
      expect(Number.isNaN(port)).toBe(true);
      expect(port >= 1024 && port <= 65535).toBe(false);
    });

    it('rejects privileged port', async () => {
      const yaml = await import('js-yaml');
      const parsed = yaml.load('console:\n  port: 80\n', { schema: yaml.FAILSAFE_SCHEMA }) as any;
      const port = Number(parsed?.console?.port);
      expect(port >= 1024 && port <= 65535).toBe(false);
    });

    it('rejects port above max', async () => {
      const yaml = await import('js-yaml');
      const parsed = yaml.load('console:\n  port: 70000\n', { schema: yaml.FAILSAFE_SCHEMA }) as any;
      const port = Number(parsed?.console?.port);
      expect(port >= 1024 && port <= 65535).toBe(false);
    });

    it('handles missing console section', async () => {
      const yaml = await import('js-yaml');
      const parsed = yaml.load('user:\n  name: test\n', { schema: yaml.FAILSAFE_SCHEMA }) as any;
      const port = parsed?.console?.port ? Number(parsed.console.port) : undefined;
      expect(port).toBeUndefined();
    });

    it('handles empty config file', async () => {
      const yaml = await import('js-yaml');
      const parsed = yaml.load('', { schema: yaml.FAILSAFE_SCHEMA }) as any;
      const port = parsed?.console?.port ? Number(parsed?.console?.port) : undefined;
      expect(port).toBeUndefined();
    });
  });

  // ── EADDRINUSE regression ──────────────────────────────────────────────

  describe('port conflict handling (never kills processes)', () => {
    it('detects EADDRINUSE gracefully', async () => {
      const source = await readFile(join(SRC, 'src/web/server.ts'), 'utf8');
      expect(source).toContain("err.code === 'EADDRINUSE'");
    });

    it('logs and opens existing console on conflict', async () => {
      const source = await readFile(join(SRC, 'src/web/server.ts'), 'utf8');
      expect(source).toContain('opening existing console');
    });

    it('never kills processes on the configured port', async () => {
      const source = await readFile(join(SRC, 'src/web/server.ts'), 'utf8');
      expect(source).not.toContain('process.kill');
    });

    it('resolves promise on conflict (does not throw)', async () => {
      const source = await readFile(join(SRC, 'src/web/server.ts'), 'utf8');
      // The error handler calls resolve(), not reject()
      const errorSection = source.slice(
        source.indexOf("httpServer.on('error'"),
        source.indexOf('});', source.indexOf("httpServer.on('error'")) + 10,
      );
      expect(errorSection).toContain('resolve()');
      expect(errorSection).not.toContain('reject(');
    });
  });
});
