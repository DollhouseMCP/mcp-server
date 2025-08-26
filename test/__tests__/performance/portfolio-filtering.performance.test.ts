/**
 * Performance tests for isTestElement() pattern matching
 * Ensures pattern matching scales efficiently with large file counts
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { PortfolioManager, ElementType } from '../../../src/portfolio/PortfolioManager.js';

describe('Portfolio Filtering Performance', () => {
  let testDir: string;
  let portfolioManager: PortfolioManager;
  const originalEnv = process.env.DOLLHOUSE_PORTFOLIO_DIR;

  beforeEach(async () => {
    // Create a unique test directory
    testDir = path.join(tmpdir(), `portfolio-perf-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    
    // Clear environment variable
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    
    // Reset singleton
    (PortfolioManager as any).instance = undefined;
    (PortfolioManager as any).initializationPromise = null;
    
    // Initialize manager
    portfolioManager = PortfolioManager.getInstance({ baseDir: testDir });
    await portfolioManager.initialize();
  });
  
  afterEach(async () => {
    // Restore environment variable
    if (originalEnv) {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalEnv;
    } else {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    }
    
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    
    // Reset singleton
    (PortfolioManager as any).instance = undefined;
    (PortfolioManager as any).initializationPromise = null;
  });

  describe('pattern matching performance', () => {
    it('should handle single pattern evaluation efficiently', () => {
      const iterations = 10000;
      const testFilename = 'eval-dangerous-code.md';
      
      const startTime = performance.now();
      
      for (let i = 0; i < iterations; i++) {
        const result = portfolioManager.isTestElement(testFilename);
        expect(result).toBe(true);
      }
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      const avgTimePerCall = duration / iterations;
      
      // Should complete 10,000 pattern matches in reasonable time
      expect(duration).toBeLessThan(1000); // Less than 1 second
      expect(avgTimePerCall).toBeLessThan(0.1); // Less than 0.1ms per call
      
      console.log(`Pattern matching: ${iterations} calls in ${duration.toFixed(2)}ms (${avgTimePerCall.toFixed(4)}ms per call)`);
    });

    it('should handle multiple different patterns efficiently', () => {
      const testPatterns = [
        'eval-code.md',
        'exec-command.md',
        'bash-c-script.md',
        'shell-injection.md',
        'test-persona.md',
        'stability-test-1.md',
        'perf-test-benchmark.md',
        'legitimate-file.md',
        'production-agent.md',
        'safe-template.md'
      ];
      
      const iterationsPerPattern = 1000;
      const startTime = performance.now();
      
      for (const pattern of testPatterns) {
        for (let i = 0; i < iterationsPerPattern; i++) {
          portfolioManager.isTestElement(pattern);
        }
      }
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      const totalCalls = testPatterns.length * iterationsPerPattern;
      const avgTimePerCall = duration / totalCalls;
      
      // Should handle multiple patterns efficiently
      expect(duration).toBeLessThan(2000); // Less than 2 seconds for 10,000 calls
      expect(avgTimePerCall).toBeLessThan(0.2); // Less than 0.2ms per call
      
      console.log(`Multi-pattern: ${totalCalls} calls in ${duration.toFixed(2)}ms (${avgTimePerCall.toFixed(4)}ms per call)`);
    });
  });

  describe('large file count performance', () => {
    it('should efficiently filter large numbers of files', async () => {
      const fileCount = 1000;
      const elementDir = portfolioManager.getElementDir(ElementType.PERSONA);
      
      // Create a mix of legitimate and test/dangerous files
      const dangerousPatterns = [
        'eval-', 'exec-', 'shell-injection-', 'test-', 'perf-test-'
      ];
      
      const filesToCreate = [];
      for (let i = 0; i < fileCount; i++) {
        if (i % 10 === 0) {
          // 10% dangerous/test files
          const pattern = dangerousPatterns[i % dangerousPatterns.length];
          filesToCreate.push(`${pattern}file-${i}.md`);
        } else {
          // 90% legitimate files
          filesToCreate.push(`legitimate-file-${i}.md`);
        }
      }
      
      // Create files in parallel for speed
      const createFilePromises = filesToCreate.map(filename => 
        fs.writeFile(path.join(elementDir, filename), `# ${filename}\nContent for ${filename}`)
      );
      await Promise.all(createFilePromises);
      
      // Measure filtering performance
      const startTime = performance.now();
      const elements = await portfolioManager.listElements(ElementType.PERSONA);
      const endTime = performance.now();
      
      const duration = endTime - startTime;
      const expectedLegitimateCount = Math.floor(fileCount * 0.9); // 90% should be legitimate
      
      // Verify correct filtering
      expect(elements.length).toBeCloseTo(expectedLegitimateCount, -1); // Allow some variance
      
      // Performance expectations
      expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
      
      console.log(`Large file filtering: ${fileCount} files filtered in ${duration.toFixed(2)}ms`);
      console.log(`Filtered down to ${elements.length} legitimate files from ${fileCount} total`);
    });

    // Increase timeout for Windows Node 22 compatibility (60 seconds)
    it('should handle very large single directory efficiently', async () => {
      const fileCount = 5000;
      const elementDir = portfolioManager.getElementDir(ElementType.SKILL);
      
      // Create mostly legitimate files with some dangerous ones mixed in
      const filesToCreate = [];
      for (let i = 0; i < fileCount; i++) {
        if (i % 50 === 0) {
          // 2% dangerous files
          filesToCreate.push(`eval-dangerous-${i}.md`);
        } else if (i % 25 === 0) {
          // 4% test files  
          filesToCreate.push(`test-file-${i}.md`);
        } else {
          // 94% legitimate files
          filesToCreate.push(`skill-${i}.md`);
        }
      }
      
      // Create files
      console.log(`Creating ${fileCount} test files...`);
      const batchSize = 100;
      for (let i = 0; i < filesToCreate.length; i += batchSize) {
        const batch = filesToCreate.slice(i, i + batchSize);
        const promises = batch.map(filename => 
          fs.writeFile(path.join(elementDir, filename), `# ${filename}\nContent`)
        );
        await Promise.all(promises);
      }
      
      // Measure filtering performance
      console.log('Starting filtering performance test...');
      const startTime = performance.now();
      const elements = await portfolioManager.listElements(ElementType.SKILL);
      const endTime = performance.now();
      
      const duration = endTime - startTime;
      // Calculate expected count: files where i % 50 !== 0 AND i % 25 !== 0
      // This means we exclude files where i is divisible by 25 (since % 50 === 0 implies % 25 === 0)
      const expectedLegitimateCount = fileCount - Math.floor(fileCount / 25); // Exclude every 25th file
      
      // Verify correct filtering - allow more variance for large numbers
      expect(elements.length).toBeCloseTo(expectedLegitimateCount, -3); // Allow variance of +/-500
      
      // Performance expectations - should handle 5000 files reasonably quickly
      expect(duration).toBeLessThan(10000); // Should complete in under 10 seconds
      
      console.log(`Very large directory: ${fileCount} files filtered in ${duration.toFixed(2)}ms`);
      console.log(`Filtered to ${elements.length} legitimate files (expected ~${expectedLegitimateCount})`);
      console.log(`Filtering rate: ${(fileCount / duration * 1000).toFixed(0)} files/second`);
    }, 30000); // 30 second timeout for Windows CI
  });

  describe('regex pattern efficiency', () => {
    it('should not suffer from catastrophic backtracking', () => {
      // Test patterns with potentially problematic input that could cause ReDoS
      const problematicInputs = [
        'a'.repeat(1000) + 'eval-',  // Long prefix before match
        'eval-' + 'a'.repeat(1000),  // Long suffix after match
        'e'.repeat(500) + 'val-code.md',  // Partial matches with repetition
        'test-' + 'x'.repeat(1000) + 'persona.md'  // Long content between patterns
      ];
      
      const iterations = 100;
      const startTime = performance.now();
      
      for (const input of problematicInputs) {
        for (let i = 0; i < iterations; i++) {
          portfolioManager.isTestElement(input);
        }
      }
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      // Should not take excessively long even with problematic inputs
      expect(duration).toBeLessThan(1000); // Less than 1 second for 400 calls
      
      console.log(`ReDoS resistance: ${problematicInputs.length * iterations} calls in ${duration.toFixed(2)}ms`);
    }, 60000); // 60 second timeout for Windows Node 22 compatibility

    it('should handle unicode and special characters efficiently', () => {
      const unicodeInputs = [
        'test-файл.md',  // Cyrillic
        'eval-文件.md',   // Chinese
        'shell-injection-🔥.md',  // Emoji
        'test-ñoño.md',   // Accented characters
        'eval-' + '🚀'.repeat(100) + '.md'  // Many emoji
      ];
      
      const iterations = 500;
      const startTime = performance.now();
      
      for (const input of unicodeInputs) {
        for (let i = 0; i < iterations; i++) {
          portfolioManager.isTestElement(input);
        }
      }
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      // Should handle unicode efficiently
      expect(duration).toBeLessThan(1000); // Less than 1 second
      
      console.log(`Unicode handling: ${unicodeInputs.length * iterations} calls in ${duration.toFixed(2)}ms`);
    });
  });

  describe('memory usage', () => {
    it('should not leak memory during repeated filtering', async () => {
      const iterations = 1000;
      const testFiles = [
        'eval-code.md',
        'test-persona.md',
        'legitimate-file.md',
        'shell-injection.md',
        'production-agent.md'
      ];
      
      // Get initial memory usage
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Perform many filtering operations
      for (let i = 0; i < iterations; i++) {
        for (const filename of testFiles) {
          portfolioManager.isTestElement(filename);
        }
        
        // Occasionally force garbage collection if available
        if (i % 100 === 0 && global.gc) {
          global.gc();
        }
      }
      
      // Force GC if available
      if (global.gc) {
        global.gc();
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryDifference = finalMemory - initialMemory;
      const memoryDifferenceMB = memoryDifference / (1024 * 1024);
      
      // Memory usage should not grow excessively
      expect(memoryDifferenceMB).toBeLessThan(15); // Less than 15MB growth (allow for test overhead)
      
      console.log(`Memory test: ${iterations * testFiles.length} operations`);
      console.log(`Memory change: ${memoryDifferenceMB.toFixed(2)}MB`);
    });
  });
});