/**
 * Unit tests for portfolioConfig module
 * Tests the configurable portfolio repository name functionality
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { getPortfolioRepositoryName, isTestEnvironment } from '../../../../src/config/portfolioConfig.js';

describe('portfolioConfig', () => {
  // Store original env vars to restore after tests
  const originalTestRepo = process.env.TEST_GITHUB_REPO;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTestMode = process.env.TEST_MODE;

  beforeEach(() => {
    // Clear the env vars before each test
    delete process.env.TEST_GITHUB_REPO;
    delete process.env.NODE_ENV;
    delete process.env.TEST_MODE;
  });

  afterEach(() => {
    // Restore original env vars after each test
    if (originalTestRepo !== undefined) {
      process.env.TEST_GITHUB_REPO = originalTestRepo;
    } else {
      delete process.env.TEST_GITHUB_REPO;
    }
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    if (originalTestMode !== undefined) {
      process.env.TEST_MODE = originalTestMode;
    } else {
      delete process.env.TEST_MODE;
    }
  });

  describe('getPortfolioRepositoryName', () => {
    it('should return TEST_GITHUB_REPO when set', () => {
      process.env.TEST_GITHUB_REPO = 'test-portfolio';
      expect(getPortfolioRepositoryName()).toBe('test-portfolio');
    });

    it('should return default when TEST_GITHUB_REPO not set', () => {
      delete process.env.TEST_GITHUB_REPO;
      expect(getPortfolioRepositoryName()).toBe('dollhouse-portfolio');
    });

    it('should handle empty string TEST_GITHUB_REPO as not set', () => {
      process.env.TEST_GITHUB_REPO = '';
      expect(getPortfolioRepositoryName()).toBe('dollhouse-portfolio');
    });

    it('should handle whitespace-only TEST_GITHUB_REPO as not set', () => {
      process.env.TEST_GITHUB_REPO = '   ';
      expect(getPortfolioRepositoryName()).toBe('dollhouse-portfolio');
    });

    it('should trim whitespace from TEST_GITHUB_REPO', () => {
      process.env.TEST_GITHUB_REPO = '  my-test-repo  ';
      expect(getPortfolioRepositoryName()).toBe('my-test-repo');
    });

    it('should handle repository names with hyphens and underscores', () => {
      process.env.TEST_GITHUB_REPO = 'test_repo-name_123';
      expect(getPortfolioRepositoryName()).toBe('test_repo-name_123');
    });

    it('should handle long repository names', () => {
      const longName = 'a'.repeat(100) + '-portfolio';
      process.env.TEST_GITHUB_REPO = longName;
      expect(getPortfolioRepositoryName()).toBe(longName);
    });
  });

  describe('isTestEnvironment', () => {
    it('should return true when TEST_GITHUB_REPO is set', () => {
      process.env.TEST_GITHUB_REPO = 'test-repo';
      expect(isTestEnvironment()).toBe(true);
    });

    it('should return false when TEST_GITHUB_REPO is not set', () => {
      delete process.env.TEST_GITHUB_REPO;
      expect(isTestEnvironment()).toBe(false);
    });

    it('should return false when TEST_GITHUB_REPO is empty string', () => {
      process.env.TEST_GITHUB_REPO = '';
      expect(isTestEnvironment()).toBe(false);
    });

    it('should return false when TEST_GITHUB_REPO is whitespace only', () => {
      process.env.TEST_GITHUB_REPO = '   ';
      expect(isTestEnvironment()).toBe(false);
    });

    it('should return true for any non-empty TEST_GITHUB_REPO value', () => {
      process.env.TEST_GITHUB_REPO = 'x';
      expect(isTestEnvironment()).toBe(true);
    });
  });

  describe('Integration with environment variables', () => {
    it('should prioritize TEST_GITHUB_REPO over future config file', () => {
      // This test documents the expected priority order
      process.env.TEST_GITHUB_REPO = 'env-repo';
      // Future: even if config file has a different value
      // the env var should take precedence
      expect(getPortfolioRepositoryName()).toBe('env-repo');
    });

    it('should be consistent across multiple calls', () => {
      process.env.TEST_GITHUB_REPO = 'consistent-repo';
      const first = getPortfolioRepositoryName();
      const second = getPortfolioRepositoryName();
      const third = getPortfolioRepositoryName();
      
      expect(first).toBe('consistent-repo');
      expect(second).toBe('consistent-repo');
      expect(third).toBe('consistent-repo');
    });

    it('should reflect changes to TEST_GITHUB_REPO', () => {
      delete process.env.TEST_GITHUB_REPO;
      expect(getPortfolioRepositoryName()).toBe('dollhouse-portfolio');
      
      process.env.TEST_GITHUB_REPO = 'new-repo';
      expect(getPortfolioRepositoryName()).toBe('new-repo');
      
      delete process.env.TEST_GITHUB_REPO;
      expect(getPortfolioRepositoryName()).toBe('dollhouse-portfolio');
    });
  });
});