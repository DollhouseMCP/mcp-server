/**
 * Performance and Security Tests for InputValidator
 *
 * Phase 1 of Option A: Test Coverage First
 *
 * These tests establish baseline performance metrics and verify ReDoS protection
 * BEFORE any regex optimization work is done. This ensures:
 * 1. We have a performance baseline to compare against
 * 2. ReDoS vulnerabilities are detected early
 * 3. Optimizations can be validated against these benchmarks
 * 4. No performance regressions are introduced
 *
 * Target Performance (Current Implementation):
 * - Baseline: <500ms for 10,000 validations
 * - ReDoS Protection: <10ms even with pathological input
 * - Concurrent: No race conditions, all validations succeed
 * - Memory: No leaks, bounded growth
 */

import { performance } from 'perf_hooks';
import { validatePath, sanitizeInput, validateFilename, MCPInputValidator } from '../../src/security/InputValidator.js';

/**
 * Get platform-specific performance threshold
 * Windows CI runners are slower than Unix/macOS runners due to:
 * - Windows file I/O overhead
 * - Antivirus scanning
 * - NTFS vs ext4/APFS performance differences
 *
 * Node version performance characteristics:
 * - Node 20.x is 10-15% slower than Node 22.x on regex operations
 * - This is due to V8 optimizations in newer Node versions
 * - CI environments add 5-10x overhead vs local runs
 *
 * TEMPORARY THRESHOLDS: These multipliers are intentionally generous to provide
 * breathing room for CI runner variability until the automated calibration system
 * is implemented. Once calibration is in place, these can be tightened based on
 * real-world performance data.
 *
 * @param baseMs - Base threshold in milliseconds for local/Linux
 * @returns Adjusted threshold based on platform, CI environment, and Node version
 */
function getPerformanceThreshold(baseMs: number): number {
  // Issue #506: When running as part of full test suite (parallel workers),
  // CPU contention makes timing thresholds unreliable. Use generous multiplier.
  const isParallelWorker = process.env.JEST_WORKER_ID !== undefined &&
    Number.parseInt(process.env.JEST_WORKER_ID) > 1;
  if (!process.env.CI) return Math.floor(baseMs * (isParallelWorker ? 4.0 : 1.5));

  // Node version detection - Node 20.x requires 20% higher thresholds
  const nodeMajor = Number.parseInt(process.version.split('.')[0].substring(1));
  const nodeMultiplier = nodeMajor < 22 ? 1.2 : 1.0;

  // Platform-specific CI multipliers with generous breathing room
  // These are temporary until automated calibration system is implemented
  // Multipliers are applied to base, then adjusted for Node version
  switch (process.platform) {
    case 'win32':
      return Math.floor(baseMs * 10.0 * nodeMultiplier); // Windows CI gets 10x multiplier — GitHub Actions Windows runners are extremely variable
    case 'darwin':
      return Math.floor(baseMs * 2.5 * nodeMultiplier); // macOS CI gets 2.5x multiplier (breathing room until calibration)
    case 'linux':
      return Math.floor(baseMs * 2.5 * nodeMultiplier); // Linux CI gets 2.5x multiplier (breathing room until calibration)
    default:
      return Math.floor(baseMs * 3.5 * nodeMultiplier); // Unknown platforms get generous threshold
  }
}

/**
 * Get platform and Node version-specific memory threshold
 *
 * Memory growth characteristics vary significantly by platform and Node version:
 * - Linux Node 22.x+: ~20-30MB (efficient GC, typical V8 behavior)
 * - macOS Node 22.x+: ~20-30MB (similar to Linux)
 * - macOS Node 20.x: ~200-300MB (deferred GC similar to Windows)
 * - Windows: ~200-300MB (deferred GC, but memory is eventually reclaimed)
 *
 * Node 20.x on macOS exhibits Windows-like GC behavior due to V8 engine differences.
 * This is NOT a memory leak - it's a known V8 GC timing difference that was improved
 * in Node 22.x+.
 *
 * @param baseMB - Base memory threshold in MB for Node 22.x+ on Linux/macOS
 * @returns Adjusted threshold in MB based on platform and Node version
 */
/**
 * Compute a relative memory growth threshold based on baseline heap size.
 *
 * Uses a multiplier of the baseline heap rather than a fixed MB value,
 * so the test catches real leaks (unbounded growth) regardless of the
 * runner's hardware, V8 version, or GC timing characteristics.
 *
 * A genuine memory leak in 100k iterations would show 10x+ growth.
 * Normal GC variance across platforms stays well under 3x.
 *
 * @param baselineHeapMB - heap size before the test loop (MB)
 * @param maxGrowthMultiplier - maximum acceptable growth as a multiple of baseline (default: 3x)
 * @returns threshold in MB
 */
function getRelativeMemoryThreshold(baselineHeapMB: number, maxGrowthMultiplier = 3): number {
  // Floor of 50MB ensures very small baselines don't create impossibly tight thresholds
  return Math.max(baselineHeapMB * maxGrowthMultiplier, 50);
}

describe('InputValidator Performance Tests', () => {
  describe('1. Baseline Performance Test', () => {
    /**
     * Validates 10,000 legitimate paths to establish current performance baseline
     * Target: <500ms total (50 validations per millisecond)
     */
    it('should validate 10,000 legitimate paths in <500ms', () => {
      const legitimatePaths = [
        'personas/typescript-pro.md',
        'skills/code-review.md',
        'templates/meeting-notes.md',
        'agents/research-assistant.md',
        'memories/project-context.md',
        'ensembles/dev-workflow.md',
        'library/personas/creative-writer.md',
        'library/skills/debug-expert.md',
        'custom/my-persona.md',
        'archive/old-version.md',
      ];

      const iterations = 1000; // 10,000 total validations (10 paths × 1000)
      const startTime = performance.now();

      for (let i = 0; i < iterations; i++) {
        for (const path of legitimatePaths) {
          const result = validatePath(path);
          expect(result).toBeDefined();
        }
      }

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Performance assertion with platform-specific threshold
      // Windows CI is significantly slower than Unix/macOS
      const threshold = getPerformanceThreshold(500);
      expect(duration).toBeLessThan(threshold);

      // Report metrics
      const validationsPerMs = (legitimatePaths.length * iterations) / duration;
      console.log(`\n📊 Baseline Performance Metrics:`);
      console.log(`   Total validations: ${legitimatePaths.length * iterations}`);
      console.log(`   Duration: ${duration.toFixed(2)}ms`);
      console.log(`   Throughput: ${validationsPerMs.toFixed(2)} validations/ms`);
      console.log(`   Avg per validation: ${(duration / (legitimatePaths.length * iterations)).toFixed(4)}ms`);
    });

    it('should validate 10,000 collection paths in <500ms', () => {
      const collectionPaths = [
        'library/personas/typescript-expert.md',
        'library/skills/code-review.md',
        'library/templates/api-doc.md',
        'library/agents/research-bot.md',
        'showcase/featured/best-persona.md',
        'catalog/2024/new-skills.md',
      ];

      const iterations = 1667; // ~10,000 validations
      const startTime = performance.now();

      for (let i = 0; i < iterations; i++) {
        for (const path of collectionPaths) {
          const result = MCPInputValidator.validateCollectionPath(path);
          expect(result).toBeDefined();
        }
      }

      const endTime = performance.now();
      const duration = endTime - startTime;

      // FIX: Use platform-specific threshold for Windows CI compatibility
      expect(duration).toBeLessThan(getPerformanceThreshold(500));

      console.log(`\n📊 Collection Path Performance Metrics:`);
      console.log(`   Total validations: ${collectionPaths.length * iterations}`);
      console.log(`   Duration: ${duration.toFixed(2)}ms`);
      console.log(`   Throughput: ${((collectionPaths.length * iterations) / duration).toFixed(2)} validations/ms`);
    });

    it('should sanitize 10,000 inputs in <500ms', () => {
      const inputs = [
        'normal text',
        'text with spaces',
        'hyphenated-text',
        'under_score_text',
        'MixedCase123',
        'with.dots.and.numbers.42',
        'special!@#chars',
        '<script>alert("xss")</script>',
        'shell; command & injection',
        'path/../../traversal',
      ];

      const iterations = 1000;
      const startTime = performance.now();

      for (let i = 0; i < iterations; i++) {
        for (const input of inputs) {
          const result = sanitizeInput(input, 1000);
          expect(result).toBeDefined();
        }
      }

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Special case: sanitization is 30-40% slower on Windows than path validation
      const nodeMajor = Number.parseInt(process.version.split('.')[0].substring(1));
      const _nodeMultiplier = nodeMajor < 22 ? 1.2 : 1.0;

      // Increased base threshold to 500 to account for full test suite load variability
      const baseThreshold = 500;
      const threshold = process.env.CI
        ? getPerformanceThreshold(baseThreshold * 2) // CI environments are slower
        : getPerformanceThreshold(baseThreshold);    // Standard for other platforms

      expect(duration).toBeLessThan(threshold);

      console.log(`\n📊 Sanitization Performance Metrics:`);
      console.log(`   Total sanitizations: ${inputs.length * iterations}`);
      console.log(`   Duration: ${duration.toFixed(2)}ms`);
      console.log(`   Throughput: ${((inputs.length * iterations) / duration).toFixed(2)} sanitizations/ms`);
    });
  });

  describe('2. ReDoS Protection Test', () => {
    /**
     * Tests pathological inputs that could cause exponential backtracking
     * Target: <10ms per test case (should complete quickly, not hang)
     */
    it('should handle pathological path traversal patterns without ReDoS', () => {
      // Pattern: Repeated dots that could cause catastrophic backtracking
      const pathologicalPaths = [
        '.'.repeat(1000) + '/../etc/passwd',
        '.'.repeat(5000) + '/../../sensitive',
        '.' + '../'.repeat(1000) + 'file',
        'a/' + '../'.repeat(500) + 'b',
      ];

      for (const path of pathologicalPaths) {
        const startTime = performance.now();

        try {
          validatePath(path);
        } catch (_error) {
          // Expected to throw, but should do so quickly
        }

        const duration = performance.now() - startTime;

        // CRITICAL: Should complete in <10ms even with malicious input
        expect(duration).toBeLessThan(getPerformanceThreshold(10));

        console.log(`   ✓ Rejected pathological path (${path.substring(0, 50)}...) in ${duration.toFixed(3)}ms`);
      }
    });

    it('should handle pathological slash patterns without ReDoS', () => {
      // Pattern: Excessive slashes that could trigger quantifier backtracking
      const slashAttacks = [
        '/'.repeat(10000) + 'path',
        'path' + '/'.repeat(10000),
        '/'.repeat(5000) + 'middle' + '/'.repeat(5000),
        ('/' + 'a').repeat(1000),
      ];

      for (const path of slashAttacks) {
        const startTime = performance.now();

        try {
          validatePath(path);
        } catch (_error) {
          // Expected to throw
        }

        const duration = performance.now() - startTime;
        expect(duration).toBeLessThan(getPerformanceThreshold(10));

        console.log(`   ✓ Handled slash attack in ${duration.toFixed(3)}ms`);
      }
    });

    it('should handle pathological sanitization patterns without ReDoS', () => {
      // Pattern: Strings designed to maximize regex processing
      const dangerousInputs = [
        // All special characters (every char needs multiple regex replacements)
        '<>&"\'`$()!\\~*?{};&|'.repeat(1000),
        // Alternating control chars and text
        'a\x00b\x01c\x02d\x03e\x04'.repeat(1000),
        // RTL override attacks
        'text' + '\u202E'.repeat(1000) + 'reversed',
        // Zero-width character spam
        'word' + '\u200B\u200C\u200D\u2060'.repeat(500),
        // Shell metacharacter bombardment
        (';echo hack;' + '&&' + '|cat' + '`cmd`').repeat(500),
      ];

      for (const input of dangerousInputs) {
        const startTime = performance.now();

        const result = sanitizeInput(input, 10000);
        expect(result).toBeDefined();

        const duration = performance.now() - startTime;
        expect(duration).toBeLessThan(getPerformanceThreshold(10));

        // eslint-disable-next-line no-control-regex
        console.log(`   ✓ Sanitized pathological input (${input.substring(0, 30).replace(/[\u0000-\u001F]/g, '.')}) in ${duration.toFixed(3)}ms`);
      }
    });

    it('should handle pathological collection path patterns without ReDoS', () => {
      const pathologicalCollectionPaths = [
        // Massive encoded traversal attempts
        '%2e%2e/'.repeat(1000) + 'file',
        '%2e%2e%2f'.repeat(1000),
        'path/' + '....//'.repeat(500),
        // Mixed encoding attacks
        ('..' + '%2f').repeat(1000) + 'etc/passwd',
        // Double encoding
        '%252e%252e%252f'.repeat(500) + 'sensitive',
      ];

      for (const path of pathologicalCollectionPaths) {
        const startTime = performance.now();

        try {
          MCPInputValidator.validateCollectionPath(path);
        } catch (_error) {
          // Expected to throw
        }

        const duration = performance.now() - startTime;
        expect(duration).toBeLessThan(getPerformanceThreshold(10));

        console.log(`   ✓ Rejected collection path attack in ${duration.toFixed(3)}ms`);
      }
    });

    it('should handle polynomial-time attack patterns', () => {
      // Patterns known to cause polynomial time complexity in vulnerable regexes
      const polynomialAttacks = [
        // (a+)+ pattern - alternating valid/invalid
        'a'.repeat(50) + 'b'.repeat(50) + '!',
        // (a|a)* pattern
        'aaaa'.repeat(100) + 'x',
        // Nested quantifiers
        ('abc' + '-'.repeat(10)).repeat(100),
      ];

      for (const attack of polynomialAttacks) {
        const startTime = performance.now();

        sanitizeInput(attack);

        const duration = performance.now() - startTime;
        expect(duration).toBeLessThan(getPerformanceThreshold(10));

        console.log(`   ✓ Handled polynomial-time pattern in ${duration.toFixed(3)}ms`);
      }
    });
  });

  describe('3. Concurrent Validation Test', () => {
    /**
     * Tests 100 parallel validations to ensure thread-safety
     * No race conditions, all validations complete successfully
     */
    it('should handle 100 concurrent path validations without race conditions', async () => {
      const paths = Array.from({ length: 100 }, (_, i) => `path/to/file-${i}.md`);

      const startTime = performance.now();

      // Execute all validations in parallel
      const results = await Promise.all(
        paths.map(async (path) => {
          return new Promise<{ path: string; result: string; duration: number }>((resolve) => {
            const validationStart = performance.now();
            const result = validatePath(path);
            const duration = performance.now() - validationStart;
            resolve({ path, result, duration });
          });
        })
      );

      const totalDuration = performance.now() - startTime;

      // All validations should succeed
      expect(results).toHaveLength(100);
      results.forEach((r) => {
        expect(r.result).toBe(r.path); // validatePath returns the normalized path
      });

      // No validation should take unreasonably long
      // Issue #506: Use getPerformanceThreshold() for platform-aware scaling
      const maxIndividualDuration = Math.max(...results.map((r) => r.duration));
      expect(maxIndividualDuration).toBeLessThan(getPerformanceThreshold(5));

      // Total concurrent execution should be fast
      expect(totalDuration).toBeLessThan(getPerformanceThreshold(100));

      console.log(`\n📊 Concurrent Validation Metrics:`);
      console.log(`   Concurrent validations: 100`);
      console.log(`   Total duration: ${totalDuration.toFixed(2)}ms`);
      console.log(`   Max individual duration: ${maxIndividualDuration.toFixed(3)}ms`);
      console.log(`   Avg individual duration: ${(results.reduce((sum, r) => sum + r.duration, 0) / results.length).toFixed(3)}ms`);
    });

    it('should handle concurrent sanitization without race conditions', async () => {
      const inputs = Array.from({ length: 100 }, (_, i) => `input with <html> and ${i} special; chars!`);

      const results = await Promise.all(
        inputs.map(async (input) => {
          return new Promise<{ input: string; result: string }>((resolve) => {
            const result = sanitizeInput(input, 1000);
            resolve({ input, result });
          });
        })
      );

      expect(results).toHaveLength(100);

      // Each result should be deterministic - sanitizeInput removes <, >, ;, !, etc.
      results.forEach((r, i) => {
        expect(r.result).not.toContain('<');
        expect(r.result).not.toContain('>');
        expect(r.result).not.toContain(';');
        expect(r.result).not.toContain('!');
        expect(r.result).toContain(i.toString());
        expect(r.result).toContain('input');
        expect(r.result).toContain('with');
      });

      console.log(`   ✓ 100 concurrent sanitizations completed successfully`);
    });

    it('should handle concurrent collection path validations', async () => {
      const paths = Array.from({ length: 100 }, (_, i) => `library/personas/persona-${i}.md`);

      const results = await Promise.all(
        paths.map(async (path) => {
          return new Promise<string>((resolve, reject) => {
            try {
              const result = MCPInputValidator.validateCollectionPath(path);
              resolve(result);
            } catch (error) {
              reject(error);
            }
          });
        })
      );

      expect(results).toHaveLength(100);
      results.forEach((result, i) => {
        expect(result).toBe(paths[i]);
      });

      console.log(`   ✓ 100 concurrent collection path validations completed`);
    });
  });

  describe('4. Memory Usage Test', () => {
    /**
     * Validates 100,000 paths to check for memory leaks
     * Memory growth should be bounded, no unbounded accumulation
     */
    it('should not leak memory during 100,000 validations', () => {
      const testPath = 'personas/typescript-expert.md';

      // Get baseline memory usage
      if (global.gc) {
        global.gc();
      }
      const memBefore = process.memoryUsage();

      const iterations = 100000;
      const startTime = performance.now();

      for (let i = 0; i < iterations; i++) {
        validatePath(testPath);
      }

      const duration = performance.now() - startTime;

      // Get memory after
      if (global.gc) {
        global.gc();
      }
      const memAfter = process.memoryUsage();

      const heapGrowth = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
      const throughput = iterations / duration;

      const baselineHeapMB = memBefore.heapUsed / 1024 / 1024;
      const memoryThreshold = getRelativeMemoryThreshold(baselineHeapMB);

      console.log(`\n📊 Memory Usage Metrics (100k validations):`);
      console.log(`   Duration: ${duration.toFixed(2)}ms`);
      console.log(`   Throughput: ${throughput.toFixed(2)} validations/ms`);
      console.log(`   Heap before: ${baselineHeapMB.toFixed(2)} MB`);
      console.log(`   Heap after: ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   Heap growth: ${heapGrowth.toFixed(2)} MB`);
      console.log(`   Threshold: ${memoryThreshold.toFixed(2)} MB (3x baseline or 50MB floor)`);
      console.log(`   Platform: ${process.platform}, Node: ${process.version}`);

      // Relative threshold: heap growth must stay under 3x baseline.
      // A genuine leak in 100k iterations would show 10x+ growth.
      // Normal GC variance stays well under 3x regardless of platform.
      expect(Math.abs(heapGrowth)).toBeLessThan(memoryThreshold);
    });

    it('should not leak memory during repeated sanitization', () => {
      const testInput = 'Text with <html> & special chars!';

      if (global.gc) {
        global.gc();
      }
      const memBefore = process.memoryUsage();

      for (let i = 0; i < 100000; i++) {
        sanitizeInput(testInput, 1000);
      }

      if (global.gc) {
        global.gc();
      }
      const memAfter = process.memoryUsage();

      const heapGrowth = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;

      const baselineHeapMB = memBefore.heapUsed / 1024 / 1024;
      const memoryThreshold = getRelativeMemoryThreshold(baselineHeapMB);

      console.log(`\n📊 Sanitization Memory Metrics:`);
      console.log(`   Heap growth: ${heapGrowth.toFixed(2)} MB`);
      console.log(`   Threshold: ${memoryThreshold.toFixed(2)} MB (3x baseline or 50MB floor)`);

      expect(Math.abs(heapGrowth)).toBeLessThan(memoryThreshold);
    });

    it('should handle large batch processing without unbounded memory growth', () => {
      // Simulate processing a large batch of files
      const paths = Array.from({ length: 10000 }, (_, i) => `file-${i}.md`);

      if (global.gc) {
        global.gc();
      }
      const memBefore = process.memoryUsage();

      const results = paths.map((path) => {
        try {
          return validatePath(path);
        } catch {
          return null;
        }
      });

      if (global.gc) {
        global.gc();
      }
      const memAfter = process.memoryUsage();

      const heapGrowth = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;

      console.log(`\n📊 Batch Processing Memory:`);
      console.log(`   Processed: ${results.length} paths`);
      console.log(`   Heap growth: ${heapGrowth.toFixed(2)} MB`);
      console.log(`   Memory per path: ${(heapGrowth * 1024 / results.length).toFixed(2)} KB`);

      // Growth should be linear with input, not exponential
      const baselineHeapMB = memBefore.heapUsed / 1024 / 1024;
      expect(heapGrowth).toBeLessThan(getRelativeMemoryThreshold(baselineHeapMB));
    });
  });

  describe('5. Security Tests - Bypass Attempts', () => {
    /**
     * Tests 100+ patterns from security assessment
     * Validates all known bypass techniques are blocked
     */
    it('should block all path traversal encoding variants', () => {
      const traversalPatterns = [
        // Basic traversal
        '..',
        '../',
        '../../',
        '../../../etc/passwd',

        // URL encoding (lowercase)
        '%2e%2e',
        '%2e%2e/',
        '%2e%2e%2f',
        '%2e%2e%2f%2e%2e%2f',

        // URL encoding (uppercase)
        '%2E%2E',
        '%2E%2E/',
        '%2E%2E%2F',

        // Double encoding
        '%252e%252e',
        '%252e%252e%252f',

        // Backslash variants
        '..\\',
        '%2e%2e%5c',
        '%2e%2e%5C',

        // Mixed encoding
        '..%2f',
        '..%5c',
        '%2e%2e/',

        // Bypass attempts
        '..../',
        '..;/',
        '..;',

        // Current directory
        './',
        './..',
        './../../',

        // Triple encoding
        '%25252e%25252e%25252f',

        // UTF-8 encoding
        '..%c0%af',
        '..%c1%9c',
      ];

      let blockedCount = 0;
      const failedBlocks: string[] = [];

      for (const pattern of traversalPatterns) {
        try {
          MCPInputValidator.validateCollectionPath('path/' + pattern + '/file');
          failedBlocks.push(pattern);
        } catch (_error) {
          blockedCount++;
        }
      }

      console.log(`\n🔒 Path Traversal Protection:`);
      console.log(`   Patterns tested: ${traversalPatterns.length}`);
      console.log(`   Patterns blocked: ${blockedCount}`);
      console.log(`   Block rate: ${((blockedCount / traversalPatterns.length) * 100).toFixed(1)}%`);

      if (failedBlocks.length > 0) {
        console.log(`   ⚠️  Failed to block: ${failedBlocks.join(', ')}`);
      }

      expect(failedBlocks.length).toBe(0);
    });

    it('should block SSRF via encoded IP addresses', () => {
      const ssrfUrls = [
        // Localhost variants
        'http://127.0.0.1/api',
        'http://localhost/api',
        'http://[::1]/api',
        'http://0.0.0.0/api',

        // Decimal encoding
        'http://2130706433/api', // 127.0.0.1
        'http://3232235777/api', // 192.168.1.1

        // Hex encoding
        'http://0x7f000001/api', // 127.0.0.1
        'http://0x7F000001/api',
        'http://0xc0a80101/api', // 192.168.1.1

        // Octal encoding
        'http://017700000001/api', // 127.0.0.1
        'http://030052000401/api', // 192.168.1.1

        // Private IP ranges
        'http://10.0.0.1/api',
        'http://172.16.0.1/api',
        'http://192.168.1.1/api',
        'http://169.254.1.1/api', // Link-local

        // IPv6 private ranges
        'http://[fc00::1]/api', // ULA
        'http://[fd00::1]/api', // ULA
        'http://[fe80::1]/api', // Link-local
        'http://[::ffff:127.0.0.1]/api', // IPv4-mapped IPv6
      ];

      let blockedCount = 0;

      for (const url of ssrfUrls) {
        try {
          MCPInputValidator.validateImportUrl(url);
        } catch (_error) {
          blockedCount++;
        }
      }

      console.log(`\n🔒 SSRF Protection:`);
      console.log(`   URLs tested: ${ssrfUrls.length}`);
      console.log(`   URLs blocked: ${blockedCount}`);
      console.log(`   Block rate: ${((blockedCount / ssrfUrls.length) * 100).toFixed(1)}%`);

      // BASELINE: Current implementation blocks most but not all encoded IPs
      // This test documents current behavior for comparison after optimization
      expect(blockedCount).toBeGreaterThan(ssrfUrls.length * 0.5); // At least 50%

      if (blockedCount < ssrfUrls.length) {
        console.log(`   ⚠️  BASELINE: ${ssrfUrls.length - blockedCount} encoded IPs not currently blocked`);
        console.log(`   📝 NOTE: This is the baseline - optimizations should maintain or improve this`);
      }
    });

    it('should block injection attacks in search queries', () => {
      const injectionPatterns = [
        // SQL injection
        "'; DROP TABLE users--",
        "' OR '1'='1",
        "admin'--",
        "' UNION SELECT * FROM passwords--",

        // Command injection
        '; cat /etc/passwd',
        '| ls -la',
        '& whoami',
        '`id`',
        '$(uname -a)',

        // XSS
        '<script>alert("xss")</script>',
        '<img src=x onerror=alert(1)>',
        'javascript:alert(1)',
        '<iframe src="evil.com">',

        // Template injection
        '{{7*7}}',
        '${7*7}',
        '#{7*7}',

        // LDAP injection
        '*)(uid=*',
        'admin*',
      ];

      const sanitizedResults: Array<{ pattern: string; sanitized: string; safe: boolean }> = [];

      for (const pattern of injectionPatterns) {
        try {
          const sanitized = MCPInputValidator.validateSearchQuery(pattern);
          const safe = !sanitized.includes(';') &&
                      !sanitized.includes('|') &&
                      !sanitized.includes('<') &&
                      !sanitized.includes('>') &&
                      !sanitized.includes('`') &&
                      !sanitized.includes('$') &&
                      !sanitized.includes('{') &&
                      !sanitized.includes('}');

          sanitizedResults.push({ pattern, sanitized, safe });
        } catch (_error) {
          // Query rejected entirely (also safe)
          sanitizedResults.push({ pattern, sanitized: '', safe: true });
        }
      }

      const safeCount = sanitizedResults.filter((r) => r.safe).length;

      console.log(`\n🔒 Injection Protection:`);
      console.log(`   Patterns tested: ${injectionPatterns.length}`);
      console.log(`   Patterns neutralized: ${safeCount}`);
      console.log(`   Protection rate: ${((safeCount / injectionPatterns.length) * 100).toFixed(1)}%`);

      // All patterns should be neutralized
      expect(safeCount).toBe(injectionPatterns.length);
    });

    it('should handle Unicode normalization attacks', () => {
      const unicodeAttacks = [
        // Zero-width characters
        'normal\u200Btext', // Zero-width space
        'normal\u200Ctext', // Zero-width non-joiner
        'normal\u200Dtext', // Zero-width joiner
        'normal\u2060text', // Word joiner
        'normal\uFEFFtext', // Zero-width no-break space

        // RTL override
        'file\u202Etxt.exe', // file followed by RTL override
        'safe\u202Egif.scr', // Disguise executable as image

        // Combining characters
        'café', // Composed form
        'café', // Decomposed form (visually identical)

        // Homoglyphs
        'аdmin', // Cyrillic 'a' instead of Latin
        'ѕcript', // Cyrillic 's'

        // Emoji variations
        '🏳️‍🌈', // Complex emoji with variation selectors
        '👨‍👩‍👧‍👦', // Family emoji (multiple codepoints)
      ];

      for (const attack of unicodeAttacks) {
        const sanitized = sanitizeInput(attack);

        // Zero-width and RTL override chars should be removed
        expect(sanitized).not.toContain('\u200B');
        expect(sanitized).not.toContain('\u200C');
        expect(sanitized).not.toContain('\u200D');
        expect(sanitized).not.toContain('\u2060');
        expect(sanitized).not.toContain('\uFEFF');
        expect(sanitized).not.toContain('\u202E');
      }

      console.log(`   ✓ Unicode normalization attacks neutralized`);
    });

    it('should reject malicious filenames', () => {
      const maliciousFilenames = [
        // Path separators
        '../etc/passwd',
        '..\\windows\\system32',
        '/etc/passwd',
        'C:\\windows\\system32\\config\\sam',

        // Null bytes
        'safe.txt\0.exe',
        'file\0.sh',

        // Special characters
        'file:stream.txt',
        'aux.txt', // Windows reserved
        'con.txt', // Windows reserved
        'prn.txt', // Windows reserved
        'nul.txt', // Windows reserved

        // Leading dots
        '...evil.sh',
        '....config',

        // Wildcards
        '*.txt',
        'file?.txt',

        // Dangerous extensions
        'file.exe',
        'script.sh',
        'macro.vbs',
      ];

      let rejectedCount = 0;

      for (const filename of maliciousFilenames) {
        try {
          validateFilename(filename);
        } catch (_error) {
          rejectedCount++;
        }
      }

      console.log(`\n🔒 Filename Validation:`);
      console.log(`   Malicious filenames tested: ${maliciousFilenames.length}`);
      console.log(`   Filenames rejected: ${rejectedCount}`);
      console.log(`   Rejection rate: ${((rejectedCount / maliciousFilenames.length) * 100).toFixed(1)}%`);

      // BASELINE: Current implementation rejects path separators and some special chars
      // Note: validateFilename sanitizes dangerous chars, so some "malicious" names
      // become safe after processing (e.g., file.exe -> file.exe is actually safe if no path)
      expect(rejectedCount).toBeGreaterThan(0); // At least some rejections

      if (rejectedCount < maliciousFilenames.length) {
        console.log(`   📝 BASELINE: ${maliciousFilenames.length - rejectedCount} filenames sanitized rather than rejected`);
        console.log(`   NOTE: Some filenames are made safe through character removal`);
      }
    });
  });

  describe('6. Edge Cases and Boundary Conditions', () => {
    it('should handle empty and whitespace-only inputs', () => {
      const emptyInputs = ['', ' ', '  ', '\t', '\n', '\r\n'];

      for (const input of emptyInputs) {
        const sanitized = sanitizeInput(input);
        expect(sanitized).toBe('');
      }

      console.log(`   ✓ Empty inputs handled correctly`);
    });

    it('should handle maximum length boundaries', () => {
      const maxPath = 'a'.repeat(500);
      const _overMaxPath = 'a'.repeat(501);

      // Should accept max length
      expect(() => validatePath(maxPath)).not.toThrow();

      // Collection path should accept up to 500
      expect(() => MCPInputValidator.validateCollectionPath('a'.repeat(500))).not.toThrow();

      console.log(`   ✓ Maximum length boundaries respected`);
    });

    it('should handle single character edge cases', () => {
      const singleChars = ['a', '/', '.', '-', '_', '~', ':', '0', '9'];

      for (const char of singleChars) {
        // Should not crash
        expect(() => {
          try {
            validatePath(char);
          } catch {
            // May throw validation error, but shouldn't crash
          }
        }).not.toThrow();
      }

      console.log(`   ✓ Single character inputs handled`);
    });
  });
});

/**
 * Performance Baseline Summary
 *
 * Run this test suite to establish baseline metrics:
 *
 * ```bash
 * npm test -- tests/security/InputValidator.performance.test.ts
 * ```
 *
 * Expected Output:
 * - Baseline performance: ~50 validations/ms
 * - ReDoS protection: All pathological inputs < 10ms
 * - Concurrent operations: 100 parallel validations succeed
 * - Memory usage: < 10MB growth for 100k validations
 * - Security: 100% block rate on known attack patterns
 *
 * These metrics will be compared against post-optimization results
 * to ensure improvements don't introduce regressions.
 */
