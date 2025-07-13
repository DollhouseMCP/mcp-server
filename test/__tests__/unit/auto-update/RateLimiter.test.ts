import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { RateLimiter, RateLimiterFactory } from '../../../src/update/RateLimiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create rate limiter with valid config', () => {
      const limiter = new RateLimiter({
        maxRequests: 10,
        windowMs: 60000
      });
      
      expect(limiter).toBeDefined();
      const status = limiter.getStatus();
      expect(status.remainingTokens).toBe(10);
    });

    it('should throw on invalid maxRequests', () => {
      expect(() => new RateLimiter({
        maxRequests: 0,
        windowMs: 60000
      })).toThrow('maxRequests must be positive');
      
      expect(() => new RateLimiter({
        maxRequests: -1,
        windowMs: 60000
      })).toThrow('maxRequests must be positive');
    });

    it('should throw on invalid windowMs', () => {
      expect(() => new RateLimiter({
        maxRequests: 10,
        windowMs: 0
      })).toThrow('windowMs must be positive');
      
      expect(() => new RateLimiter({
        maxRequests: 10,
        windowMs: -1000
      })).toThrow('windowMs must be positive');
    });
  });

  describe('checkLimit', () => {
    it('should allow requests when tokens available', () => {
      const limiter = new RateLimiter({
        maxRequests: 5,
        windowMs: 60000
      });

      const status = limiter.checkLimit();
      expect(status.allowed).toBe(true);
      expect(status.remainingTokens).toBe(5);
      expect(status.retryAfterMs).toBeUndefined();
    });

    it('should deny requests when no tokens available', () => {
      const limiter = new RateLimiter({
        maxRequests: 1,
        windowMs: 60000
      });

      // Consume the only token
      limiter.consumeToken();

      const status = limiter.checkLimit();
      expect(status.allowed).toBe(false);
      expect(status.remainingTokens).toBe(0);
      expect(status.retryAfterMs).toBeGreaterThan(0);
    });

    it('should respect minimum delay between requests', () => {
      const limiter = new RateLimiter({
        maxRequests: 10,
        windowMs: 60000,
        minDelayMs: 5000 // 5 seconds
      });

      // First request should be allowed
      expect(limiter.checkLimit().allowed).toBe(true);
      limiter.consumeToken();

      // Immediate second request should be denied
      const status = limiter.checkLimit();
      expect(status.allowed).toBe(false);
      expect(status.retryAfterMs).toBeLessThanOrEqual(5000);
      expect(status.retryAfterMs).toBeGreaterThan(4900); // Allow small timing variance
    });
  });

  describe('consumeToken', () => {
    it('should decrease available tokens', () => {
      const limiter = new RateLimiter({
        maxRequests: 5,
        windowMs: 60000
      });

      expect(limiter.getStatus().remainingTokens).toBe(5);
      
      limiter.consumeToken();
      expect(limiter.getStatus().remainingTokens).toBe(4);
      
      limiter.consumeToken();
      expect(limiter.getStatus().remainingTokens).toBe(3);
    });

    it('should update lastRequest timestamp', () => {
      const limiter = new RateLimiter({
        maxRequests: 5,
        windowMs: 60000,
        minDelayMs: 1000
      });

      limiter.consumeToken();
      const firstCheck = limiter.checkLimit();
      expect(firstCheck.allowed).toBe(false); // Due to minDelay
    });
  });

  describe('token refill', () => {
    it('should refill tokens over time', async () => {
      jest.useFakeTimers();
      
      const limiter = new RateLimiter({
        maxRequests: 10,
        windowMs: 10000 // 10 seconds
      });

      // Consume all tokens
      for (let i = 0; i < 10; i++) {
        limiter.consumeToken();
      }
      expect(limiter.getStatus().remainingTokens).toBe(0);

      // Advance time by 5 seconds (should refill 5 tokens)
      jest.advanceTimersByTime(5000);
      
      const status = limiter.getStatus();
      expect(status.remainingTokens).toBe(5);

      jest.useRealTimers();
    });

    it('should not exceed maxTokens when refilling', async () => {
      jest.useFakeTimers();
      
      const limiter = new RateLimiter({
        maxRequests: 5,
        windowMs: 10000
      });

      // Advance time significantly
      jest.advanceTimersByTime(60000); // 1 minute
      
      const status = limiter.getStatus();
      expect(status.remainingTokens).toBe(5); // Should not exceed max

      jest.useRealTimers();
    });
  });

  describe('reset', () => {
    it('should restore rate limiter to full capacity', () => {
      const limiter = new RateLimiter({
        maxRequests: 5,
        windowMs: 60000
      });

      // Consume some tokens
      limiter.consumeToken();
      limiter.consumeToken();
      expect(limiter.getStatus().remainingTokens).toBe(3);

      // Reset
      limiter.reset();
      expect(limiter.getStatus().remainingTokens).toBe(5);
    });
  });

  describe('getStatus', () => {
    it('should return current status without consuming tokens', () => {
      const limiter = new RateLimiter({
        maxRequests: 5,
        windowMs: 60000
      });

      const status1 = limiter.getStatus();
      const status2 = limiter.getStatus();
      
      expect(status1.remainingTokens).toBe(5);
      expect(status2.remainingTokens).toBe(5);
    });

    it('should include reset time', () => {
      const limiter = new RateLimiter({
        maxRequests: 5,
        windowMs: 60000
      });

      limiter.consumeToken();
      
      const status = limiter.getStatus();
      expect(status.resetTime).toBeInstanceOf(Date);
      expect(status.resetTime.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('toString', () => {
    it('should return human-readable rate limit info', () => {
      const limiter = new RateLimiter({
        maxRequests: 10,
        windowMs: 60000
      });

      const str = limiter.toString();
      expect(str).toMatch(/RateLimit: \d+\/10 tokens/);
      expect(str).toContain('resets at');
    });
  });
});

describe('RateLimiterFactory', () => {
  describe('createGitHubLimiter', () => {
    it('should create limiter with GitHub API limits', () => {
      const limiter = RateLimiterFactory.createGitHubLimiter();
      const status = limiter.getStatus();
      
      expect(status.remainingTokens).toBe(60);
      
      // Check minimum delay
      limiter.consumeToken();
      const nextStatus = limiter.checkLimit();
      expect(nextStatus.allowed).toBe(false); // 1 second min delay
    });
  });

  describe('createUpdateCheckLimiter', () => {
    it('should create conservative limiter for update checks', () => {
      const limiter = RateLimiterFactory.createUpdateCheckLimiter();
      const status = limiter.getStatus();
      
      expect(status.remainingTokens).toBe(10);
      
      // Check minimum delay (30 seconds)
      limiter.consumeToken();
      const nextStatus = limiter.checkLimit();
      expect(nextStatus.allowed).toBe(false);
      expect(nextStatus.retryAfterMs).toBeLessThanOrEqual(30000);
    });
  });

  describe('createStrictLimiter', () => {
    it('should create strict limiter for sensitive operations', () => {
      const limiter = RateLimiterFactory.createStrictLimiter();
      const status = limiter.getStatus();
      
      expect(status.remainingTokens).toBe(5);
      
      // Check minimum delay (60 seconds)
      limiter.consumeToken();
      const nextStatus = limiter.checkLimit();
      expect(nextStatus.allowed).toBe(false);
      expect(nextStatus.retryAfterMs).toBeLessThanOrEqual(60000);
    });
  });
});

describe('RateLimiter Integration Scenarios', () => {
  it('should handle burst requests correctly', () => {
    const limiter = new RateLimiter({
      maxRequests: 3,
      windowMs: 10000,
      minDelayMs: 0 // No minimum delay for this test
    });

    const results: boolean[] = [];
    
    // Try 5 rapid requests
    for (let i = 0; i < 5; i++) {
      const status = limiter.checkLimit();
      if (status.allowed) {
        limiter.consumeToken();
        results.push(true);
      } else {
        results.push(false);
      }
    }

    // First 3 requests should succeed, remaining should fail
    expect(results[0]).toBe(true);
    expect(results[1]).toBe(true);
    expect(results[2]).toBe(true);
    expect(results[3]).toBe(false);
    expect(results[4]).toBe(false);
    expect(results.filter(r => r).length).toBe(3);
  });

  it('should calculate retry times accurately', () => {
    jest.useFakeTimers();
    
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 60000 // 1 minute
    });

    // Consume the token
    limiter.consumeToken();
    
    // Check retry time
    const status = limiter.checkLimit();
    expect(status.allowed).toBe(false);
    expect(status.retryAfterMs).toBeLessThanOrEqual(60000);
    expect(status.retryAfterMs).toBeGreaterThan(59000);
    
    // Advance time and check again
    jest.advanceTimersByTime(30000); // 30 seconds
    
    const status2 = limiter.checkLimit();
    expect(status2.allowed).toBe(false);
    expect(status2.retryAfterMs).toBeLessThanOrEqual(30000);
    expect(status2.retryAfterMs).toBeGreaterThan(29000);
    
    jest.useRealTimers();
  });
});