/**
 * Security tests for PersonaSharer SSRF protection and URL validation
 */

import { PersonaSharer } from '../../../src/persona/export-import/PersonaSharer.js';
import { describe, expect, it, beforeEach, jest } from '@jest/globals';

// Mock dependencies
jest.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
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

describe('PersonaSharer Security Tests', () => {
  let sharer: PersonaSharer;
  const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    sharer = new PersonaSharer(mockGitHubClient as any, 'test-user');
    jest.clearAllMocks();
    delete process.env.GITHUB_TOKEN;
  });

  describe('SSRF Protection - validateShareUrl', () => {
    const testCases = [
      // Localhost variations
      { url: 'http://localhost/evil', shouldBlock: true, description: 'localhost' },
      { url: 'http://127.0.0.1/evil', shouldBlock: true, description: '127.0.0.1' },
      { url: 'http://0.0.0.0/evil', shouldBlock: true, description: '0.0.0.0' },
      { url: 'http://0/evil', shouldBlock: true, description: '0' },
      { url: 'http://localhost.localdomain/evil', shouldBlock: true, description: 'localhost.localdomain' },
      
      // IPv6 localhost
      { url: 'http://[::1]/evil', shouldBlock: true, description: 'IPv6 ::1' },
      { url: 'http://[::ffff:127.0.0.1]/evil', shouldBlock: true, description: 'IPv6 mapped IPv4' },
      { url: 'http://[0000:0000:0000:0000:0000:0000:0000:0001]/evil', shouldBlock: true, description: 'IPv6 full form' },
      
      // Private IP ranges
      { url: 'http://10.0.0.1/evil', shouldBlock: true, description: '10.x.x.x private' },
      { url: 'http://192.168.1.1/evil', shouldBlock: true, description: '192.168.x.x private' },
      { url: 'http://172.16.0.1/evil', shouldBlock: true, description: '172.16.x.x private' },
      { url: 'http://172.31.255.255/evil', shouldBlock: true, description: '172.31.x.x private' },
      { url: 'http://169.254.1.1/evil', shouldBlock: true, description: 'link-local' },
      
      // Cloud metadata endpoints
      { url: 'http://169.254.169.254/latest/meta-data/', shouldBlock: true, description: 'AWS metadata' },
      { url: 'http://metadata.google.internal/', shouldBlock: true, description: 'GCP metadata' },
      { url: 'http://metadata.azure.com/', shouldBlock: true, description: 'Azure metadata' },
      { url: 'http://100.100.100.200/', shouldBlock: true, description: 'Alibaba metadata' },
      
      // Numeric/hex representations
      { url: 'http://2130706433/', shouldBlock: true, description: 'decimal IP (127.0.0.1)' },
      { url: 'http://0x7f000001/', shouldBlock: true, description: 'hex IP (127.0.0.1)' },
      { url: 'http://0x0/', shouldBlock: true, description: 'hex zero' },
      
      // Invalid protocols
      { url: 'file:///etc/passwd', shouldBlock: true, description: 'file protocol' },
      { url: 'ftp://example.com/', shouldBlock: true, description: 'ftp protocol' },
      { url: 'gopher://example.com/', shouldBlock: true, description: 'gopher protocol' },
      { url: 'javascript:alert(1)', shouldBlock: true, description: 'javascript protocol' },
      
      // Non-standard ports
      { url: 'http://example.com:22/', shouldBlock: true, description: 'SSH port' },
      { url: 'http://example.com:3306/', shouldBlock: true, description: 'MySQL port' },
      { url: 'http://example.com:6379/', shouldBlock: true, description: 'Redis port' },
      
      // Direct IP access (non-trusted)
      { url: 'http://1.2.3.4/', shouldBlock: true, description: 'direct IPv4' },
      { url: 'http://[2001:db8::1]/', shouldBlock: true, description: 'direct IPv6' },
      
      // URL length attack
      { url: 'http://example.com/' + 'a'.repeat(2050), shouldBlock: true, description: 'URL too long' },
      
      // Valid URLs that should pass
      { url: 'https://github.com/user/repo', shouldBlock: false, description: 'GitHub HTTPS' },
      { url: 'https://gist.github.com/123456', shouldBlock: false, description: 'GitHub Gist' },
      { url: 'https://api.github.com/gists/123', shouldBlock: false, description: 'GitHub API' },
      { url: 'https://dollhousemcp.com/share', shouldBlock: false, description: 'DollhouseMCP' },
      { url: 'http://example.com:8080/', shouldBlock: false, description: 'allowed port 8080' },
      { url: 'https://subdomain.example.com/', shouldBlock: false, description: 'valid subdomain' }
    ];

    testCases.forEach(({ url, shouldBlock, description }) => {
      it(`should ${shouldBlock ? 'block' : 'allow'} ${description}`, async () => {
        const result = await sharer.importFromUrl(url);
        
        if (shouldBlock) {
          expect(result.success).toBe(false);
          expect(result.message).toContain('Invalid or unsafe URL');
        } else {
          // For valid URLs, we expect the fetch to be attempted
          // (it will fail because we're not mocking the response, but that's OK)
          expect(result.success).toBe(false);
          expect(result.message).not.toContain('Invalid or unsafe URL');
        }
      });
    });
  });

  describe('ReDoS Protection', () => {
    it('should handle very long base64 strings without hanging', async () => {
      const longBase64 = 'A'.repeat(15000); // Longer than our 10000 limit
      const url = `https://dollhousemcp.com/import#dollhouse-persona=${longBase64}`;
      
      const startTime = Date.now();
      const result = await sharer.importFromUrl(url);
      const elapsed = Date.now() - startTime;
      
      expect(elapsed).toBeLessThan(100); // Should fail quickly, not hang
      expect(result.success).toBe(false);
      // The URL is too long and gets rejected by validateShareUrl first
      expect(result.message).toContain('Invalid or unsafe URL');
    });

    it('should accept valid base64 within limit', async () => {
      const validData = { name: 'Test', description: 'Test persona' };
      const base64 = Buffer.from(JSON.stringify(validData)).toString('base64');
      const url = `https://dollhousemcp.com/import#dollhouse-persona=${base64}`;
      
      const result = await sharer.importFromUrl(url);
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });
  });

  describe('Content-Type Validation', () => {
    it('should reject responses without JSON content type', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'text/html'
        }),
        json: jest.fn()
      } as any);

      const result = await sharer.importFromUrl('https://example.com/persona.json');
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid response type: expected JSON');
    });

    it('should accept valid JSON responses', async () => {
      const mockData = { name: 'Test Persona' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'application/json; charset=utf-8'
        }),
        json: jest.fn().mockResolvedValue(mockData)
      } as any);

      const result = await sharer.importFromUrl('https://example.com/persona.json');
      
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
    });

    it('should reject oversized responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
          'content-length': '10000000' // 10MB
        }),
        json: jest.fn()
      } as any);

      const result = await sharer.importFromUrl('https://example.com/persona.json');
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Response too large');
    });
  });

  describe('Error Message Sanitization', () => {
    it('should not expose sensitive status text in errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error: Database connection failed at 10.0.0.5',
        headers: new Headers()
      } as any);

      const result = await sharer.importFromUrl('https://example.com/persona.json');
      
      expect(result.success).toBe(false);
      expect(result.message).not.toContain('10.0.0.5');
      expect(result.message).toContain('Request failed with status 500');
    });
  });

  describe('Trusted Domain Validation', () => {
    const trustedDomains = [
      'https://github.com/user/repo',
      'https://gist.github.com/123',
      'https://api.github.com/gists/456',
      'https://raw.githubusercontent.com/user/repo/main/file',
      'https://subdomain.github.com/path',
      'https://dollhousemcp.com/share'
    ];

    trustedDomains.forEach(url => {
      it(`should allow trusted domain: ${url}`, async () => {
        // Mock successful response
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({
            'content-type': 'application/json'
          }),
          json: jest.fn().mockResolvedValue({ test: 'data' })
        } as any);

        const result = await sharer.importFromUrl(url);
        
        // Should attempt fetch (not blocked by URL validation)
        expect(mockFetch).toHaveBeenCalled();
      });
    });
  });
});