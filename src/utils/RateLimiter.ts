/**
 * RateLimiter - Implements rate limiting for API calls to prevent abuse
 * 
 * Features:
 * - Token bucket algorithm for flexible rate limiting
 * - Configurable limits per time window
 * - Memory-efficient implementation
 * - Thread-safe for concurrent requests
 */

export interface RateLimiterConfig {
  maxRequests: number;      // Maximum requests allowed
  windowMs: number;         // Time window in milliseconds
  minDelayMs?: number;      // Minimum delay between requests (optional)
}

export interface RateLimitStatus {
  allowed: boolean;
  retryAfterMs?: number;
  remainingTokens: number;
  resetTime: Date;
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private lastRequest: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private readonly minDelay: number;

  constructor(config: RateLimiterConfig) {
    if (config.maxRequests <= 0) {
      throw new Error('maxRequests must be positive');
    }
    if (config.windowMs <= 0) {
      throw new Error('windowMs must be positive');
    }

    this.maxTokens = config.maxRequests;
    this.tokens = this.maxTokens;
    this.refillRate = this.maxTokens / config.windowMs;
    
    // Validate refill rate to prevent division by zero
    if (this.refillRate <= 0 || !Number.isFinite(this.refillRate)) {
      throw new Error('Invalid configuration: refill rate must be positive and finite');
    }
    
    this.lastRefill = Date.now();
    this.lastRequest = 0;
    this.minDelay = config.minDelayMs || 0;
  }

  /**
   * Check if a request is allowed under the rate limit
   * @returns Status object indicating if request is allowed
   */
  checkLimit(): RateLimitStatus {
    const now = Date.now();
    
    // Refill tokens based on time elapsed
    this.refillTokens(now);

    // Check minimum delay between requests
    if (this.minDelay > 0 && this.lastRequest > 0) {
      const timeSinceLastRequest = now - this.lastRequest;
      if (timeSinceLastRequest < this.minDelay) {
        const retryAfterMs = this.minDelay - timeSinceLastRequest;
        return {
          allowed: false,
          retryAfterMs,
          remainingTokens: Math.floor(this.tokens),
          resetTime: new Date(now + retryAfterMs)
        };
      }
    }

    // Check if we have tokens available
    if (this.tokens < 1) {
      // Calculate when the next token will be available
      const tokensNeeded = 1 - this.tokens;
      const msUntilNextToken = tokensNeeded / this.refillRate;
      
      return {
        allowed: false,
        retryAfterMs: Math.ceil(msUntilNextToken),
        remainingTokens: 0,
        resetTime: new Date(now + msUntilNextToken)
      };
    }

    // Request is allowed
    return {
      allowed: true,
      remainingTokens: Math.floor(this.tokens),
      resetTime: this.getResetTime()
    };
  }

  /**
   * Consume a token for an allowed request
   * Should be called after checkLimit() returns allowed: true
   */
  consumeToken(): void {
    const now = Date.now();
    this.refillTokens(now);
    
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.lastRequest = now;
    }
  }

  /**
   * Get current rate limit status without consuming a token
   */
  getStatus(): RateLimitStatus {
    const now = Date.now();
    this.refillTokens(now);

    return {
      allowed: this.tokens >= 1,
      remainingTokens: Math.floor(this.tokens),
      resetTime: this.getResetTime()
    };
  }

  /**
   * Reset the rate limiter to full capacity
   * Useful for testing or manual intervention
   */
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
    this.lastRequest = 0;
  }

  /**
   * Refill tokens based on time elapsed
   */
  private refillTokens(now: number): void {
    const timeSinceLastRefill = now - this.lastRefill;
    const tokensToAdd = timeSinceLastRefill * this.refillRate;
    
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Calculate when the rate limit window will reset
   */
  private getResetTime(): Date {
    const now = Date.now();
    const tokensToFull = this.maxTokens - this.tokens;
    const msUntilFull = tokensToFull / this.refillRate;
    return new Date(now + msUntilFull);
  }

  /**
   * Get human-readable rate limit information
   */
  toString(): string {
    const status = this.getStatus();
    return `RateLimit: ${status.remainingTokens}/${this.maxTokens} tokens, ` +
           `resets at ${status.resetTime.toISOString()}`;
  }
}

/**
 * Factory function to create common rate limiters
 */
export class RateLimiterFactory {
  /**
   * GitHub API rate limiter (60 requests per hour for unauthenticated)
   */
  static createGitHubLimiter(): RateLimiter {
    return new RateLimiter({
      maxRequests: 60,
      windowMs: 60 * 60 * 1000, // 1 hour
      minDelayMs: 1000 // 1 second minimum between requests
    });
  }

  /**
   * Conservative rate limiter for update checks
   * Allows 10 checks per hour with 30 second minimum delay
   */
  static createUpdateCheckLimiter(): RateLimiter {
    return new RateLimiter({
      maxRequests: 10,
      windowMs: 60 * 60 * 1000, // 1 hour
      minDelayMs: 30 * 1000 // 30 seconds between checks
    });
  }

  /**
   * Strict rate limiter for sensitive operations
   * Allows 5 requests per hour with 1 minute minimum delay
   */
  static createStrictLimiter(): RateLimiter {
    return new RateLimiter({
      maxRequests: 5,
      windowMs: 60 * 60 * 1000, // 1 hour
      minDelayMs: 60 * 1000 // 1 minute between requests
    });
  }
}