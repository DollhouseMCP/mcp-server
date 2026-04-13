/**
 * Unit tests for the permission server port file wiring in Container.
 *
 * In mcp-server, the permission routes are already mounted on the
 * unified web console (port 41715). The permission server setup just
 * writes the port file so the PreToolUse hook script can discover it.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Permission Server Wiring', () => {
  describe('DOLLHOUSE_PERMISSION_SERVER env flag', () => {
    it('should be defined in env schema with boolean type', async () => {
      const { env } = await import('../../../src/config/env.js');
      expect(typeof env.DOLLHOUSE_PERMISSION_SERVER).toBe('boolean');
    });

    it('should default to true', async () => {
      const { env } = await import('../../../src/config/env.js');
      expect(env.DOLLHOUSE_PERMISSION_SERVER).toBe(true);
    });
  });

  describe('portDiscovery exports', () => {
    it('should export findAvailablePort, writePortFile, registerPortCleanup', async () => {
      const mod = await import('../../../src/auto-dollhouse/portDiscovery.js');
      expect(typeof mod.findAvailablePort).toBe('function');
      expect(typeof mod.writePortFile).toBe('function');
      expect(typeof mod.registerPortCleanup).toBe('function');
    });

    it('should find an available port in the expected range', async () => {
      const { findAvailablePort } = await import('../../../src/auto-dollhouse/portDiscovery.js');
      const port = await findAvailablePort(49200);
      expect(port).toBeGreaterThanOrEqual(49200);
      expect(port).toBeLessThanOrEqual(49210);
    });

    it('should write port file with correct content', async () => {
      const { writePortFile } = await import('../../../src/auto-dollhouse/portDiscovery.js');
      const runDir = path.join(os.homedir(), '.dollhouse', 'run');
      const portFile = path.join(runDir, 'permission-server.port');

      await writePortFile(49999);

      const content = await fs.readFile(portFile, 'utf-8');
      expect(content.trim()).toBe('49999');

      // Clean up test artifact
      await fs.unlink(portFile).catch(() => {});
    });
  });

  describe('Container.completeDeferredSetup integration', () => {
    it('should have deferredPermissionServer in the deferred setup chain', async () => {
      const containerSource = await fs.readFile(
        path.join(process.cwd(), 'src/di/Container.ts'),
        'utf-8'
      );

      expect(containerSource).toContain('private async deferredPermissionServer');
      expect(containerSource).toContain('const consoleResult = await this.deferredWebConsole(timer);');
      expect(containerSource).toContain('await this.deferredPermissionServer(consoleResult, timer);');
      expect(containerSource).toContain('DOLLHOUSE_PERMISSION_SERVER');
    });

    it('should use the elected web console port, not the default env port', async () => {
      const containerSource = await fs.readFile(
        path.join(process.cwd(), 'src/di/Container.ts'),
        'utf-8'
      );

      // Should reference the live console result, not a guessed env/default port
      expect(containerSource).toContain("consoleResult?.role === 'leader'");
      expect(containerSource).toContain('consoleResult.port');
      expect(containerSource).toContain('consoleResult?.election.leaderInfo.port');
      expect(containerSource).toContain('writePortFile');
      expect(containerSource).toContain('registerPortCleanup');

      // Should NOT import webAutoStart (that's auto-dollhouse only)
      expect(containerSource).not.toContain("import('../auto-dollhouse/webAutoStart.js')");
    });

    it('should run permission server after web console in completeConsoleSetup', async () => {
      const containerSource = await fs.readFile(
        path.join(process.cwd(), 'src/di/Container.ts'),
        'utf-8'
      );

      // After #1866 split: webConsole and permServer are in completeConsoleSetup,
      // dangerZone is in completeSinkSetup. Verify console-group ordering.
      const webConsoleIdx = containerSource.indexOf('deferredWebConsole(timer)');
      const permServerIdx = containerSource.indexOf('deferredPermissionServer(consoleResult, timer)');

      expect(permServerIdx).toBeGreaterThan(webConsoleIdx);
    });

    it('should skip when web console is disabled', async () => {
      const containerSource = await fs.readFile(
        path.join(process.cwd(), 'src/di/Container.ts'),
        'utf-8'
      );

      expect(containerSource).toContain('DOLLHOUSE_WEB_CONSOLE');
      expect(containerSource).toContain('Permission server skipped — web console is disabled');
    });
  });
});
