/**
 * QA Test: Portfolio Single Element Upload
 * 
 * This test verifies that the submit_content tool correctly uploads a single
 * element to the user's GitHub portfolio without syncing everything.
 * 
 * Based on QA report: docs/QA/QA-version-1-6-5-save-to-github-portfolio-failure.md
 */

import { jest } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PortfolioRepoManager } from '../../../src/portfolio/PortfolioRepoManager.js';

// We'll test PortfolioRepoManager directly since that's where the fix is
describe('Portfolio Single Element Upload - GitHub API Response Fix', () => {
  let portfolioManager: PortfolioRepoManager;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    portfolioManager = new PortfolioRepoManager();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  describe('GitHub API Response Handling', () => {
    it('should handle response with commit.html_url (standard case)', async () => {
      // Mock the token
      portfolioManager.setToken('ghp_test_token');
      
      // Mock fetch for GitHub API
      const mockFetch = jest.fn();
      global.fetch = mockFetch as any;

      // Mock checking if file exists (returns null for new file)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => null
      });

      // Mock successful file creation with standard response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          content: {
            path: 'personas/test.md',
            html_url: 'https://github.com/test/portfolio/blob/main/personas/test.md'
          },
          commit: {
            sha: 'abc123',
            html_url: 'https://github.com/test/portfolio/commit/abc123'
          }
        })
      });

      // Create a test element
      const testElement = {
        id: 'test_element',
        type: 'personas' as any,
        version: '1.0.0',
        metadata: {
          name: 'Test Persona',
          description: 'Test',
          author: 'testuser'
        },
        validate: () => ({ isValid: true, errors: [] }),
        serialize: () => 'test content'
      };

      // This should work and return the commit URL
      const result = await portfolioManager.saveElement(testElement, true);
      expect(result).toBe('https://github.com/test/portfolio/commit/abc123');
    });

    it('should handle response with null commit (the bug from QA report)', async () => {
      portfolioManager.setToken('ghp_test_token');
      
      const mockFetch = jest.fn();
      global.fetch = mockFetch as any;

      // Mock checking if file exists
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => null
      });

      // Mock the problematic response that caused the original error
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          content: {
            path: 'personas/test.md',
            html_url: 'https://github.com/test/portfolio/blob/main/personas/test.md'
          },
          commit: null  // THIS is what caused the error!
        })
      });

      const testElement = {
        id: 'test_element',
        type: 'personas' as any,
        version: '1.0.0',
        metadata: {
          name: 'Test Persona',
          description: 'Test',
          author: 'testuser'
        },
        validate: () => ({ isValid: true, errors: [] }),
        serialize: () => 'test content'
      };

      // With our fix, this should NOT throw and should use fallback
      const result = await portfolioManager.saveElement(testElement, true);
      
      // Should return the content URL as fallback
      expect(result).toBe('https://github.com/test/portfolio/blob/main/personas/test.md');
    });

    it('should use fallback URL when no commit or content URLs available', async () => {
      portfolioManager.setToken('ghp_test_token');
      
      const mockFetch = jest.fn();
      global.fetch = mockFetch as any;

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => null
      });

      // Minimal response with no URLs
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          content: {
            path: 'personas/test.md'
            // No html_url
          }
          // No commit at all
        })
      });

      const testElement = {
        id: 'test_element',
        type: 'personas' as any,
        version: '1.0.0',
        metadata: {
          name: 'Test Persona',
          description: 'Test',
          author: 'testuser'
        },
        validate: () => ({ isValid: true, errors: [] }),
        serialize: () => 'test content'
      };

      const result = await portfolioManager.saveElement(testElement, true);
      
      // Should generate URL from path using the username from element
      expect(result).toBe('https://github.com/testuser/dollhouse-portfolio/blob/main/personas/test.md');
    });

    it('should use ultimate fallback when response has no useful data', async () => {
      portfolioManager.setToken('ghp_test_token');
      
      const mockFetch = jest.fn();
      global.fetch = mockFetch as any;

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => null
      });

      // Response with no useful data at all
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          // Completely unexpected structure
          someField: 'value'
        })
      });

      const testElement = {
        id: 'test_element',
        type: 'skills' as any,  // Different type for variety
        version: '1.0.0',
        metadata: {
          name: 'Test Skill',
          description: 'Test',
          author: 'testuser'
        },
        validate: () => ({ isValid: true, errors: [] }),
        serialize: () => 'test content'
      };

      const result = await portfolioManager.saveElement(testElement, true);
      
      // Should use ultimate fallback pointing to element type directory
      expect(result).toBe('https://github.com/testuser/dollhouse-portfolio/tree/main/skills');
    });
  });

  describe('Error Code Reporting', () => {
    it('should return PORTFOLIO_SYNC_001 for authentication errors', async () => {
      portfolioManager.setToken('bad_token');
      
      const mockFetch = jest.fn();
      global.fetch = mockFetch as any;

      // Mock 401 authentication error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({
          message: 'Bad credentials'
        })
      });

      const testElement = {
        id: 'test_element',
        type: 'personas' as any,
        version: '1.0.0',
        metadata: {
          name: 'Test',
          description: 'Test',
          author: 'testuser'
        },
        validate: () => ({ isValid: true, errors: [] }),
        serialize: () => 'test content'
      };

      await expect(portfolioManager.saveElement(testElement, true))
        .rejects
        .toThrow('[PORTFOLIO_SYNC_001]');
    });

    it('should return PORTFOLIO_SYNC_006 for rate limit errors', async () => {
      portfolioManager.setToken('ghp_test_token');
      
      const mockFetch = jest.fn();
      global.fetch = mockFetch as any;

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => null
      });

      // Mock 403 rate limit error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({
          message: 'API rate limit exceeded'
        })
      });

      const testElement = {
        id: 'test_element',
        type: 'personas' as any,
        version: '1.0.0',
        metadata: {
          name: 'Test',
          description: 'Test',
          author: 'testuser'
        },
        validate: () => ({ isValid: true, errors: [] }),
        serialize: () => 'test content'
      };

      await expect(portfolioManager.saveElement(testElement, true))
        .rejects
        .toThrow('[PORTFOLIO_SYNC_006]');
    });
  });
});