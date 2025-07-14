/**
 * Unit tests for PersonaSharer
 */

import { PersonaSharer } from '../../../src/persona/export-import/PersonaSharer.js';
import { PersonaExporter } from '../../../src/persona/export-import/PersonaExporter.js';
import { TokenManager } from '../../../src/security/tokenManager.js';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Mock dependencies
jest.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn()
  }
}));

// Mock fetch
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

// Mock GitHubClient
const mockGitHubClient = {
  searchPersonas: jest.fn(),
  getPersona: jest.fn(),
  listPersonas: jest.fn()
};

describe('PersonaSharer', () => {
  let sharer: PersonaSharer;
  let exporter: PersonaExporter;
  const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    exporter = new PersonaExporter('test-user');
    sharer = new PersonaSharer(mockGitHubClient as any, 'test-user');
    jest.clearAllMocks();
    
    // Clear environment variables
    delete process.env.GITHUB_TOKEN;
    
    // Reset rate limiter to prevent test interference
    TokenManager.resetTokenValidationLimiter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Clean up rate limiter
    TokenManager.resetTokenValidationLimiter();
  });

  describe('sharePersona', () => {
    const mockPersona = {
      metadata: {
        name: 'Test Persona',
        description: 'A test persona',
        version: '1.0.0'
      },
      content: 'Test content',
      filename: 'test-persona.md',
      unique_id: 'test-persona_20250111-100000_test'
    };

    it('should create a GitHub gist when token is available', async () => {
      // Use a valid GitHub token format
      process.env.GITHUB_TOKEN = 'ghp_1234567890123456789012345678901234567890';
      
      // Mock token validation API call (TokenManager checks permissions)
      const mockTokenValidation = {
        ok: true,
        headers: {
          get: jest.fn().mockImplementation((header: unknown) => {
            const headerStr = header as string;
            switch (headerStr) {
              case 'x-oauth-scopes': return 'gist,repo,user:email';
              case 'x-ratelimit-remaining': return '100';
              case 'x-ratelimit-reset': return '1640995200';
              default: return null;
            }
          })
        }
      };
      
      const mockGistResponse = {
        ok: true,
        json: () => Promise.resolve({
          id: 'test-gist-id',
          html_url: 'https://gist.github.com/test-gist-id'
        })
      };
      
      // First call is for token validation, second is for gist creation
      mockFetch
        .mockResolvedValueOnce(mockTokenValidation as any)
        .mockResolvedValueOnce(mockGistResponse as any);

      const result = await sharer.sharePersona(mockPersona, 7);

      expect(result.success).toBe(true);
      expect(result.url).toBe('https://gist.github.com/test-gist-id');
      expect(result.gistId).toBe('test-gist-id');
      
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/gists',
        expect.objectContaining({
          method: 'POST',
          signal: expect.any(AbortSignal),
          headers: expect.objectContaining({
            'Authorization': 'Bearer ghp_1234567890123456789012345678901234567890',
            'Content-Type': 'application/json'
          })
        })
      );
    });

    it('should fall back to base64 URL when no GitHub token', async () => {
      const result = await sharer.sharePersona(mockPersona, 7);

      expect(result.success).toBe(true);
      expect(result.url).toContain('https://dollhousemcp.com/import#dollhouse-persona=');
      expect(result.gistId).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle GitHub API errors gracefully', async () => {
      process.env.GITHUB_TOKEN = 'ghp_1234567890123456789012345678901234567890';
      
      // Mock token validation API call first
      const mockTokenValidation = {
        ok: true,
        headers: {
          get: jest.fn().mockImplementation((header: unknown) => {
            const headerStr = header as string;
            switch (headerStr) {
              case 'x-oauth-scopes': return 'gist,repo,user:email';
              case 'x-ratelimit-remaining': return '100';
              case 'x-ratelimit-reset': return '1640995200';
              default: return null;
            }
          })
        }
      };
      
      const mockErrorResponse = {
        ok: false,
        statusText: 'Unauthorized'
      };
      
      mockFetch
        .mockResolvedValueOnce(mockTokenValidation as any)
        .mockResolvedValueOnce(mockErrorResponse as any);

      const result = await sharer.sharePersona(mockPersona, 7);

      expect(result.success).toBe(true);
      expect(result.url).toContain('https://dollhousemcp.com/import#dollhouse-persona=');
      expect(result.gistId).toBeUndefined();
    });

    it('should include expiry date in shared data', async () => {
      const result = await sharer.sharePersona(mockPersona, 7);

      expect(result.success).toBe(true);
      expect(result.expiresAt).toBeDefined();
      
      const expiryDate = new Date(result.expiresAt!);
      const expectedExpiry = new Date();
      expectedExpiry.setDate(expectedExpiry.getDate() + 7);
      
      // Check dates are close (within 1 minute)
      const diff = Math.abs(expiryDate.getTime() - expectedExpiry.getTime());
      expect(diff).toBeLessThan(60000);
    });

    it('should handle fetch timeout', async () => {
      process.env.GITHUB_TOKEN = 'ghp_1234567890123456789012345678901234567890';
      
      // Mock token validation API call first
      const mockTokenValidation = {
        ok: true,
        headers: {
          get: jest.fn().mockImplementation((header: unknown) => {
            const headerStr = header as string;
            switch (headerStr) {
              case 'x-oauth-scopes': return 'gist,repo,user:email';
              case 'x-ratelimit-remaining': return '100';
              case 'x-ratelimit-reset': return '1640995200';
              default: return null;
            }
          })
        }
      };
      
      // Mock fetch to reject with abort error after token validation
      mockFetch
        .mockResolvedValueOnce(mockTokenValidation as any)
        .mockRejectedValueOnce(new Error('The operation was aborted'));

      const result = await sharer.sharePersona(mockPersona, 7);
      
      expect(result.success).toBe(true);
      expect(result.url).toContain('https://dollhousemcp.com/import#dollhouse-persona='); // Should fall back
    }, 15000);
  });

  describe('importFromUrl', () => {
    it('should import from GitHub gist URL', async () => {
      const mockGistData = {
        files: {
          'persona.json': {
            content: JSON.stringify({
              metadata: { name: 'Test' },
              content: 'Test content'
            })
          }
        }
      };
      
      const mockResponse = {
        ok: true,
        json: () => Promise.resolve(mockGistData)
      };
      
      mockFetch.mockResolvedValueOnce(mockResponse as any);

      const result = await sharer.importFromUrl('https://gist.github.com/testuser/abcdef123456');

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.message).toContain('Successfully retrieved persona');
      
      // Verify correct API URL was called
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/gists/abcdef123456',
        expect.any(Object)
      );
    });

    it('should import from base64 URL', async () => {
      const personaData = {
        metadata: { name: 'Test' },
        content: 'Test content'
      };
      
      const base64 = Buffer.from(JSON.stringify(personaData)).toString('base64');
      const url = `https://dollhousemcp.com/import#dollhouse-persona=${base64}`;

      const result = await sharer.importFromUrl(url);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(personaData);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should reject malicious URLs', async () => {
      const maliciousUrls = [
        'http://localhost/persona.json',
        'http://127.0.0.1/persona.json',
        'http://192.168.1.1/persona.json',
        'http://10.0.0.1/persona.json',
        'file:///etc/passwd',
        'ftp://example.com/persona.json'
      ];

      for (const url of maliciousUrls) {
        const result = await sharer.importFromUrl(url);
        expect(result.success).toBe(false);
        expect(result.message).toContain('Invalid or unsafe URL');
      }
    });

    it('should validate base64 URL format', async () => {
      const invalidUrl = 'https://dollhousemcp.com/import#dollhouse-persona=<script>alert(1)</script>';
      
      const result = await sharer.importFromUrl(invalidUrl);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid share URL format');
    });

    it('should handle expired gist shares', async () => {
      const expiredPersonaData = {
        metadata: { name: 'Test' },
        content: 'Test content',
        expiresAt: new Date(Date.now() - 86400000).toISOString() // Expired yesterday
      };
      
      const expiredData = {
        files: {
          'persona.json': {
            content: JSON.stringify(expiredPersonaData)
          }
        }
      };
      
      const mockResponse = {
        ok: true,
        json: () => Promise.resolve(expiredData)
      };
      
      mockFetch.mockResolvedValueOnce(mockResponse as any);

      const result = await sharer.importFromUrl('https://gist.github.com/testuser/abcdef123456');

      expect(result.success).toBe(false);
      expect(result.message).toContain('expired');
    });

    it('should handle fetch timeouts', async () => {
      // Mock fetch to reject with abort error
      mockFetch.mockRejectedValueOnce(new Error('The operation was aborted'));

      const result = await sharer.importFromUrl('https://example.com/persona.json');
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to import');
    }, 15000);

    it('should parse JSON from direct URL', async () => {
      const personaData = {
        metadata: { name: 'Test' },
        content: 'Test content'
      };
      
      const mockResponse = {
        ok: true,
        json: () => Promise.resolve(personaData)
      };
      
      mockFetch.mockResolvedValueOnce(mockResponse as any);

      const result = await sharer.importFromUrl('https://example.com/persona.json');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(personaData);
    });

    it('should handle GitHub API errors', async () => {
      const mockResponse = {
        ok: false,
        statusText: 'Not Found'
      };
      
      mockFetch.mockResolvedValueOnce(mockResponse as any);

      const result = await sharer.importFromUrl('https://gist.github.com/testuser/invalidgist123');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to import from URL');
    });

    it('should validate gist has persona data', async () => {
      const mockGistData = {
        files: {
          'readme.md': { content: 'Not a persona' }
        }
      };
      
      const mockResponse = {
        ok: true,
        json: () => Promise.resolve(mockGistData)
      };
      
      mockFetch.mockResolvedValueOnce(mockResponse as any);

      const result = await sharer.importFromUrl('https://gist.github.com/testuser/abcdef123456');

      expect(result.success).toBe(false);
      expect(result.message).toContain('No persona data found');
    });
  });

  describe('URL validation', () => {
    it('should accept valid URLs', async () => {
      const validUrls = [
        'https://example.com/persona.json',
        'https://gist.github.com/test-id',
        'http://example.com/data.json',
        'https://api.github.com/gists/123'
      ];

      for (const url of validUrls) {
        const mockResponse = {
          ok: true,
          json: () => Promise.resolve({ metadata: {}, content: '' })
        };
        
        mockFetch.mockResolvedValueOnce(mockResponse as any);
        
        const result = await sharer.importFromUrl(url);
        expect(result.success).toBe(true);
      }
    });

    it('should reject private IP ranges', async () => {
      const privateIPs = [
        'http://10.0.0.1/test',
        'http://172.16.0.1/test',
        'http://192.168.0.1/test',
        'http://169.254.0.1/test',
        'http://0.0.0.0/test',
        'http://[::1]/test', // IPv6 localhost
        'http://[::]test' // IPv6 with colon
      ];

      for (const url of privateIPs) {
        const result = await sharer.importFromUrl(url);
        expect(result.success).toBe(false);
        expect(result.message).toContain('Invalid or unsafe URL');
      }
    });

    it('should reject non-HTTP protocols', async () => {
      const invalidProtocols = [
        'file:///etc/passwd',
        'ftp://example.com/test',
        'data:text/plain,test',
        'javascript:alert(1)',
        'chrome://settings'
      ];

      for (const url of invalidProtocols) {
        const result = await sharer.importFromUrl(url);
        expect(result.success).toBe(false);
      }
    });
  });

  describe('ReDoS protection', () => {
    it('should not hang on malicious base64 URL patterns', () => {
      const maliciousPatterns = [
        '#dollhouse-persona=' + 'a'.repeat(10000),
        '#dollhouse-persona=' + 'a'.repeat(100000) + '!',
        '#dollhouse-persona=' + '='.repeat(10000)
      ];

      for (const pattern of maliciousPatterns) {
        const url = `https://dollhousemcp.com/import${pattern}`;
        const start = Date.now();
        
        sharer.importFromUrl(url);
        
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(100); // Should complete quickly
      }
    });
  });

  describe('Rate limiting', () => {
    it('should enforce rate limits on GitHub API calls', async () => {
      process.env.GITHUB_TOKEN = 'ghp_1234567890123456789012345678901234567890';
      
      // Create a new sharer with low rate limit for testing
      const testSharer = new PersonaSharer(mockGitHubClient as any, 'test-user');
      
      // Mock token validation for all the API calls
      const mockTokenValidation = {
        ok: true,
        headers: {
          get: jest.fn().mockImplementation((header: unknown) => {
            const headerStr = header as string;
            switch (headerStr) {
              case 'x-oauth-scopes': return 'gist,repo,user:email';
              case 'x-ratelimit-remaining': return '100';
              case 'x-ratelimit-reset': return '1640995200';
              default: return null;
            }
          })
        }
      };
      
      // Mock successful responses
      const mockResponse = {
        ok: true,
        json: () => Promise.resolve({ id: 'test-id', html_url: 'https://gist.github.com/test-id' })
      };
      
      // Set up mocks for all requests - token validation happens once, then 35 gist requests
      mockFetch.mockResolvedValueOnce(mockTokenValidation as any); // First token validation
      for (let i = 0; i < 35; i++) {
        mockFetch.mockResolvedValueOnce(mockResponse as any); // Gist creation
      }
      
      // Make many requests quickly to trigger rate limit
      const promises: Promise<any>[] = [];
      for (let i = 0; i < 35; i++) {
        promises.push(testSharer.sharePersona({
          metadata: {
            name: 'Test Persona',
            description: 'A test persona',
            version: '1.0.0'
          },
          content: 'Test content',
          filename: 'test-persona.md',
          unique_id: 'test-persona_20250111-100000_test'
        }, 7));
      }
      
      const results = await Promise.all(promises);
      
      // Some should succeed, some should be rate limited or fall back
      const successful = results.filter(r => r.success && r.url?.includes('github'));
      const fallback = results.filter(r => r.success && r.url?.startsWith('https://dollhousemcp.com/'));
      const failed = results.filter(r => !r.success);
      
      // All requests should succeed either via GitHub or fallback
      expect(successful.length + fallback.length).toBe(35);
      expect(failed.length).toBe(0);
      
      // At least one should succeed via GitHub (the first one)
      expect(successful.length).toBeGreaterThan(0);
    });

    it('should handle rate limit errors in import', async () => {
      process.env.GITHUB_TOKEN = 'ghp_1234567890123456789012345678901234567890';
      
      // Create sharer and immediately consume all tokens
      const testSharer = new PersonaSharer(mockGitHubClient as any, 'test-user');
      
      // Mock token validation for all requests
      const mockTokenValidation = {
        ok: true,
        headers: {
          get: jest.fn().mockImplementation((header: unknown) => {
            const headerStr = header as string;
            switch (headerStr) {
              case 'x-oauth-scopes': return 'gist,repo,user:email';
              case 'x-ratelimit-remaining': return '100';
              case 'x-ratelimit-reset': return '1640995200';
              default: return null;
            }
          })
        }
      };
      
      // First consume the rate limit (100 for authenticated)
      for (let i = 0; i < 101; i++) {
        const mockResponse = {
          ok: true,
          json: () => Promise.resolve({
            files: { 'persona.json': { content: '{}' } }
          })
        };
        // No token validation needed for import operations
        mockFetch.mockResolvedValueOnce(mockResponse as any);
        await testSharer.importFromUrl('https://gist.github.com/user/abc123');
      }
      
      // Now this should be rate limited
      const result = await testSharer.importFromUrl('https://gist.github.com/user/def456');
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('rate limit');
    });
  });
});