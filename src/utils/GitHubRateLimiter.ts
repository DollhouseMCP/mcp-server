/**
 * GitHubRateLimiter - Specialized rate limiter for GitHub API calls
 * 
 * Features:
 * - Respects GitHub's authenticated (5000/hour) and unauthenticated (60/hour) limits
 * - Client-side queuing when approaching limits
 * - Request prioritization for critical operations
 * - Comprehensive logging for quota management
 * - Early termination when exact matches are found
 */

import { RateLimiter, RateLimiterConfig, RateLimitStatus } from './RateLimiter.js';
import { GITHUB_API_RATE_LIMITS } from '../config/portfolio-constants.js';
import { TokenManager } from '../security/tokenManager.js';
import { logger } from './logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

export interface GitHubRateLimitInfo {
  limit: number;
  remaining: number;
  reset: Date;
  used: number;
}

export interface GitHubApiRequest {
  id: string;
  operation: string;
  priority: 'high' | 'normal' | 'low';
  timestamp: number;
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

export interface GitHubRateStatus extends RateLimitStatus {
  queueLength: number;
  currentLimit: number;
  rateLimitInfo?: GitHubRateLimitInfo;
}

export class GitHubRateLimiter {
  private rateLimiter!: RateLimiter;
  private requestQueue: GitHubApiRequest[] = [];
  private processing = false;
  private lastRateLimitInfo?: GitHubRateLimitInfo;
  private isAuthenticated = false;

  constructor() {
    // Initialize with conservative limits - will update based on auth status
    this.updateLimitsForAuthStatus();
    this.setupPeriodicStatusCheck();
  }

  /**
   * Update rate limits based on current authentication status
   */
  private async updateLimitsForAuthStatus(): Promise<void> {
    try {
      const token = await TokenManager.getGitHubTokenAsync();
      const newIsAuthenticated = !!token;
      
      // Only recreate rate limiter if auth status changed
      if (newIsAuthenticated !== this.isAuthenticated) {
        this.isAuthenticated = newIsAuthenticated;
        
        const limit = this.isAuthenticated 
          ? GITHUB_API_RATE_LIMITS.AUTHENTICATED_LIMIT 
          : GITHUB_API_RATE_LIMITS.UNAUTHENTICATED_LIMIT;
          
        // Apply buffer to stay below actual limits
        const bufferedLimit = Math.floor(limit * GITHUB_API_RATE_LIMITS.BUFFER_PERCENTAGE);
        
        const config: RateLimiterConfig = {
          maxRequests: bufferedLimit,
          windowMs: GITHUB_API_RATE_LIMITS.WINDOW_MS,
          minDelayMs: GITHUB_API_RATE_LIMITS.MIN_DELAY_MS
        };
        
        this.rateLimiter = new RateLimiter(config);
        
        logger.info('GitHub rate limiter updated', {
          authenticated: this.isAuthenticated,
          limit: bufferedLimit,
          originalLimit: limit,
          bufferPercentage: GITHUB_API_RATE_LIMITS.BUFFER_PERCENTAGE
        });
      }
    } catch (error) {
      logger.warn('Failed to check authentication status for rate limiting', { error });
      // Fall back to unauthenticated limits
      this.isAuthenticated = false;
      this.rateLimiter = new RateLimiter({
        maxRequests: Math.floor(GITHUB_API_RATE_LIMITS.UNAUTHENTICATED_LIMIT * GITHUB_API_RATE_LIMITS.BUFFER_PERCENTAGE),
        windowMs: GITHUB_API_RATE_LIMITS.WINDOW_MS,
        minDelayMs: GITHUB_API_RATE_LIMITS.MIN_DELAY_MS
      });
    }
  }

  /**
   * Setup periodic check for rate limit status
   */
  private setupPeriodicStatusCheck(): void {
    // Check auth status every 5 minutes
    setInterval(() => {
      this.updateLimitsForAuthStatus().catch(error => {
        logger.warn('Periodic auth status check failed', { error });
      });
    }, 5 * 60 * 1000);
  }

  /**
   * Queue a GitHub API request with rate limiting
   * @param operation Description of the operation
   * @param apiCall Function that makes the actual API call
   * @param priority Request priority (high, normal, low)
   * @returns Promise that resolves with the API response
   */
  async queueRequest<T>(
    operation: string,
    apiCall: () => Promise<T>,
    priority: 'high' | 'normal' | 'low' = 'normal'
  ): Promise<T> {
    // SECURITY FIX (DMCP-SEC-004): Normalize Unicode in operation name to prevent injection attacks
    const normalizedOperation = UnicodeValidator.normalize(operation);
    if (!normalizedOperation.isValid) {
      SecurityMonitor.logSecurityEvent({
        type: 'UNICODE_VALIDATION_ERROR',
        severity: 'MEDIUM',
        source: 'GitHubRateLimiter.queueRequest',
        details: `Invalid Unicode in operation name: ${normalizedOperation.detectedIssues?.[0] || 'unknown error'}`
      });
      // Use a safe fallback for the operation name
      operation = 'github-api-request';
    } else {
      operation = normalizedOperation.normalizedContent;
    }
    
    const requestId = `${operation}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    return new Promise<T>((resolve, reject) => {
      const request: GitHubApiRequest = {
        id: requestId,
        operation,
        priority,
        timestamp: Date.now(),
        resolve: () => {
          // Wrap in async IIFE to handle async operations without returning a Promise
          (async () => {
            try {
              logger.debug('Executing GitHub API request', {
                operation,
                requestId,
                queueWaitTime: Date.now() - request.timestamp
              });

              const result = await apiCall();
              resolve(result);
            
            // Log successful API usage for quota tracking
            this.logApiUsage(operation, 'success');
            
            } catch (error) {
              // Check if this is a rate limit error from GitHub
              if (this.isGitHubRateLimitError(error)) {
                this.handleGitHubRateLimit(error);
              }
              reject(error);
              this.logApiUsage(operation, 'error', error);
            }
          })();
        },
        reject
      };

      // Add to queue with priority ordering
      this.addToQueue(request);
      this.processQueue();
    });
  }

  /**
   * Add request to queue with priority ordering
   */
  private addToQueue(request: GitHubApiRequest): void {
    // Insert based on priority: high > normal > low
    // Within same priority, maintain FIFO order
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    
    let insertIndex = this.requestQueue.length;
    for (let i = 0; i < this.requestQueue.length; i++) {
      if (priorityOrder[request.priority] < priorityOrder[this.requestQueue[i].priority]) {
        insertIndex = i;
        break;
      }
    }
    
    this.requestQueue.splice(insertIndex, 0, request);
    
    logger.debug('GitHub API request queued', {
      operation: request.operation,
      priority: request.priority,
      queuePosition: insertIndex,
      totalQueued: this.requestQueue.length
    });
  }

  /**
   * Process the request queue
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.requestQueue.length === 0) {
      return;
    }

    this.processing = true;

    try {
      while (this.requestQueue.length > 0) {
        // Update auth status periodically
        if (Math.random() < 0.1) { // 10% chance
          await this.updateLimitsForAuthStatus();
        }

        const rateLimitStatus = this.rateLimiter.checkLimit();
        
        if (!rateLimitStatus.allowed) {
          // Log rate limit wait
          logger.info('GitHub API rate limit reached, waiting', {
            retryAfterMs: rateLimitStatus.retryAfterMs,
            remainingTokens: rateLimitStatus.remainingTokens,
            queueLength: this.requestQueue.length,
            resetTime: rateLimitStatus.resetTime
          });

          // Wait for the specified time
          await new Promise(resolve => setTimeout(resolve, rateLimitStatus.retryAfterMs || 1000));
          continue;
        }

        // Process the next request
        const request = this.requestQueue.shift()!;
        this.rateLimiter.consumeToken();

        // Execute the request
        request.resolve(null); // This will trigger the actual API call
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Get current rate limit status
   */
  getStatus(): GitHubRateStatus {
    const baseStatus = this.rateLimiter.getStatus();
    
    return {
      ...baseStatus,
      queueLength: this.requestQueue.length,
      currentLimit: this.isAuthenticated 
        ? GITHUB_API_RATE_LIMITS.AUTHENTICATED_LIMIT 
        : GITHUB_API_RATE_LIMITS.UNAUTHENTICATED_LIMIT,
      rateLimitInfo: this.lastRateLimitInfo
    };
  }

  /**
   * Check if an error is a GitHub rate limit error
   */
  private isGitHubRateLimitError(error: any): boolean {
    return error?.status === 429 || 
           error?.response?.status === 429 ||
           (typeof error?.message === 'string' && error.message.toLowerCase().includes('rate limit'));
  }

  /**
   * Handle GitHub rate limit error response
   */
  private handleGitHubRateLimit(error: any): void {
    let resetTime: Date | undefined;
    let remainingRequests = 0;
    
    // Parse rate limit headers if available
    if (error?.response?.headers) {
      const headers = error.response.headers;
      const resetTimestamp = parseInt(headers['x-ratelimit-reset'] || '0');
      const remaining = parseInt(headers['x-ratelimit-remaining'] || '0');
      const limit = parseInt(headers['x-ratelimit-limit'] || '0');
      
      if (resetTimestamp > 0) {
        resetTime = new Date(resetTimestamp * 1000);
      }
      
      this.lastRateLimitInfo = {
        limit,
        remaining,
        reset: resetTime || new Date(Date.now() + 60 * 60 * 1000), // Default to 1 hour
        used: limit - remaining
      };
      
      remainingRequests = remaining;
    }

    logger.warn('GitHub API rate limit hit from server', {
      remaining: remainingRequests,
      resetTime,
      queueLength: this.requestQueue.length,
      errorMessage: error?.message
    });

    // Log as a security event for monitoring
    SecurityMonitor.logSecurityEvent({
      type: 'RATE_LIMIT_EXCEEDED',
      severity: 'MEDIUM',
      source: 'GitHubRateLimiter.handleGitHubRateLimit',
      details: `GitHub API rate limit exceeded. Remaining: ${remainingRequests}, Queue: ${this.requestQueue.length}`,
      metadata: {
        rateLimitInfo: this.lastRateLimitInfo,
        authenticated: this.isAuthenticated
      }
    });
  }

  /**
   * Log API usage for monitoring and diagnostics
   */
  private logApiUsage(operation: string, result: 'success' | 'error', error?: any): void {
    const status = this.getStatus();
    
    logger.debug('GitHub API usage logged', {
      operation,
      result,
      remainingTokens: status.remainingTokens,
      queueLength: status.queueLength,
      authenticated: this.isAuthenticated,
      error: error?.message
    });

    // Log warning if getting close to rate limits
    if (status.remainingTokens < 100 && this.isAuthenticated) {
      logger.warn('Approaching GitHub API rate limit', {
        operation,
        remainingTokens: status.remainingTokens,
        currentLimit: status.currentLimit,
        recommendation: 'Consider reducing API usage frequency'
      });
    } else if (status.remainingTokens < 10 && !this.isAuthenticated) {
      logger.warn('Approaching GitHub API rate limit (unauthenticated)', {
        operation,
        remainingTokens: status.remainingTokens,
        currentLimit: status.currentLimit,
        recommendation: 'Consider authenticating for higher rate limits'
      });
    }
  }

  /**
   * Clear the request queue (for testing or emergency situations)
   */
  clearQueue(): void {
    const clearedCount = this.requestQueue.length;
    
    // Reject all pending requests
    this.requestQueue.forEach(request => {
      request.reject(new Error('Request queue cleared'));
    });
    
    this.requestQueue = [];
    
    logger.info('GitHub API request queue cleared', { clearedCount });
  }

  /**
   * Reset the rate limiter (for testing)
   */
  reset(): void {
    this.rateLimiter.reset();
    this.clearQueue();
    this.processing = false;
    logger.info('GitHub rate limiter reset');
  }
}

// Singleton instance for global use
export const githubRateLimiter = new GitHubRateLimiter();