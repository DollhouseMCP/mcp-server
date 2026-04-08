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

    it('reads config file for port via ConfigManager.readPortFromYaml', async () => {
      const source = await readFile(join(SRC, 'src/index.ts'), 'utf8');
      expect(source).toContain('ConfigManager.readPortFromYaml');
    });

    it('validates config port is in valid range (1024-65535)', async () => {
      const source = await readFile(join(SRC, 'src/index.ts'), 'utf8');
      expect(source).toContain('configPort >= 1024');
      expect(source).toContain('configPort <= 65535');
    });

    it('size-limits config file before parsing (64KB)', async () => {
      const source = await readFile(join(SRC, 'src/index.ts'), 'utf8');
      expect(source).toContain('raw.length <= 64 * 1024');
    });

    it('passes resolvedPort to startWebServer', async () => {
      const source = await readFile(join(SRC, 'src/index.ts'), 'utf8');
      expect(source).toContain('port: resolvedPort');
    });

    it('CLI flag takes precedence over config file', async () => {
      const source = await readFile(join(SRC, 'src/index.ts'), 'utf8');
      const cliIdx = source.indexOf('let resolvedPort = cliPort');
      const configIdx = source.indexOf('ConfigManager.readPortFromYaml');
      expect(cliIdx).toBeGreaterThan(-1);
      expect(configIdx).toBeGreaterThan(cliIdx);
    });
  });

  // ── ConfigManager.readPortFromYaml ───────────────────────────────────

  describe('ConfigManager.readPortFromYaml', () => {
    let readPortFromYaml: (yaml: string) => number | undefined;

    beforeAll(async () => {
      const { ConfigManager } = await import('../../../src/config/ConfigManager.js');
      readPortFromYaml = ConfigManager.readPortFromYaml;
    });

    it('parses valid port number', () => {
      expect(readPortFromYaml('console:\n  port: 9000\n')).toBe(9000);
    });

    it('parses default port', () => {
      expect(readPortFromYaml('console:\n  port: 41715\n')).toBe(41715);
    });

    it('returns undefined for non-numeric port', () => {
      expect(readPortFromYaml('console:\n  port: abc\n')).toBeUndefined();
    });

    it('returns undefined for missing console section', () => {
      expect(readPortFromYaml('user:\n  name: test\n')).toBeUndefined();
    });

    it('returns undefined for empty config', () => {
      expect(readPortFromYaml('')).toBeUndefined();
    });

    it('returns undefined for malformed YAML', () => {
      expect(readPortFromYaml('{{{')).toBeUndefined();
    });

    it('returns port below valid range (caller must validate)', () => {
      // readPortFromYaml returns the number; range validation is the caller's job
      const port = readPortFromYaml('console:\n  port: 80\n');
      expect(port).toBe(80);
    });

    it('returns port above valid range (caller must validate)', () => {
      const port = readPortFromYaml('console:\n  port: 70000\n');
      expect(port).toBe(70000);
    });

    it('uses FAILSAFE_SCHEMA (no code execution)', async () => {
      const source = await readFile(join(SRC, 'src/config/ConfigManager.ts'), 'utf8');
      expect(source).toContain('readPortFromYaml');
      expect(source).toContain('FAILSAFE_SCHEMA');
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
