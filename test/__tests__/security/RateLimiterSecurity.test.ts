/**
 * Security tests for RateLimiter implementation
 */

import { RateLimiter, RateLimiterFactory } from '../../../src/utils/RateLimiter.js';
import { describe, expect, it, beforeEach, jest } from '@jest/globals';

describe('RateLimiter Security Tests', () => {
  describe('Token Bucket Algorithm', () => {
    it('should enforce rate limits correctly', () => {
      const limiter = new RateLimiter({
        maxRequests: 5,
        windowMs: 1000 // 1 second, no minDelay for this test
      });

      // First 5 requests should be allowed
      for (let i = 0; i < 5; i++) {
        const status = limiter.checkLimit();
        expect(status.allowed).toBe(true);
        expect(status.remainingTokens).toBe(5 - i);
        limiter.consumeToken();
      }

      // 6th request should be denied
      const deniedStatus = limiter.checkLimit();
      expect(deniedStatus.allowed).toBe(false);
      expect(deniedStatus.remainingTokens).toBe(0);
      expect(deniedStatus.retryAfterMs).toBeGreaterThan(0);
    });

    it('should prevent division by zero with invalid config', () => {
      expect(() => {
        new RateLimiter({
          maxRequests: 0,
          windowMs: 1000
        });
      }).toThrow('maxRequests must be positive');

      expect(() => {
        new RateLimiter({
          maxRequests: 10,
          windowMs: 0
        });
      }).toThrow('windowMs must be positive');
    });

    it('should handle extreme configurations safely', () => {
      // Very low rate limit
      const strictLimiter = new RateLimiter({
        maxRequests: 1,
        windowMs: 60 * 60 * 1000, // 1 hour
        minDelayMs: 60 * 1000 // 1 minute
      });

      const status1 = strictLimiter.checkLimit();
      expect(status1.allowed).toBe(true);
      strictLimiter.consumeToken();

      const status2 = strictLimiter.checkLimit();
      expect(status2.allowed).toBe(false);
      expect(status2.retryAfterMs).toBeGreaterThan(59000); // Close to 1 minute
    });

    it('should enforce minimum delay between requests', (done) => {
      const limiter = new RateLimiter({
        maxRequests: 100,
        windowMs: 1000,
        minDelayMs: 50
      });

      // First request should be allowed
      const status1 = limiter.checkLimit();
      expect(status1.allowed).toBe(true);
      limiter.consumeToken();

      // Immediate second request should be denied
      const status2 = limiter.checkLimit();
      expect(status2.allowed).toBe(false);
      expect(status2.retryAfterMs).toBeLessThanOrEqual(50);

      // After delay, should be allowed
      setTimeout(() => {
        const status3 = limiter.checkLimit();
        expect(status3.allowed).toBe(true);
        done();
      }, 60);
    });
  });

  describe('Factory Methods', () => {
    it('should create GitHub rate limiter with proper limits', () => {
      const githubLimiter = RateLimiterFactory.createGitHubLimiter();
      const status = githubLimiter.getStatus();
      
      expect(status.remainingTokens).toBe(60); // GitHub's unauthenticated limit
      expect(status.allowed).toBe(true);
    });

    it('should create update check limiter with conservative limits', () => {
      const updateLimiter = RateLimiterFactory.createUpdateCheckLimiter();
      const status = updateLimiter.getStatus();
      
      expect(status.remainingTokens).toBe(10); // 10 checks per hour
      expect(status.allowed).toBe(true);
    });

    it('should create strict limiter for sensitive operations', () => {
      const strictLimiter = RateLimiterFactory.createStrictLimiter();
      const status = strictLimiter.getStatus();
      
      expect(status.remainingTokens).toBe(5); // Only 5 requests per hour
      expect(status.allowed).toBe(true);
    });
  });

  describe('PersonaSharer Rate Limiting Integration', () => {
    it.skip('should use appropriate rate limits for authenticated vs unauthenticated', async () => {
      // SKIPPED: PersonaSharer has been disabled as export_persona tools were removed
      // This test was for the PersonaSharer rate limiting integration
      // When GITHUB_TOKEN exists: 100 requests/hour
      // When no token: 30 requests/hour (conservative)
      
      // The PersonaSharer module no longer exists after disabling export tools
      // Rate limiting is still tested in other tests in this file
    });
  });

  describe('Rate Limit Reset', () => {
    it('should properly reset rate limits', () => {
      const limiter = new RateLimiter({
        maxRequests: 5,
        windowMs: 1000
      });

      // Use all tokens
      for (let i = 0; i < 5; i++) {
        limiter.consumeToken();
      }

      expect(limiter.getStatus().allowed).toBe(false);

      // Reset should restore all tokens
      limiter.reset();
      const status = limiter.getStatus();
      expect(status.allowed).toBe(true);
      expect(status.remainingTokens).toBe(5);
    });
  });

  describe('Token Refill', () => {
    it('should refill tokens over time', (done) => {
      const limiter = new RateLimiter({
        maxRequests: 10,
        windowMs: 100 // 100ms window for faster test
      });

      // Use 5 tokens
      for (let i = 0; i < 5; i++) {
        limiter.consumeToken();
      }
      
      expect(limiter.getStatus().remainingTokens).toBe(5);

      // Wait for half the window
      setTimeout(() => {
        const status = limiter.getStatus();
        // Should have refilled approximately 5 tokens
        expect(status.remainingTokens).toBeGreaterThan(7);
        expect(status.remainingTokens).toBeLessThanOrEqual(10);
        done();
      }, 60);
    });
  });

  describe('Concurrent Request Protection', () => {
    it('should handle concurrent requests safely', () => {
      const limiter = new RateLimiter({
        maxRequests: 3,
        windowMs: 1000
      });

      // Simulate concurrent checks
      const results = [];
      for (let i = 0; i < 5; i++) {
        const status = limiter.checkLimit();
        if (status.allowed) {
          limiter.consumeToken();
          results.push(true);
        } else {
          results.push(false);
        }
      }

      // Should allow exactly 3 requests
      const allowedCount = results.filter(r => r).length;
      expect(allowedCount).toBe(3);
    });
  });
});