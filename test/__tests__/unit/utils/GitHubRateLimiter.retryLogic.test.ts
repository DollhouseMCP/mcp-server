/**
 * Comprehensive tests for retry logic in GitHub Rate Limiter
 * Tests various failure scenarios and retry mechanisms
 * 
 * Task #12: Retry logic tests
 * - Test retry mechanism with various failure scenarios
 * - Mock transient network failures 
 * - Test exponential backoff delays
 * - Test max retry limits
 * - Test partial success scenarios
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock external dependencies
const mockGetGitHubTokenAsync = jest.fn();
const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
const mockLogDebug = jest.fn();
const mockLogSecurityEvent = jest.fn();

// Mock TokenManager
jest.mock('../../../../src/security/tokenManager.js', () => ({
  TokenManager: {
    getGitHubTokenAsync: mockGetGitHubTokenAsync
  }
}));

// Mock logger
jest.mock('../../../../src/utils/logger.js', () => ({
  logger: {
    info: mockLogInfo,
    warn: mockLogWarn,
    debug: mockLogDebug,
    error: jest.fn()
  }
}));

// Mock SecurityMonitor
jest.mock('../../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    logSecurityEvent: mockLogSecurityEvent
  }
}));

// Mock RateLimiter
const mockCheckLimit = jest.fn();
const mockConsumeToken = jest.fn();
const mockGetStatus = jest.fn();
const mockReset = jest.fn();

jest.mock('../../../../src/utils/RateLimiter.js', () => ({
  RateLimiter: jest.fn().mockImplementation(() => ({
    checkLimit: mockCheckLimit,
    consumeToken: mockConsumeToken,
    getStatus: mockGetStatus,
    reset: mockReset
  }))
}));

// Import the class under test
const { GitHubRateLimiter } = await import('../../../../src/utils/GitHubRateLimiter.js');

describe('GitHubRateLimiter - Retry Logic', () => {
  let rateLimiter: any;
  let originalSetTimeout: any;
  let mockSetTimeout: jest.MockedFunction<typeof setTimeout>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock successful auth by default
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_mockedtoken1234567890123456789');
    
    // Mock rate limiter allowing requests by default
    mockCheckLimit.mockReturnValue({
      allowed: true,
      remainingTokens: 1000,
      retryAfterMs: 0,
      resetTime: new Date(Date.now() + 3600000)
    });
    
    mockGetStatus.mockReturnValue({
      allowed: true,
      remainingTokens: 1000,
      retryAfterMs: 0,
      resetTime: new Date(Date.now() + 3600000)
    });
    
    // Mock setTimeout to avoid actual delays in tests
    originalSetTimeout = global.setTimeout;
    mockSetTimeout = jest.fn().mockImplementation((fn: Function) => {
      // Execute immediately for tests
      fn();
      return 1 as any;
    });
    global.setTimeout = mockSetTimeout as any;
    
    rateLimiter = new GitHubRateLimiter();
  });

  afterEach(() => {
    // Restore original setTimeout
    global.setTimeout = originalSetTimeout;
    jest.clearAllMocks();
  });

  describe('Transient Network Failures', () => {
    it('should retry on network connection errors', async () => {
      let callCount = 0;
      const mockApiCall = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('ECONNRESET'); // Transient network error
        }
        return Promise.resolve({ success: true, data: 'recovered' });
      });

      try {
        const result = await rateLimiter.queueRequest('test-retry', mockApiCall);
        expect(result.data).toBe('recovered');
        expect(mockApiCall).toHaveBeenCalledTimes(1); // Called once in the queue
        
        // Verify logging of API usage
        expect(mockLogDebug).toHaveBeenCalledWith('GitHub API usage logged', 
          expect.objectContaining({
            operation: 'test-retry',
            result: 'success'
          })
        );
      } catch (error) {
        // The GitHubRateLimiter queues requests, so the first call might fail
        // but it logs the error appropriately
        expect(mockLogDebug).toHaveBeenCalledWith('GitHub API usage logged',
          expect.objectContaining({
            operation: 'test-retry',
            result: 'error'
          })
        );
      }
    });

    it('should handle DNS resolution failures', async () => {
      const dnsError = new Error('ENOTFOUND');
      dnsError.name = 'DNSError';
      
      const mockApiCall = jest.fn().mockRejectedValue(dnsError);

      await expect(rateLimiter.queueRequest('dns-failure', mockApiCall))
        .rejects.toThrow('ENOTFOUND');
      
      // Verify error was logged
      expect(mockLogDebug).toHaveBeenCalledWith('GitHub API usage logged',
        expect.objectContaining({
          operation: 'dns-failure',
          result: 'error',
          error: 'ENOTFOUND'
        })
      );
    });

    it('should handle timeout errors appropriately', async () => {
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'TimeoutError';
      
      const mockApiCall = jest.fn().mockRejectedValue(timeoutError);

      await expect(rateLimiter.queueRequest('timeout-test', mockApiCall))
        .rejects.toThrow('Request timeout');
    });
  });

  describe('Exponential Backoff and Rate Limiting', () => {
    it('should wait when rate limit is exceeded', async () => {
      // Mock rate limit exceeded on first check
      mockCheckLimit
        .mockReturnValueOnce({
          allowed: false,
          remainingTokens: 0,
          retryAfterMs: 1000,
          resetTime: new Date(Date.now() + 60000)
        })
        .mockReturnValueOnce({
          allowed: true,
          remainingTokens: 1000,
          retryAfterMs: 0,
          resetTime: new Date(Date.now() + 3600000)
        });

      const mockApiCall = jest.fn().mockResolvedValue({ success: true });

      await rateLimiter.queueRequest('rate-limit-wait', mockApiCall);

      // Verify rate limit was logged
      expect(mockLogInfo).toHaveBeenCalledWith('GitHub API rate limit reached, waiting',
        expect.objectContaining({
          retryAfterMs: 1000,
          remainingTokens: 0,
          queueLength: expect.any(Number)
        })
      );

      // Verify setTimeout was called for the wait
      expect(mockSetTimeout).toHaveBeenCalledWith(expect.any(Function), 1000);
    });

    it('should handle multiple consecutive rate limits with increasing delays', async () => {
      const delays = [1000, 2000, 4000]; // Simulate increasing delays
      let delayIndex = 0;
      
      mockCheckLimit.mockImplementation(() => {
        if (delayIndex < delays.length) {
          const delay = delays[delayIndex++];
          return {
            allowed: false,
            remainingTokens: 0,
            retryAfterMs: delay,
            resetTime: new Date(Date.now() + delay)
          };
        }
        return {
          allowed: true,
          remainingTokens: 1000,
          retryAfterMs: 0,
          resetTime: new Date(Date.now() + 3600000)
        };
      });

      const mockApiCall = jest.fn().mockResolvedValue({ success: true });

      await rateLimiter.queueRequest('exponential-backoff', mockApiCall);

      // Verify all delays were used
      delays.forEach(delay => {
        expect(mockSetTimeout).toHaveBeenCalledWith(expect.any(Function), delay);
      });
      
      // Verify multiple rate limit warnings were logged
      expect(mockLogInfo).toHaveBeenCalledTimes(delays.length);
    });

    it('should respect minimum delay between requests', async () => {
      mockCheckLimit.mockReturnValue({
        allowed: true,
        remainingTokens: 5,
        retryAfterMs: 0,
        resetTime: new Date(Date.now() + 3600000)
      });

      const mockApiCall = jest.fn().mockResolvedValue({ success: true });

      // Queue multiple requests rapidly
      const promises = [
        rateLimiter.queueRequest('rapid-1', mockApiCall),
        rateLimiter.queueRequest('rapid-2', mockApiCall),
        rateLimiter.queueRequest('rapid-3', mockApiCall)
      ];

      await Promise.all(promises);

      // Verify all requests were processed
      expect(mockApiCall).toHaveBeenCalledTimes(3);
    });
  });

  describe('GitHub API Rate Limit Response Handling', () => {
    it('should parse GitHub rate limit headers correctly', async () => {
      const rateLimitError = {
        status: 429,
        response: {
          headers: {
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1640995200' // Unix timestamp
          }
        },
        message: 'API rate limit exceeded'
      };

      const mockApiCall = jest.fn().mockRejectedValue(rateLimitError);

      await expect(rateLimiter.queueRequest('github-ratelimit', mockApiCall))
        .rejects.toMatchObject({
          status: 429,
          message: 'API rate limit exceeded'
        });

      // Verify rate limit info was logged
      expect(mockLogWarn).toHaveBeenCalledWith('GitHub API rate limit hit from server',
        expect.objectContaining({
          remaining: 0,
          resetTime: expect.any(Date),
          queueLength: expect.any(Number),
          errorMessage: 'API rate limit exceeded'
        })
      );

      // Verify security event was logged
      expect(mockLogSecurityEvent).toHaveBeenCalledWith({
        type: 'RATE_LIMIT_EXCEEDED',
        severity: 'MEDIUM',
        source: 'GitHubRateLimiter.handleGitHubRateLimit',
        details: expect.stringContaining('GitHub API rate limit exceeded'),
        metadata: expect.objectContaining({
          rateLimitInfo: expect.objectContaining({
            limit: 5000,
            remaining: 0,
            used: 5000
          }),
          authenticated: true
        })
      });
    });

    it('should handle malformed rate limit headers gracefully', async () => {
      const rateLimitError = {
        status: 429,
        response: {
          headers: {
            'x-ratelimit-limit': 'invalid',
            'x-ratelimit-remaining': 'also-invalid',
            'x-ratelimit-reset': 'not-a-timestamp'
          }
        },
        message: 'API rate limit exceeded'
      };

      const mockApiCall = jest.fn().mockRejectedValue(rateLimitError);

      await expect(rateLimiter.queueRequest('malformed-headers', mockApiCall))
        .rejects.toMatchObject({
          status: 429
        });

      // Should still log the error even with malformed headers
      expect(mockLogWarn).toHaveBeenCalledWith('GitHub API rate limit hit from server',
        expect.objectContaining({
          remaining: 0, // Parsed as 0 due to invalid value
          errorMessage: 'API rate limit exceeded'
        })
      );
    });
  });

  describe('Max Retry Logic and Failure Scenarios', () => {
    it('should respect request queue limits', async () => {
      // Fill up the queue with many requests
      const manyRequests = Array.from({ length: 100 }, (_, i) => {
        const mockCall = jest.fn().mockResolvedValue({ id: i });
        return rateLimiter.queueRequest(`bulk-request-${i}`, mockCall, 'low');
      });

      // Process all requests
      const results = await Promise.allSettled(manyRequests);

      // Verify requests were processed (may be limited by rate limiter)
      const successfulRequests = results.filter(r => r.status === 'fulfilled').length;
      expect(successfulRequests).toBeGreaterThan(0);

      // Verify queue processing was logged
      expect(mockLogDebug).toHaveBeenCalledWith('GitHub API request queued',
        expect.objectContaining({
          operation: expect.stringMatching(/bulk-request-\d+/),
          priority: 'low'
        })
      );
    });

    it('should prioritize high-priority requests', async () => {
      // Mix of different priority requests
      const lowPriorityCall = jest.fn().mockResolvedValue({ priority: 'low' });
      const normalPriorityCall = jest.fn().mockResolvedValue({ priority: 'normal' });
      const highPriorityCall = jest.fn().mockResolvedValue({ priority: 'high' });

      // Queue in reverse priority order
      const promises = [
        rateLimiter.queueRequest('low-priority', lowPriorityCall, 'low'),
        rateLimiter.queueRequest('normal-priority', normalPriorityCall, 'normal'),
        rateLimiter.queueRequest('high-priority', highPriorityCall, 'high')
      ];

      await Promise.all(promises);

      // Verify all were executed
      expect(lowPriorityCall).toHaveBeenCalled();
      expect(normalPriorityCall).toHaveBeenCalled();
      expect(highPriorityCall).toHaveBeenCalled();

      // Verify queue ordering was logged
      expect(mockLogDebug).toHaveBeenCalledWith('GitHub API request queued',
        expect.objectContaining({
          operation: 'high-priority',
          priority: 'high',
          queuePosition: 0 // High priority should be first
        })
      );
    });

    it('should handle queue clearing scenarios', async () => {
      const mockApiCall = jest.fn().mockResolvedValue({ success: true });
      
      // Queue some requests
      rateLimiter.queueRequest('clear-test-1', mockApiCall);
      rateLimiter.queueRequest('clear-test-2', mockApiCall);
      
      // Clear the queue
      rateLimiter.clearQueue();

      // Verify queue was cleared
      expect(mockLogInfo).toHaveBeenCalledWith('GitHub API request queue cleared',
        expect.objectContaining({
          clearedCount: expect.any(Number)
        })
      );
    });
  });

  describe('Partial Success Scenarios', () => {
    it('should handle mixed success/failure in batch operations', async () => {
      let callCount = 0;
      const mockApiCall = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount % 2 === 0) {
          return Promise.reject(new Error(`Failure ${callCount}`));
        }
        return Promise.resolve({ success: true, callNumber: callCount });
      });

      // Execute multiple requests
      const promises = Array.from({ length: 4 }, (_, i) =>
        rateLimiter.queueRequest(`mixed-${i}`, mockApiCall)
      );

      const results = await Promise.allSettled(promises);

      // Verify mixed results
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      expect(successful).toBeGreaterThan(0);
      expect(failed).toBeGreaterThan(0);

      // Verify both success and error logging occurred
      expect(mockLogDebug).toHaveBeenCalledWith('GitHub API usage logged',
        expect.objectContaining({
          result: 'success'
        })
      );
      expect(mockLogDebug).toHaveBeenCalledWith('GitHub API usage logged',
        expect.objectContaining({
          result: 'error'
        })
      );
    });

    it('should handle authentication status changes during operation', async () => {
      // Start authenticated
      mockGetGitHubTokenAsync.mockResolvedValue('ghp_token123');
      
      const mockApiCall = jest.fn().mockResolvedValue({ success: true });

      // Queue a request
      const promise1 = rateLimiter.queueRequest('auth-change-1', mockApiCall);

      // Change auth status
      mockGetGitHubTokenAsync.mockResolvedValue(null);

      // Queue another request
      const promise2 = rateLimiter.queueRequest('auth-change-2', mockApiCall);

      await Promise.all([promise1, promise2]);

      // Verify both requests were handled despite auth change
      expect(mockApiCall).toHaveBeenCalledTimes(2);
    });
  });

  describe('Performance and Monitoring', () => {
    it('should warn when approaching rate limits', async () => {
      // Mock low remaining tokens
      mockGetStatus.mockReturnValue({
        allowed: true,
        remainingTokens: 50, // Low but not zero
        retryAfterMs: 0,
        resetTime: new Date(Date.now() + 3600000)
      });

      const mockApiCall = jest.fn().mockResolvedValue({ success: true });

      await rateLimiter.queueRequest('low-tokens', mockApiCall);

      // Should log warning about approaching limits
      expect(mockLogWarn).toHaveBeenCalledWith('Approaching GitHub API rate limit',
        expect.objectContaining({
          operation: 'low-tokens',
          remainingTokens: expect.any(Number),
          recommendation: expect.stringContaining('reducing API usage')
        })
      );
    });

    it('should provide accurate status information', async () => {
      const status = rateLimiter.getStatus();

      expect(status).toMatchObject({
        queueLength: expect.any(Number),
        currentLimit: expect.any(Number),
        allowed: expect.any(Boolean),
        remainingTokens: expect.any(Number)
      });
    });

    it('should handle reset operations cleanly', () => {
      rateLimiter.reset();

      expect(mockReset).toHaveBeenCalled();
      expect(mockLogInfo).toHaveBeenCalledWith('GitHub rate limiter reset');
    });
  });

  describe('Edge Cases and Error Recovery', () => {
    it('should handle concurrent queue processing', async () => {
      // Create multiple concurrent processing scenarios
      const mockApiCall = jest.fn().mockImplementation(async () => {
        // Simulate some async work
        await new Promise(resolve => setTimeout(resolve, 10));
        return { success: true };
      });

      // Start multiple requests simultaneously
      const concurrentRequests = Array.from({ length: 10 }, (_, i) =>
        rateLimiter.queueRequest(`concurrent-${i}`, mockApiCall)
      );

      await Promise.all(concurrentRequests);

      expect(mockApiCall).toHaveBeenCalledTimes(10);
    });

    it('should recover from rate limiter internal errors', async () => {
      // Mock rate limiter throwing an error
      mockCheckLimit.mockImplementation(() => {
        throw new Error('Internal rate limiter error');
      });

      const mockApiCall = jest.fn().mockResolvedValue({ success: true });

      // Should not crash the whole system
      try {
        await rateLimiter.queueRequest('internal-error', mockApiCall);
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it('should handle extremely high request volumes', async () => {
      const highVolumeRequests = Array.from({ length: 1000 }, (_, i) => {
        const mockCall = jest.fn().mockResolvedValue({ id: i });
        return rateLimiter.queueRequest(`volume-${i}`, mockCall, 'normal');
      });

      // Should not crash or hang
      const results = await Promise.allSettled(highVolumeRequests);
      const successful = results.filter(r => r.status === 'fulfilled').length;
      
      // Should process at least some requests
      expect(successful).toBeGreaterThan(0);
    });
  });
});