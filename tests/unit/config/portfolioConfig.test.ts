/**
 * Unit tests for portfolioConfig module
 * Tests the configurable portfolio repository name functionality
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { getPortfolioRepositoryName, isTestEnvironment, validateRepositoryName } from '../../../src/config/portfolioConfig.js';

describe('portfolioConfig', () => {
  // Store original env vars to restore after tests
  const originalPortfolioRepoName = process.env.PORTFOLIO_REPOSITORY_NAME;
  const originalGithubRepo = process.env.GITHUB_REPOSITORY;
  const originalTestRepo = process.env.TEST_GITHUB_REPO;
  const originalGithubTestRepo = process.env.GITHUB_TEST_REPO;
  const originalTestPortfolioRepo = process.env.TEST_PORTFOLIO_REPO;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTestMode = process.env.TEST_MODE;

  // Mock console.warn to suppress deprecation warnings in tests
  const originalWarn = console.warn;
  const mockWarn = jest.fn();

  beforeEach(() => {
    // Clear all env vars before each test
    delete process.env.PORTFOLIO_REPOSITORY_NAME;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.TEST_GITHUB_REPO;
    delete process.env.GITHUB_TEST_REPO;
    delete process.env.TEST_PORTFOLIO_REPO;
    delete process.env.NODE_ENV;
    delete process.env.TEST_MODE;

    // Mock console.warn to suppress deprecation warnings
    console.warn = mockWarn;
    mockWarn.mockClear();
  });

  afterEach(() => {
    // Restore console.warn
    console.warn = originalWarn;

    // Restore original env vars after each test
    if (originalPortfolioRepoName !== undefined) {
      process.env.PORTFOLIO_REPOSITORY_NAME = originalPortfolioRepoName;
    } else {
      delete process.env.PORTFOLIO_REPOSITORY_NAME;
    }
    if (originalGithubRepo !== undefined) {
      process.env.GITHUB_REPOSITORY = originalGithubRepo;
    } else {
      delete process.env.GITHUB_REPOSITORY;
    }
    if (originalTestRepo !== undefined) {
      process.env.TEST_GITHUB_REPO = originalTestRepo;
    } else {
      delete process.env.TEST_GITHUB_REPO;
    }
    if (originalGithubTestRepo !== undefined) {
      process.env.GITHUB_TEST_REPO = originalGithubTestRepo;
    } else {
      delete process.env.GITHUB_TEST_REPO;
    }
    if (originalTestPortfolioRepo !== undefined) {
      process.env.TEST_PORTFOLIO_REPO = originalTestPortfolioRepo;
    } else {
      delete process.env.TEST_PORTFOLIO_REPO;
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

  describe('validateRepositoryName', () => {
    describe('valid repository names', () => {
      it('should accept valid repository name with hyphens', () => {
        expect(validateRepositoryName('dollhouse-portfolio')).toBe('dollhouse-portfolio');
      });

      it('should accept valid repository name with underscores', () => {
        expect(validateRepositoryName('my_portfolio')).toBe('my_portfolio');
      });

      it('should accept valid repository name with dots', () => {
        expect(validateRepositoryName('repo.test')).toBe('repo.test');
      });

      it('should accept valid repository name with mixed valid characters', () => {
        expect(validateRepositoryName('test_repo-name.v2')).toBe('test_repo-name.v2');
      });

      it('should accept alphanumeric repository names', () => {
        expect(validateRepositoryName('repo123')).toBe('repo123');
      });

      it('should trim whitespace from valid names', () => {
        expect(validateRepositoryName('  my-repo  ')).toBe('my-repo');
      });

      it('should accept long repository names', () => {
        const longName = 'a'.repeat(100) + '-portfolio';
        expect(validateRepositoryName(longName)).toBe(longName);
      });
    });

    describe('invalid repository names', () => {
      it('should reject empty string', () => {
        expect(() => validateRepositoryName('')).toThrow('Repository name cannot be empty');
      });

      it('should reject undefined', () => {
        expect(() => validateRepositoryName(undefined)).toThrow('Repository name cannot be empty');
      });

      it('should reject whitespace-only string', () => {
        expect(() => validateRepositoryName('   ')).toThrow('Repository name cannot be empty');
      });

      it('should reject names with slash character', () => {
        expect(() => validateRepositoryName('owner/repo')).toThrow(
          "Repository name cannot contain '/' character"
        );
      });

      it('should reject names with @ character', () => {
        expect(() => validateRepositoryName('repo@name')).toThrow(
          'Repository name contains invalid characters'
        );
      });

      it('should reject names with spaces', () => {
        expect(() => validateRepositoryName('my repo')).toThrow(
          'Repository name contains invalid characters'
        );
      });

      it('should reject names with special characters', () => {
        expect(() => validateRepositoryName('repo$name')).toThrow(
          'Repository name contains invalid characters'
        );
      });

      it('should provide helpful error for slash (GitHub Actions format)', () => {
        expect(() => validateRepositoryName('myorg/myrepo')).toThrow(
          'PORTFOLIO_REPOSITORY_NAME=dollhouse-portfolio'
        );
      });
    });
  });

  describe('getPortfolioRepositoryName', () => {
    describe('PORTFOLIO_REPOSITORY_NAME (preferred)', () => {
      it('should return PORTFOLIO_REPOSITORY_NAME when set', () => {
        process.env.PORTFOLIO_REPOSITORY_NAME = 'my-portfolio';
        expect(getPortfolioRepositoryName()).toBe('my-portfolio');
      });

      it('should trim whitespace from PORTFOLIO_REPOSITORY_NAME', () => {
        process.env.PORTFOLIO_REPOSITORY_NAME = '  my-portfolio  ';
        expect(getPortfolioRepositoryName()).toBe('my-portfolio');
      });

      it('should validate PORTFOLIO_REPOSITORY_NAME', () => {
        process.env.PORTFOLIO_REPOSITORY_NAME = 'owner/repo';
        expect(() => getPortfolioRepositoryName()).toThrow(
          "Repository name cannot contain '/'"
        );
      });

      it('should prioritize PORTFOLIO_REPOSITORY_NAME over GITHUB_REPOSITORY', () => {
        process.env.PORTFOLIO_REPOSITORY_NAME = 'preferred-repo';
        process.env.GITHUB_REPOSITORY = 'legacy-repo';
        expect(getPortfolioRepositoryName()).toBe('preferred-repo');
        expect(mockWarn).not.toHaveBeenCalled(); // No deprecation warning
      });

      it('should not show deprecation warning for PORTFOLIO_REPOSITORY_NAME', () => {
        process.env.PORTFOLIO_REPOSITORY_NAME = 'my-portfolio';
        getPortfolioRepositoryName();
        expect(mockWarn).not.toHaveBeenCalled();
      });
    });

    describe('GITHUB_REPOSITORY (legacy, deprecated)', () => {
      it('should return GITHUB_REPOSITORY when PORTFOLIO_REPOSITORY_NAME not set', () => {
        process.env.GITHUB_REPOSITORY = 'legacy-portfolio';
        expect(getPortfolioRepositoryName()).toBe('legacy-portfolio');
      });

      it('should show deprecation warning when using GITHUB_REPOSITORY', () => {
        process.env.GITHUB_REPOSITORY = 'legacy-portfolio';
        getPortfolioRepositoryName();
        expect(mockWarn).toHaveBeenCalledWith(
          expect.stringContaining('DEPRECATED: Using GITHUB_REPOSITORY for portfolio configuration')
        );
        expect(mockWarn).toHaveBeenCalledWith(
          expect.stringContaining('PORTFOLIO_REPOSITORY_NAME')
        );
      });

      it('should skip GITHUB_REPOSITORY with slash and fall through to default', () => {
        process.env.GITHUB_REPOSITORY = 'owner/repo';
        // Should not throw — falls through to default 'dollhouse-portfolio'
        expect(getPortfolioRepositoryName()).toBe('dollhouse-portfolio');
      });

      it('should skip GITHUB_REPOSITORY in GitHub Actions format and use default', () => {
        process.env.GITHUB_REPOSITORY = 'myorg/myrepo';
        // Should silently ignore the owner/repo format and return default
        expect(getPortfolioRepositoryName()).toBe('dollhouse-portfolio');
      });

      it('should trim whitespace from GITHUB_REPOSITORY', () => {
        process.env.GITHUB_REPOSITORY = '  legacy-repo  ';
        expect(getPortfolioRepositoryName()).toBe('legacy-repo');
      });

      it('should validate GITHUB_REPOSITORY when it does not contain slash', () => {
        process.env.GITHUB_REPOSITORY = 'repo@invalid';
        expect(() => getPortfolioRepositoryName()).toThrow(
          'Repository name contains invalid characters'
        );
      });
    });

    describe('backward compatibility (deprecated variables)', () => {
      it('should return TEST_GITHUB_REPO when newer vars not set', () => {
        process.env.TEST_GITHUB_REPO = 'test-portfolio';
        expect(getPortfolioRepositoryName()).toBe('test-portfolio');
        expect(mockWarn).toHaveBeenCalledWith(
          expect.stringContaining('DEPRECATED: TEST_GITHUB_REPO')
        );
      });

      it('should return GITHUB_TEST_REPO when newer vars not set', () => {
        process.env.GITHUB_TEST_REPO = 'test-repo';
        expect(getPortfolioRepositoryName()).toBe('test-repo');
        expect(mockWarn).toHaveBeenCalledWith(
          expect.stringContaining('DEPRECATED: GITHUB_TEST_REPO')
        );
      });

      it('should return TEST_PORTFOLIO_REPO when newer vars not set', () => {
        process.env.TEST_PORTFOLIO_REPO = 'portfolio-test';
        expect(getPortfolioRepositoryName()).toBe('portfolio-test');
        expect(mockWarn).toHaveBeenCalledWith(
          expect.stringContaining('DEPRECATED: TEST_PORTFOLIO_REPO')
        );
      });

      it('should prioritize TEST_GITHUB_REPO over GITHUB_TEST_REPO', () => {
        process.env.TEST_GITHUB_REPO = 'priority-repo';
        process.env.GITHUB_TEST_REPO = 'lower-priority';
        expect(getPortfolioRepositoryName()).toBe('priority-repo');
      });

      it('should validate deprecated variables', () => {
        process.env.TEST_GITHUB_REPO = 'owner/repo';
        expect(() => getPortfolioRepositoryName()).toThrow(
          "Repository name cannot contain '/'"
        );
      });

      it('should handle empty string for deprecated vars', () => {
        process.env.TEST_GITHUB_REPO = '';
        expect(getPortfolioRepositoryName()).toBe('dollhouse-portfolio');
      });

      it('should handle whitespace-only for deprecated vars', () => {
        process.env.TEST_GITHUB_REPO = '   ';
        expect(getPortfolioRepositoryName()).toBe('dollhouse-portfolio');
      });

      it('should trim whitespace from deprecated vars', () => {
        process.env.TEST_GITHUB_REPO = '  my-test-repo  ';
        expect(getPortfolioRepositoryName()).toBe('my-test-repo');
      });
    });

    describe('default behavior', () => {
      it('should return default when no env vars set', () => {
        expect(getPortfolioRepositoryName()).toBe('dollhouse-portfolio');
      });

      it('should not log warnings when using default', () => {
        getPortfolioRepositoryName();
        expect(mockWarn).not.toHaveBeenCalled();
      });
    });

    describe('priority order', () => {
      it('should prioritize in correct order: PORTFOLIO_REPOSITORY_NAME > GITHUB_REPOSITORY > deprecated', () => {
        process.env.PORTFOLIO_REPOSITORY_NAME = 'priority-1';
        process.env.GITHUB_REPOSITORY = 'priority-2';
        process.env.TEST_GITHUB_REPO = 'priority-3';
        expect(getPortfolioRepositoryName()).toBe('priority-1');
      });

      it('should use GITHUB_REPOSITORY when PORTFOLIO_REPOSITORY_NAME not set', () => {
        process.env.GITHUB_REPOSITORY = 'priority-2';
        process.env.TEST_GITHUB_REPO = 'priority-3';
        expect(getPortfolioRepositoryName()).toBe('priority-2');
      });

      it('should use TEST_GITHUB_REPO when modern vars not set', () => {
        process.env.TEST_GITHUB_REPO = 'priority-3';
        process.env.GITHUB_TEST_REPO = 'priority-4';
        expect(getPortfolioRepositoryName()).toBe('priority-3');
      });
    });

    describe('integration with environment variables', () => {
      it('should be consistent across multiple calls', () => {
        process.env.PORTFOLIO_REPOSITORY_NAME = 'consistent-repo';
        const first = getPortfolioRepositoryName();
        const second = getPortfolioRepositoryName();
        const third = getPortfolioRepositoryName();

        expect(first).toBe('consistent-repo');
        expect(second).toBe('consistent-repo');
        expect(third).toBe('consistent-repo');
      });

      it('should reflect changes to PORTFOLIO_REPOSITORY_NAME', () => {
        delete process.env.PORTFOLIO_REPOSITORY_NAME;
        expect(getPortfolioRepositoryName()).toBe('dollhouse-portfolio');

        process.env.PORTFOLIO_REPOSITORY_NAME = 'new-repo';
        expect(getPortfolioRepositoryName()).toBe('new-repo');

        delete process.env.PORTFOLIO_REPOSITORY_NAME;
        expect(getPortfolioRepositoryName()).toBe('dollhouse-portfolio');
      });

      it('should handle repository names with hyphens and underscores', () => {
        process.env.PORTFOLIO_REPOSITORY_NAME = 'test_repo-name_123';
        expect(getPortfolioRepositoryName()).toBe('test_repo-name_123');
      });

      it('should handle long repository names', () => {
        const longName = 'a'.repeat(100) + '-portfolio';
        process.env.PORTFOLIO_REPOSITORY_NAME = longName;
        expect(getPortfolioRepositoryName()).toBe(longName);
      });
    });
  });

  describe('isTestEnvironment', () => {
    it('should return true when TEST_MODE is "true"', () => {
      process.env.TEST_MODE = 'true';
      expect(isTestEnvironment()).toBe(true);
    });

    it('should return true when NODE_ENV is "test"', () => {
      process.env.NODE_ENV = 'test';
      expect(isTestEnvironment()).toBe(true);
    });

    it('should return true when TEST_GITHUB_REPO is set', () => {
      process.env.TEST_GITHUB_REPO = 'test-repo';
      expect(isTestEnvironment()).toBe(true);
    });

    it('should return false when TEST_GITHUB_REPO is not set', () => {
      delete process.env.TEST_GITHUB_REPO;
      delete process.env.TEST_MODE;
      delete process.env.GITHUB_TEST_TOKEN;
      const originalNodeEnv = process.env.NODE_ENV;
      delete process.env.NODE_ENV;
      expect(isTestEnvironment()).toBe(false);
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('should return false when TEST_GITHUB_REPO is empty string', () => {
      process.env.TEST_GITHUB_REPO = '';
      delete process.env.TEST_MODE;
      delete process.env.GITHUB_TEST_TOKEN;
      const originalNodeEnv = process.env.NODE_ENV;
      delete process.env.NODE_ENV;
      expect(isTestEnvironment()).toBe(false);
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('should return false when TEST_GITHUB_REPO is whitespace only', () => {
      process.env.TEST_GITHUB_REPO = '   ';
      delete process.env.TEST_MODE;
      delete process.env.GITHUB_TEST_TOKEN;
      const originalNodeEnv = process.env.NODE_ENV;
      delete process.env.NODE_ENV;
      expect(isTestEnvironment()).toBe(false);
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('should return true for any non-empty TEST_GITHUB_REPO value', () => {
      process.env.TEST_GITHUB_REPO = 'x';
      expect(isTestEnvironment()).toBe(true);
    });
  });
});
