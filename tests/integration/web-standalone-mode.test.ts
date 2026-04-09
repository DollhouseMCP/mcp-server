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

const PROJECT_ROOT = path.resolve(__dirname, '../../');

describe('Standalone --web mode (#1850)', () => {
  let webModeSource: string;

  beforeAll(async () => {
    webModeSource = await readFile(path.join(PROJECT_ROOT, 'src/index.ts'), 'utf8');
  });

  describe('Pre-flight zombie kill', () => {
    it('calls recoverStalePort before container bootstrap', () => {
      // Search within the --web block only
      const webStart = webModeSource.indexOf('if (isWebMode)');
      const webBlock = webModeSource.slice(webStart);
      const recoverIdx = webBlock.indexOf('recoverStalePort(targetPort)');
      const containerIdx = webBlock.indexOf('new DollhouseContainer()');
      expect(recoverIdx).toBeGreaterThan(-1);
      expect(containerIdx).toBeGreaterThan(-1);
      // Pre-flight must come BEFORE container creation
      expect(recoverIdx).toBeLessThan(containerIdx);
    });

    it('logs recovery failures instead of swallowing them', () => {
      // The catch block must log, not be empty
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
    // Extract the --web IIFE: from "if (isWebMode)" to the ".catch(err =>" that ends it
    function getWebModeBlock(): string {
      const start = webModeSource.indexOf('if (isWebMode)');
      const end = webModeSource.indexOf('[DollhouseMCP] Web UI failed to start:', start);
      return webModeSource.slice(start, end);
    }

    it('does NOT call completeDeferredSetup in the --web path', () => {
      const block = getWebModeBlock();
      // Check for the actual method call, not comments about it
      expect(block).not.toContain('container.completeDeferredSetup()');
      // The comment explaining WHY it's skipped should be present
      expect(block).toContain('Do NOT call completeDeferredSetup');
    });

    it('runs sweepStalePortFiles directly instead', () => {
      expect(getWebModeBlock()).toContain('sweepStalePortFiles');
    });

    it('still bootstraps handlers for MCP-AQL gateway', () => {
      const block = getWebModeBlock();
      expect(block).toContain('bootstrapHandlers');
      expect(block).toContain('mcpAqlHandler');
    });
  });

  describe('Server startup with full sinks', () => {
    function getWebModeBlock(): string {
      const start = webModeSource.indexOf('if (isWebMode)');
      const end = webModeSource.indexOf('[DollhouseMCP] Web UI failed to start:', start);
      return webModeSource.slice(start, end);
    }

    it('passes all required options to startWebServer', () => {
      const block = getWebModeBlock();
      expect(block).toContain('memorySink');
      expect(block).toContain('metricsSink');
      expect(block).toContain('tokenStore');
      expect(block).toContain('additionalRouters');
    });

    it('creates fallback sinks when container does not provide them', () => {
      const block = getWebModeBlock();
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

      // Should return false for a port with nothing on it
      const result = await recoverStalePort(59997);
      expect(result).toBe(false);
    });

    it('verifyDollhouseProcess is not exported (internal)', async () => {
      const mod = await import('../../src/web/console/StaleProcessRecovery.js');
      expect((mod as any).verifyDollhouseProcess).toBeUndefined();
    });
  });
});
