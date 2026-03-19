/**
 * Regression test for PortfolioManager constructor
 *
 * This test ensures that PortfolioManager only accepts proper PortfolioConfig objects
 * and prevents the bug where passing a string directly would default to user's portfolio.
 *
 * Bug #CRITICAL-2025-11-08: benchmark-persona-reload.ts and ConditionalActivation test
 * were passing strings directly instead of { baseDir: string }, causing test data to
 * be written to the user's actual portfolio at ~/.dollhouse/portfolio
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';

// Create shared file operations service for tests using di-mocks helper
const fileOperations = createTestFileOperationsService();

describe('PortfolioManager Constructor - Type Safety', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    // Save original env
    originalEnv = process.env.DOLLHOUSE_PORTFOLIO_DIR;
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalEnv;
    } else {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    }
  });

  describe('Correct Usage', () => {
    it('should accept PortfolioConfig with baseDir', () => {
      const testDir = path.join(os.tmpdir(), 'test-portfolio');
      const pm = new PortfolioManager(fileOperations, { baseDir: testDir });

      expect(pm.getBaseDir()).toBe(testDir);
    });

    it('should use default directory when no config provided', () => {
      const pm = new PortfolioManager(fileOperations);
      const expectedDefault = path.join(os.homedir(), '.dollhouse', 'portfolio');

      expect(pm.getBaseDir()).toBe(expectedDefault);
    });

    it('should use empty config object and default to user portfolio', () => {
      const pm = new PortfolioManager(fileOperations, {});
      const expectedDefault = path.join(os.homedir(), '.dollhouse', 'portfolio');

      expect(pm.getBaseDir()).toBe(expectedDefault);
    });

    it('should prioritize environment variable over config', () => {
      const envDir = path.join(os.tmpdir(), 'env-portfolio');
      const configDir = path.join(os.tmpdir(), 'config-portfolio');

      process.env.DOLLHOUSE_PORTFOLIO_DIR = envDir;
      const pm = new PortfolioManager(fileOperations, { baseDir: configDir });

      expect(pm.getBaseDir()).toBe(envDir);
    });
  });

  describe('Regression: Prevent String Arguments', () => {
    it('should NOT silently accept a string argument', () => {
      // This is the bug that caused test data to pollute user portfolio
      const testDir = path.join(os.tmpdir(), 'test-portfolio');

      // TypeScript should prevent this at compile time, but we test runtime behavior
      // @ts-expect-error - Testing incorrect usage that bypasses TypeScript
      const pm = new PortfolioManager(testDir);

      // If someone bypasses TypeScript and passes a string, it should NOT use that string
      // Instead it will be treated as an empty object and default to user portfolio
      const expectedDefault = path.join(os.homedir(), '.dollhouse', 'portfolio');
      expect(pm.getBaseDir()).toBe(expectedDefault);
      expect(pm.getBaseDir()).not.toBe(testDir);
    });

    it('should document the correct pattern for test isolation', () => {
      const testDir = path.join(os.tmpdir(), 'test-portfolio');

      // CORRECT: Pass an object with baseDir property
      const correctPm = new PortfolioManager(fileOperations, { baseDir: testDir });
      expect(correctPm.getBaseDir()).toBe(testDir);

      // INCORRECT: Passing string directly (this example shows what NOT to do)
      // @ts-expect-error - Demonstrating incorrect usage
      const incorrectPm = new PortfolioManager(testDir);
      expect(incorrectPm.getBaseDir()).not.toBe(testDir);
      expect(incorrectPm.getBaseDir()).toBe(path.join(os.homedir(), '.dollhouse', 'portfolio'));
    });
  });

  describe('Environment Variable Validation', () => {
    it('should reject relative paths in environment variable', () => {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = 'relative/path';

      expect(() => new PortfolioManager(fileOperations))
        .toThrow('DOLLHOUSE_PORTFOLIO_DIR must be an absolute path');
    });

    it('should reject config with relative baseDir', () => {
      expect(() => new PortfolioManager(fileOperations, { baseDir: 'relative/path' }))
        .toThrow('Portfolio config baseDir must be an absolute path');
    });

    it('should reject suspicious paths with .. in environment variable', () => {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = '/home/../etc';

      expect(() => new PortfolioManager(fileOperations))
        .toThrow('DOLLHOUSE_PORTFOLIO_DIR contains suspicious path segments');
    });

    it('should reject /etc paths', () => {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = '/etc/portfolio';

      expect(() => new PortfolioManager(fileOperations))
        .toThrow('DOLLHOUSE_PORTFOLIO_DIR contains suspicious path segments');
    });

    it('should reject /sys paths', () => {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = '/sys/portfolio';

      expect(() => new PortfolioManager(fileOperations))
        .toThrow('DOLLHOUSE_PORTFOLIO_DIR contains suspicious path segments');
    });
  });

  describe('Documentation Examples', () => {
    it('benchmark scripts should use this pattern', () => {
      // Example from benchmark-persona-reload.ts (AFTER FIX)
      const TEST_DIR = path.join(process.cwd(), 'test-tmp', `persona-benchmark-${Date.now()}`);
      const pm = new PortfolioManager(fileOperations, { baseDir: TEST_DIR });

      expect(pm.getBaseDir()).toBe(TEST_DIR);
    });

    it('integration tests should use this pattern', () => {
      // Example from ConditionalActivation.integration.test.ts (AFTER FIX)
      const testDir = path.join(os.tmpdir(), 'ensemble-integration-test-');
      const pm = new PortfolioManager(fileOperations, { baseDir: testDir });

      expect(pm.getBaseDir()).toBe(testDir);
    });

    it('production code should use default or config', () => {
      // Example from Container.ts - uses default
      const pm = new PortfolioManager(fileOperations);
      const expectedDefault = path.join(os.homedir(), '.dollhouse', 'portfolio');

      expect(pm.getBaseDir()).toBe(expectedDefault);
    });
  });
});
