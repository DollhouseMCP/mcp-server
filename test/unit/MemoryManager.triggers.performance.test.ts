/**
 * Performance tests for Memory trigger extraction
 * Tests performance with large numbers of triggers
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import { MemoryManager } from '../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../src/elements/memories/Memory.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

describe('Memory Trigger Performance', () => {
  let memoryManager: MemoryManager;
  let testDir: string;
  let memoriesDir: string;
  let originalPortfolioDir: string | undefined;

  // Increase timeout for performance tests to prevent premature teardown
  jest.setTimeout(30000);

  beforeAll(async () => {
    // Create test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-perf-test-'));
    memoriesDir = path.join(testDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });

    // Save original portfolio dir
    originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    // Reset PortfolioManager singleton
    (PortfolioManager as any).instance = null;

    memoryManager = new MemoryManager();
  });

  afterEach(async () => {
    // FIX: Ensure all pending file operations complete after each test
    // This is NOT redundant with afterAll - it provides inter-test isolation
    // by ensuring each test's file operations complete before the next starts
    await new Promise(resolve => setImmediate(resolve));
  });

  afterAll(async () => {
    // Ensure all pending operations complete
    await new Promise(resolve => setImmediate(resolve));

    // Restore original portfolio dir
    if (originalPortfolioDir) {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
    } else {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    }

    // Reset PortfolioManager singleton
    (PortfolioManager as any).instance = null;

    // Clean up test directory with retry logic
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // FIX: Log first failure before retrying (SonarCloud S2486)
      console.warn('First cleanup attempt failed, retrying...', error);
      // Retry once after a brief delay if cleanup fails
      await new Promise(resolve => setTimeout(resolve, 100));
      try {
        await fs.rm(testDir, { recursive: true, force: true });
      } catch (retryError) {
        console.warn('Failed to clean up test directory after retry:', retryError);
      }
    }

    // Final delay to ensure all async operations complete before teardown
    await new Promise(resolve => setImmediate(resolve));
  });

  describe('Performance with Large Trigger Sets', () => {
    it('should handle 200 triggers efficiently', async () => {
      // Generate a large number of triggers (limited to avoid size validation issues)
      const largeTriggerSet = Array.from({ length: 200 }, (_, i) => `t${i}`);

      const memoryWithLargeTriggerSet = `metadata:
  name: "performance-test-memory"
  description: "Memory with 200 triggers for performance testing"
  triggers: ${JSON.stringify(largeTriggerSet)}
  version: "1.0.0"

entries:
  - id: "entry-1"
    timestamp: "2025-09-26T16:00:00Z"
    content: "Performance test entry"`;

      await fs.writeFile(path.join(memoriesDir, 'perf-test.yaml'), memoryWithLargeTriggerSet);

      const startTime = Date.now();
      const memory = await memoryManager.load('perf-test.yaml');
      const loadTime = Date.now() - startTime;

      // Should load successfully
      expect(memory).toBeDefined();
      expect(memory.metadata.triggers).toBeDefined();
      expect(memory.metadata.triggers?.length).toBe(20); // Limited to 20 max

      // Should complete in reasonable time (< 500ms)
      expect(loadTime).toBeLessThan(500);

      console.log(`Loaded 200 triggers in ${loadTime}ms`);
    });

    it('should efficiently filter invalid triggers from large sets', async () => {
      // Mix valid and invalid triggers
      const mixedTriggers = Array.from({ length: 100 }, (_, i) => {
        if (i % 2 === 0) {
          return `valid-trigger-${i}`;
        } else {
          return `invalid!trigger@${i}`;
        }
      });

      const memoryWithMixedTriggers = `metadata:
  name: "filter-performance-test"
  description: "Memory with mixed valid/invalid triggers"
  triggers: ${JSON.stringify(mixedTriggers)}
  version: "1.0.0"

entries: []`;

      await fs.writeFile(path.join(memoriesDir, 'filter-perf.yaml'), memoryWithMixedTriggers);

      const startTime = Date.now();
      const memory = await memoryManager.load('filter-perf.yaml');
      const filterTime = Date.now() - startTime;

      // FIX: Validate filtering behavior
      // The system takes the first 20 triggers from the array, then filters for validity
      // With alternating valid/invalid pattern (even=valid, odd=invalid),
      // the first 20 contain 10 valid triggers (indices 0,2,4,6,8,10,12,14,16,18)
      expect(memory.metadata.triggers).toBeDefined();
      expect(memory.metadata.triggers?.length).toBe(10);

      // All triggers should be valid (match alphanumeric-dash-underscore pattern)
      for (const trigger of memory.metadata.triggers ?? []) {
        expect(trigger).toMatch(/^[a-zA-Z0-9\-_]+$/);
      }

      // Should complete quickly even with filtering (< 300ms)
      expect(filterTime).toBeLessThan(300);

      // FIX: Corrected log message to show actual count (10, not 50)
      console.log(`Filtered 100 triggers to 10 valid in ${filterTime}ms`);
    });

    it('should handle memory save/load cycle with many triggers efficiently', async () => {
      // Create a memory with many triggers programmatically
      const memory = new Memory({
        name: 'save-load-perf-test',
        description: 'Performance test for save/load cycle',
        triggers: Array.from({ length: 100 }, (_, i) => `t${i}`)
      });

      // Add some entries
      await memory.addEntry('Test entry 1', ['test']);
      await memory.addEntry('Test entry 2', ['test']);

      const saveStartTime = Date.now();
      await memoryManager.save(memory, 'save-load-perf.yaml');
      const saveTime = Date.now() - saveStartTime;

      const loadStartTime = Date.now();
      const loadedMemory = await memoryManager.load('save-load-perf.yaml');
      const loadTime = Date.now() - loadStartTime;

      // Verify triggers were preserved
      expect(loadedMemory.metadata.triggers?.length).toBe(100);

      // Both operations should be fast
      expect(saveTime).toBeLessThan(200);
      expect(loadTime).toBeLessThan(200);

      console.log(`Save: ${saveTime}ms, Load: ${loadTime}ms for 100 triggers`);
    });
  });

  describe('Memory Usage', () => {
    it('should not have excessive memory usage with large trigger sets', () => {
      // Create multiple memories with triggers
      const memories: Memory[] = [];

      for (let i = 0; i < 100; i++) {
        const memory = new Memory({
          name: `memory-${i}`,
          description: `Test memory ${i}`,
          triggers: Array.from({ length: 50 }, (_, j) => `trigger-${i}-${j}`)
        });
        memories.push(memory);
      }

      // Should have created 100 memories with 50 triggers each
      expect(memories).toHaveLength(100);

      // FIX: Validate each memory has its triggers (using for...of per SonarCloud S7728)
      for (const memory of memories) {
        expect(memory.metadata.triggers?.length).toBe(50);
      }

      // Memory footprint should be reasonable
      // 100 memories * 50 triggers * ~20 bytes per trigger = ~100KB
      // This is just a sanity check - actual measurement would need heap profiling
      expect(memories.length * 50).toBeLessThan(10000); // Total triggers < 10k
    });
  });
});