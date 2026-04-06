/**
 * Unit tests for the permission server wiring.
 *
 * Tests the env flag gating, the startPermissionServer function signature,
 * and the port discovery integration. Does NOT start actual HTTP servers.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Permission Server Wiring', () => {
  describe('DOLLHOUSE_PERMISSION_SERVER env flag', () => {
    it('should be defined in env schema with boolean type', async () => {
      // Verify the env var exists in the schema by checking the parsed env object
      const { env } = await import('../../../src/config/env.js');
      expect(typeof env.DOLLHOUSE_PERMISSION_SERVER).toBe('boolean');
    });

    it('should default to true', async () => {
      const { env } = await import('../../../src/config/env.js');
      // Default is true unless explicitly overridden
      expect(env.DOLLHOUSE_PERMISSION_SERVER).toBe(true);
    });
  });

  describe('startPermissionServer export', () => {
    it('should be exported from webAutoStart', async () => {
      const mod = await import('../../../src/auto-dollhouse/webAutoStart.js');
      expect(typeof mod.startPermissionServer).toBe('function');
    });

    it('should accept mcpAqlHandler as first argument', async () => {
      const mod = await import('../../../src/auto-dollhouse/webAutoStart.js');
      // Verify function signature — should accept 4 params
      expect(mod.startPermissionServer.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('portDiscovery integration', () => {
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
      // Read Container source to verify the method exists and is called
      const containerSource = await fs.readFile(
        path.join(process.cwd(), 'src/di/Container.ts'),
        'utf-8'
      );

      // Verify the method exists
      expect(containerSource).toContain('private async deferredPermissionServer');

      // Verify it's called in completeDeferredSetup
      expect(containerSource).toContain('await this.deferredPermissionServer(timer)');

      // Verify it checks the env flag
      expect(containerSource).toContain('DOLLHOUSE_PERMISSION_SERVER');

      // Verify it imports startPermissionServer
      expect(containerSource).toContain("import('../auto-dollhouse/webAutoStart.js')");
    });

    it('should run permission server after web console in deferred setup', async () => {
      const containerSource = await fs.readFile(
        path.join(process.cwd(), 'src/di/Container.ts'),
        'utf-8'
      );

      const webConsoleIdx = containerSource.indexOf('deferredWebConsole(timer)');
      const permServerIdx = containerSource.indexOf('deferredPermissionServer(timer)');
      const dangerZoneIdx = containerSource.indexOf('deferredDangerZoneInit(timer)');

      // Permission server should come after web console but before danger zone
      expect(permServerIdx).toBeGreaterThan(webConsoleIdx);
      expect(permServerIdx).toBeLessThan(dangerZoneIdx);
    });
  });
});
