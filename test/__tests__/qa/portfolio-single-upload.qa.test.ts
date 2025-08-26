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
      const mockFetch = jest.fn<typeof fetch>();
      global.fetch = mockFetch as any;

      // Mock checking if file exists (returns null for new file)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => null
      } as Response);

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
      } as Response);

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
      
      const mockFetch = jest.fn<typeof fetch>();
      global.fetch = mockFetch as any;

      // Mock checking if file exists
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => null
      } as Response);

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
      } as Response);

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
      
      const mockFetch = jest.fn<typeof fetch>();
      global.fetch = mockFetch as any;

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => null
      } as Response);

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
      } as Response);

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
      
      const mockFetch = jest.fn<typeof fetch>();
      global.fetch = mockFetch as any;

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => null
      } as Response);

      // Response with no useful data at all
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          // Completely unexpected structure
          someField: 'value'
        })
      } as Response);

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

  describe('Single Element Upload Behavior', () => {
    it('should upload only one element, not trigger bulk sync', async () => {
      portfolioManager.setToken('ghp_test_token');
      
      const mockFetch = jest.fn<typeof fetch>();
      global.fetch = mockFetch as any;
      
      // Track all API calls
      const apiCalls: string[] = [];
      mockFetch.mockImplementation(async (url: RequestInfo | URL, options?: RequestInit) => {
        const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
        apiCalls.push(`${options?.method || 'GET'} ${urlString}`);
        
        if (options?.method === 'PUT') {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              content: { 
                path: 'personas/ziggy.md',
                html_url: 'https://github.com/testuser/dollhouse-portfolio/blob/main/personas/ziggy.md'
              },
              commit: { 
                html_url: 'https://github.com/testuser/dollhouse-portfolio/commit/abc' 
              }
            })
          } as Response;
        }
        return { ok: false, status: 404, json: async () => null } as Response;
      });

      const ziggyElement = {
        id: 'ziggy_element',
        type: 'personas' as any,
        version: '1.0.0',
        metadata: {
          name: 'Ziggy',
          description: 'Quantum Leap AI',
          author: 'testuser'
        },
        validate: () => ({ isValid: true, errors: [] }),
        serialize: () => '# Ziggy\nYou are Ziggy from Quantum Leap.'
      };

      // Upload single element
      await portfolioManager.saveElement(ziggyElement, true);
      
      // Verify only ONE PUT request (single upload)
      const putRequests = apiCalls.filter(call => call.startsWith('PUT'));
      expect(putRequests).toHaveLength(1);
      expect(putRequests[0]).toContain('personas/ziggy.md');
      
      // Verify we didn't scan for other elements (no bulk sync behavior)
      // In bulk sync, we'd see multiple GET requests for different element types
      const getRequests = apiCalls.filter(call => call.startsWith('GET'));
      expect(getRequests.length).toBeLessThanOrEqual(1); // Only checking if file exists
    });

    it('simulates real user flow: upload Ziggy persona to personal GitHub portfolio', async () => {
      portfolioManager.setToken('ghp_test_token');
      
      const mockFetch = jest.fn<typeof fetch>();
      global.fetch = mockFetch as any;
      
      // User has multiple personas locally
      const localPersonas = [
        { name: 'Ziggy', private: false },
        { name: 'Private Work Assistant', private: true },
        { name: 'Family Helper', private: true }
      ];
      
      // Track what gets uploaded
      const uploadedElements: string[] = [];
      
      mockFetch.mockImplementation(async (url: RequestInfo | URL, options?: RequestInit) => {
        if (options?.method === 'PUT') {
          const body = JSON.parse(options.body);
          const content = Buffer.from(body.content, 'base64').toString();
          uploadedElements.push(content);
          
          return {
            ok: true,
            status: 201,
            json: async () => ({
              content: { 
                path: 'personas/ziggy.md',
                html_url: 'https://github.com/testuser/dollhouse-portfolio/blob/main/personas/ziggy.md'
              },
              commit: { 
                html_url: 'https://github.com/testuser/dollhouse-portfolio/commit/abc' 
              }
            })
          } as Response;
        }
        return { ok: false, status: 404, json: async () => null } as Response;
      });

      // User action: Upload ONLY Ziggy
      const ziggyElement = {
        id: 'ziggy_quantum_leap',
        type: 'personas' as any,
        version: '1.0.0',
        metadata: {
          name: 'Ziggy',
          description: 'A matter-of-fact, snarky AI assistant persona based on Quantum Leap',
          author: 'testuser'
        },
        validate: () => ({ isValid: true, errors: [] }),
        serialize: () => `---
name: Ziggy
description: A matter-of-fact, snarky AI assistant persona based on Quantum Leap
---

# Ziggy - Quantum Leap Supercomputer Persona

You are Ziggy, a sophisticated hybrid supercomputer with a massive ego.`
      };

      const result = await portfolioManager.saveElement(ziggyElement, true);
      
      // Verify success
      expect(result).toContain('github.com/testuser/dollhouse-portfolio');
      
      // CRITICAL: Verify only Ziggy was uploaded
      expect(uploadedElements).toHaveLength(1);
      expect(uploadedElements[0]).toContain('Ziggy');
      expect(uploadedElements[0]).toContain('Quantum Leap');
      
      // Verify private personas were NOT uploaded
      expect(uploadedElements[0]).not.toContain('Private Work');
      expect(uploadedElements[0]).not.toContain('Family Helper');
    });
  });

  describe('Error Code Reporting', () => {
    it('should return PORTFOLIO_SYNC_001 for authentication errors', async () => {
      portfolioManager.setToken('bad_token');
      
      const mockFetch = jest.fn<typeof fetch>();
      global.fetch = mockFetch as any;

      // Mock 401 authentication error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({
          message: 'Bad credentials'
        })
      } as Response);

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
      
      const mockFetch = jest.fn<typeof fetch>();
      global.fetch = mockFetch as any;

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => null
      } as Response);

      // Mock 403 rate limit error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({
          message: 'API rate limit exceeded'
        })
      } as Response);

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