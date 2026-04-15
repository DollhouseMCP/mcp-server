/**
 * Integration tests for standalone --web mode (#1850).
 *
 * Verifies the --web startup path has the correct structure:
 * 1. Pre-flight zombie kill runs BEFORE container setup
 * 2. completeDeferredSetup() is NOT called (prevents leader election conflict)
 * 3. Port file sweep runs independently
 * 4. startWebServer is called with full sinks
 *
 * These tests read the source of index.ts and verify structural invariants
 * by searching for key patterns. The web mode logic lives across two
 * functions: startWebStandaloneMode() (pre-flight + server) and
 * bootstrapWebContainer() (container setup + sinks).
 */

import { describe, it, expect } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');

/**
 * Extract a named function's full text from source.
 * Handles TypeScript return type annotations that contain braces
 * by finding the function body start after the signature's `: Type {`.
 */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) return '';

  // Find the function body opening brace.
  // Skip past any return-type annotation braces by finding the `{` that
  // follows a `)` or `>` at the end of the signature (not inside a type).
  // Simple approach: find the line that starts the function body by looking
  // for the pattern "> {" or ") {" or "): ... {" that opens the function scope.
  // We search for the next `\n` followed by content starting with braces at
  // the correct indentation, but the simplest reliable approach: scan from
  // the signature looking for the LAST `{` on the line containing `> {` or
  // just count braces from the first `{` after the `>` that closes the return type.

  // Find the end of the return type annotation — look for `> {` or `void {`
  let bodyStart = -1;
  for (let i = start; i < source.length - 1; i++) {
    // Function body starts at `> {` (after generic return type) or `) {` (no return type)
    if (source[i] === '{') {
      // Check if we're past the signature by looking for preceding `>` or `)` on same/prev line
      const preceding = source.slice(Math.max(start, i - 100), i).trim();
      if (preceding.endsWith('>') || preceding.endsWith(')') || preceding.endsWith(': void')) {
        bodyStart = i;
        break;
      }
    }
  }
  if (bodyStart === -1) return '';

  let depth = 0;
  let end = bodyStart;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) { end = i + 1; break; }
  }
  return source.slice(start, end);
}

/** Extract the startWebStandaloneMode function body from index.ts source. */
function getWebStandaloneFunction(source: string): string {
  return extractFunction(source, 'async function startWebStandaloneMode()');
}

/** Extract the bootstrapWebContainer function body from index.ts source. */
function getBootstrapWebContainer(source: string): string {
  return extractFunction(source, 'async function bootstrapWebContainer()');
}

describe('Standalone --web mode (#1850)', () => {
  let indexSource: string;

  beforeAll(async () => {
    indexSource = await readFile(path.join(PROJECT_ROOT, 'src/index.ts'), 'utf8');
  });

  describe('Pre-flight zombie kill', () => {
    it('calls recoverStalePort before container bootstrap', () => {
      const fn = getWebStandaloneFunction(indexSource);
      const recoverIdx = fn.indexOf('recoverStalePort(targetPort)');
      const bootstrapIdx = fn.indexOf('bootstrapWebContainer()');
      expect(recoverIdx).toBeGreaterThan(-1);
      expect(bootstrapIdx).toBeGreaterThan(-1);
      expect(recoverIdx).toBeLessThan(bootstrapIdx);
    });

    it('logs recovery failures instead of swallowing them', () => {
      const fn = getWebStandaloneFunction(indexSource);
      const preflightStart = fn.indexOf('Pre-flight: kill any stale');
      const preflightEnd = fn.indexOf('bootstrapWebContainer()');
      const preflightSection = fn.slice(preflightStart, preflightEnd);
      expect(preflightSection).toContain('console.error');
      expect(preflightSection).toContain('Pre-flight port recovery failed');
    });

    it('uses the CLI port flag when provided', () => {
      expect(indexSource).toContain('cliPort || env.DOLLHOUSE_WEB_CONSOLE_PORT');
    });
  });

  describe('completeSinkSetup path', () => {
    it('does NOT call completeDeferredSetup in the web container bootstrap', () => {
      const fn = getBootstrapWebContainer(indexSource);
      expect(fn).not.toContain('completeDeferredSetup()');
      expect(fn).toContain('completeSinkSetup()');
    });

    it('runs sweepStalePortFiles directly instead', () => {
      expect(getBootstrapWebContainer(indexSource)).toContain('sweepStalePortFiles');
    });

    it('still bootstraps handlers for MCP-AQL gateway', () => {
      const fn = getBootstrapWebContainer(indexSource);
      expect(fn).toContain('bootstrapHandlers');
      expect(fn).toContain('mcpAqlHandler');
    });
  });

  describe('Server startup with full sinks', () => {
    it('passes all required options to startWebServer', () => {
      const fn = getWebStandaloneFunction(indexSource);
      expect(fn).toContain('memorySink');
      expect(fn).toContain('metricsSink');
      expect(fn).toContain('tokenStore');
      expect(fn).toContain('additionalRouters');
    });

    it('creates fallback sinks when container does not provide them', () => {
      const fn = getBootstrapWebContainer(indexSource);
      expect(fn).toContain('MemoryLogSink');
      expect(fn).toContain('MemoryMetricsSink');
    });

    it('wires metrics snapshots into the fallback metrics sink', () => {
      const fn = getWebStandaloneFunction(indexSource);
      expect(fn).toContain('metricsOnSnapshot');
      expect(fn).toContain('metricsSink.onSnapshot(snapshot)');
    });

    it('attempts to register a fallback metrics sink with MetricsManager', () => {
      const fn = getBootstrapWebContainer(indexSource);
      expect(fn).toContain("container?.resolve");
      expect(fn).toContain('registerSink(metricsSink)');
    });
  });

  describe('Race condition documentation', () => {
    it('documents the pre-flight stale process recovery comment', () => {
      const fn = getWebStandaloneFunction(indexSource);
      expect(fn).toContain('Pre-flight: kill any stale');
      expect(fn).toContain('#1850');
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
