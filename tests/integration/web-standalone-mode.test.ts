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
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');

/** Extract the --web IIFE from index.ts source. */
function getWebModeBlock(source: string): string {
  const start = source.indexOf('if (isWebMode)');
  const end = source.indexOf('[DollhouseMCP] Web UI failed to start:', start);
  return source.slice(start, end);
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

  describe('completeSinkSetup path', () => {
    it('does NOT call completeDeferredSetup in the --web path', () => {
      const block = getWebModeBlock(webModeSource);
      expect(block).not.toContain('container.completeDeferredSetup()');
      expect(block).toContain('container.completeSinkSetup()');
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

    it('wires metrics snapshots into the fallback metrics sink', () => {
      const block = getWebModeBlock(webModeSource);
      expect(block).toContain('metricsOnSnapshot');
      expect(block).toContain("metricsSink?.onSnapshot(snapshot)");
    });

    it('attempts to register a fallback metrics sink with MetricsManager', () => {
      const block = getWebModeBlock(webModeSource);
      expect(block).toContain("container?.resolve");
      expect(block).toContain('registerSink(metricsSink)');
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

      // Use a high-numbered port to avoid sandbox bind restrictions.
      const result = await recoverStalePort(65535);
      expect(result).toBe(false);
    });

    it('verifyDollhouseProcess is not exported (internal)', async () => {
      const mod = await import('../../src/web/console/StaleProcessRecovery.js');
      expect((mod as any).verifyDollhouseProcess).toBeUndefined();
    });
  });
});
