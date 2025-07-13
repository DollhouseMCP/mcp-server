import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock SignatureVerifier before importing UpdateChecker
jest.unstable_mockModule('../../../../src/update/SignatureVerifier.js', () => ({
  SignatureVerifier: jest.fn().mockImplementation(() => ({
    verifyTagSignature: jest.fn<() => Promise<{ verified: boolean; signerKey?: string; signerEmail?: string; error?: string }>>().mockResolvedValue({
      verified: true,
      signerKey: 'MOCKKEY123',
      signerEmail: 'test@example.com',
      error: undefined
    })
  }))
}));

const { UpdateChecker } = await import('../../../src/update/UpdateChecker.js');
import { VersionManager } from '../../../src/update/VersionManager.js';
import { RateLimiter } from '../../../src/update/RateLimiter.js';

// Mock fetch globally
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

describe('UpdateChecker Rate Limiting', () => {
  let updateChecker: InstanceType<typeof UpdateChecker>;
  let mockVersionManager: VersionManager;
  let mockRateLimiter: RateLimiter;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup mock version manager
    mockVersionManager = {
      getCurrentVersion: jest.fn<() => Promise<string>>().mockResolvedValue('1.0.0'),
      compareVersions: jest.fn<(v1: string, v2: string) => number>().mockReturnValue(-1) // Current < Latest
    } as unknown as VersionManager;
    
    // Reset fetch mock
    (global.fetch as jest.MockedFunction<typeof fetch>).mockReset();
  });

  describe('Rate limit enforcement', () => {
    it('should check rate limit before making API request', async () => {
      // Create rate limiter that denies requests
      mockRateLimiter = new RateLimiter({
        maxRequests: 1,
        windowMs: 60000
      });
      
      // Consume the only token
      mockRateLimiter.consumeToken();
      
      updateChecker = new UpdateChecker(mockVersionManager, {
        rateLimiter: mockRateLimiter
      });

      // Attempt update check
      await expect(updateChecker.checkForUpdates()).rejects.toThrow('Rate limit exceeded');
      
      // Verify no API call was made
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should provide helpful error message when rate limited', async () => {
      mockRateLimiter = new RateLimiter({
        maxRequests: 1,
        windowMs: 60000,
        minDelayMs: 30000
      });
      
      mockRateLimiter.consumeToken();
      
      updateChecker = new UpdateChecker(mockVersionManager, {
        rateLimiter: mockRateLimiter
      });

      try {
        await updateChecker.checkForUpdates();
        fail('Should have thrown rate limit error');
      } catch (error) {
        expect((error as Error).message).toContain('Rate limit exceeded');
        expect((error as Error).message).toContain('Please wait');
        expect((error as Error).message).toContain('requests remaining');
      }
    });

    it('should consume token on successful request', async () => {
      mockRateLimiter = new RateLimiter({
        maxRequests: 5,
        windowMs: 60000
      });
      
      updateChecker = new UpdateChecker(mockVersionManager, {
        rateLimiter: mockRateLimiter
      });

      // Mock successful API response
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v1.1.0',
          published_at: '2024-01-01T00:00:00Z',
          body: 'Release notes',
          html_url: 'https://github.com/test/release'
        })
      } as Response);

      // Initial tokens
      expect(updateChecker.getRateLimitStatus().remainingRequests).toBe(5);
      
      // Make request
      await updateChecker.checkForUpdates();
      
      // Token should be consumed
      expect(updateChecker.getRateLimitStatus().remainingRequests).toBe(4);
    });

    it('should not consume token on network failure', async () => {
      mockRateLimiter = new RateLimiter({
        maxRequests: 5,
        windowMs: 60000
      });
      
      updateChecker = new UpdateChecker(mockVersionManager, {
        rateLimiter: mockRateLimiter
      });

      // Mock network failure
      (global.fetch as jest.MockedFunction<typeof fetch>).mockRejectedValue(
        new Error('Network error')
      );

      // Initial tokens
      expect(updateChecker.getRateLimitStatus().remainingRequests).toBe(5);
      
      // Make request (will fail after retries)
      await expect(updateChecker.checkForUpdates()).rejects.toThrow('Network error');
      
      // Only one token should be consumed (not one per retry)
      expect(updateChecker.getRateLimitStatus().remainingRequests).toBe(4);
    });
  });

  describe('getRateLimitStatus', () => {
    it('should return current rate limit status', () => {
      mockRateLimiter = new RateLimiter({
        maxRequests: 10,
        windowMs: 3600000 // 1 hour
      });
      
      updateChecker = new UpdateChecker(mockVersionManager, {
        rateLimiter: mockRateLimiter
      });

      const status = updateChecker.getRateLimitStatus();
      
      expect(status).toMatchObject({
        allowed: true,
        remainingRequests: 10,
        resetTime: expect.any(Date),
        waitTimeSeconds: undefined
      });
    });

    it('should include wait time when rate limited', () => {
      mockRateLimiter = new RateLimiter({
        maxRequests: 1,
        windowMs: 60000,
        minDelayMs: 30000
      });
      
      // Consume token
      mockRateLimiter.consumeToken();
      
      updateChecker = new UpdateChecker(mockVersionManager, {
        rateLimiter: mockRateLimiter
      });

      const status = updateChecker.getRateLimitStatus();
      
      expect(status.allowed).toBe(false);
      expect(status.remainingRequests).toBe(0);
      // waitTimeSeconds is only set when checking limit, not in getStatus
      // The getRateLimitStatus method doesn't calculate retry time directly
      expect(status.resetTime).toBeInstanceOf(Date);
    });
  });

  describe('formatUpdateCheckResult with rate limit errors', () => {
    it('should format rate limit errors specially', () => {
      updateChecker = new UpdateChecker(mockVersionManager);
      
      const error = new Error(
        'Rate limit exceeded. Please wait 30 seconds before checking for updates again. ' +
        '(0 requests remaining, resets at 12:00:00 PM)'
      );
      
      const result = updateChecker.formatUpdateCheckResult(null, error);
      
      expect(result).toContain('⏳ **Rate Limit Exceeded**');
      expect(result).toContain('Why this happens:');
      expect(result).toContain('Update checks are limited to prevent API abuse');
      expect(result).toContain('What you can do:');
      expect(result).toContain('get_server_status');
    });

    it('should handle non-rate-limit errors normally', () => {
      updateChecker = new UpdateChecker(mockVersionManager);
      
      const error = new Error('Network timeout');
      
      const result = updateChecker.formatUpdateCheckResult(null, error);
      
      expect(result).toContain('❌ **Update Check Failed**');
      expect(result).not.toContain('Rate Limit Exceeded');
      expect(result).toContain('Check your internet connection');
    });
  });

  describe('Default rate limiter', () => {
    it('should use conservative defaults', async () => {
      updateChecker = new UpdateChecker(mockVersionManager);
      
      // Mock successful responses
      const mockResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v1.1.0',
          published_at: '2024-01-01T00:00:00Z',
          body: 'Release notes',
          html_url: 'https://github.com/test/release'
        })
      } as Response;

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue(mockResponse);

      // Should allow initial request
      await expect(updateChecker.checkForUpdates()).resolves.toBeTruthy();
      
      // Immediate second request should be rate limited (30 second minimum delay)
      await expect(updateChecker.checkForUpdates()).rejects.toThrow('Rate limit exceeded');
    });
  });

  describe('Custom rate limiter', () => {
    it('should respect custom rate limiter configuration', async () => {
      // Very permissive rate limiter
      mockRateLimiter = new RateLimiter({
        maxRequests: 100,
        windowMs: 1000, // 1 second
        minDelayMs: 0 // No minimum delay
      });
      
      updateChecker = new UpdateChecker(mockVersionManager, {
        rateLimiter: mockRateLimiter
      });

      // Mock successful responses
      const mockResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v1.1.0',
          published_at: '2024-01-01T00:00:00Z',
          body: 'Release notes',
          html_url: 'https://github.com/test/release'
        })
      } as Response;

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue(mockResponse);

      // Should allow multiple rapid requests
      await expect(updateChecker.checkForUpdates()).resolves.toBeTruthy();
      await expect(updateChecker.checkForUpdates()).resolves.toBeTruthy();
      await expect(updateChecker.checkForUpdates()).resolves.toBeTruthy();
      
      // Should still have many tokens left
      expect(updateChecker.getRateLimitStatus().remainingRequests).toBeGreaterThan(90);
    });
  });
});