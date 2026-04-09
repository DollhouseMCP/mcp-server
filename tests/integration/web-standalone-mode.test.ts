/**
 * Integration tests for standalone --web mode (#1850).
 *
 * Verifies the --web startup path has the correct structure:
 * 1. Pre-flight zombie kill runs BEFORE container setup
 * 2. completeDeferredSetup() is NOT called (prevents leader election conflict)
 * 3. Port file sweep runs independently
 * 4. startWebServer is called with full sinks
 */

import { describe, it, expect } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as net from 'node:net';

const PROJECT_ROOT = path.resolve(__dirname, '../../');

/** Extract the --web IIFE from index.ts source. */
function getWebModeBlock(source: string): string {
  const start = source.indexOf('if (isWebMode)');
  const end = source.indexOf('[DollhouseMCP] Web UI failed to start:', start);
  return source.slice(start, end);
}

/** Get a dynamically assigned free port from the OS. */
function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

describe('Standalone --web mode (#1850)', () => {
  let webModeSource: string;

  beforeAll(async () => {
    webModeSource = await readFile(path.join(PROJECT_ROOT, 'src/index.ts'), 'utf8');
  });

  describe('Pre-flight zombie kill', () => {
    it('calls recoverStalePort before container bootstrap', () => {
      const webBlock = getWebModeBlock(webModeSource);
      const recoverIdx = webBlock.indexOf('recoverStalePort(targetPort)');
      const containerIdx = webBlock.indexOf('new DollhouseContainer()');
      expect(recoverIdx).toBeGreaterThan(-1);
      expect(containerIdx).toBeGreaterThan(-1);
      expect(recoverIdx).toBeLessThan(containerIdx);
    });

    it('logs recovery failures instead of swallowing them', () => {
      const preflightSection = webModeSource.slice(
        webModeSource.indexOf('Pre-flight: kill any stale'),
        webModeSource.indexOf('let mcpAqlHandler'),
      );
      expect(preflightSection).toContain('console.error');
      expect(preflightSection).toContain('Pre-flight port recovery failed');
      expect(preflightSection).not.toContain('catch { /*');
    });

    it('uses the CLI port flag when provided', () => {
      expect(webModeSource).toContain('cliPort || env.DOLLHOUSE_WEB_CONSOLE_PORT');
    });
  });

  describe('completeDeferredSetup skipped', () => {
    it('does NOT call completeDeferredSetup in the --web path', () => {
      const block = getWebModeBlock(webModeSource);
      expect(block).not.toContain('container.completeDeferredSetup()');
      expect(block).toContain('Do NOT call completeDeferredSetup');
    });

    it('runs sweepStalePortFiles directly instead', () => {
      expect(getWebModeBlock(webModeSource)).toContain('sweepStalePortFiles');
    });

    it('still bootstraps handlers for MCP-AQL gateway', () => {
      const block = getWebModeBlock(webModeSource);
      expect(block).toContain('bootstrapHandlers');
      expect(block).toContain('mcpAqlHandler');
    });
  });

  describe('Server startup with full sinks', () => {
    it('passes all required options to startWebServer', () => {
      const block = getWebModeBlock(webModeSource);
      expect(block).toContain('memorySink');
      expect(block).toContain('metricsSink');
      expect(block).toContain('tokenStore');
      expect(block).toContain('additionalRouters');
    });

    it('creates fallback sinks when container does not provide them', () => {
      const block = getWebModeBlock(webModeSource);
      expect(block).toContain('MemoryLogSink');
      expect(block).toContain('MemoryMetricsSink');
    });
  });

  describe('Race condition documentation', () => {
    it('documents the TOCTOU mitigation in the pre-flight comment', () => {
      const preflightSection = webModeSource.slice(
        webModeSource.indexOf('Pre-flight: kill any stale'),
        webModeSource.indexOf('const targetPort'),
      );
      expect(preflightSection).toContain('TOCTOU');
    });
  });

  describe('StaleProcessRecovery module', () => {
    it('recoverStalePort is importable and callable', async () => {
      const { recoverStalePort } = await import('../../src/web/console/StaleProcessRecovery.js');
      expect(typeof recoverStalePort).toBe('function');

      // Use a dynamically assigned free port — no hardcoded port numbers
      const freePort = await getFreePort();
      const result = await recoverStalePort(freePort);
      expect(result).toBe(false);
    });

    it('verifyDollhouseProcess is not exported (internal)', async () => {
      const mod = await import('../../src/web/console/StaleProcessRecovery.js');
      expect((mod as any).verifyDollhouseProcess).toBeUndefined();
    });
  });
});
