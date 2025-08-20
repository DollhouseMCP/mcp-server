/**
 * Portfolio Tool Configuration Constants
 * 
 * Centralized configuration for timeout values, file size limits,
 * retry behavior, and other portfolio-related constants.
 * 
 * All values can be overridden via environment variables for flexibility.
 */

/**
 * Portfolio element metadata interface for type safety
 */
export interface PortfolioElementMetadata {
  name: string;
  description: string;
  author: string;
  created: string;
  updated: string;
  version: string;
}

/**
 * GitHub API timeout configuration
 * Used for collection submission API calls
 */
export const GITHUB_API_TIMEOUT = {
  // Default timeout for GitHub API requests (milliseconds)
  DEFAULT: parseInt(process.env.DOLLHOUSE_GITHUB_API_TIMEOUT || '30000'),
  
  // Minimum allowed timeout (5 seconds)
  MIN: 5000,
  
  // Maximum allowed timeout (5 minutes)
  MAX: 300000
} as const;

/**
 * File size limits for portfolio submissions
 */
export const FILE_SIZE_LIMITS = {
  // Maximum file size for portfolio submissions (10MB)
  MAX_FILE_SIZE: parseInt(process.env.DOLLHOUSE_MAX_FILE_SIZE || String(10 * 1024 * 1024)),
  
  // Human-readable description of the limit
  MAX_FILE_SIZE_MB: 10
} as const;

/**
 * Retry configuration for API operations
 */
export const RETRY_CONFIG = {
  // Maximum number of retry attempts
  MAX_ATTEMPTS: parseInt(process.env.DOLLHOUSE_MAX_RETRY_ATTEMPTS || '3'),
  
  // Initial delay between retries (milliseconds)
  INITIAL_DELAY: parseInt(process.env.DOLLHOUSE_INITIAL_RETRY_DELAY || '1000'),
  
  // Maximum delay between retries (milliseconds)
  MAX_DELAY: parseInt(process.env.DOLLHOUSE_MAX_RETRY_DELAY || '5000'),
  
  // Backoff multiplier for exponential backoff
  BACKOFF_MULTIPLIER: 2
} as const;

/**
 * Search and similarity matching configuration
 */
export const SEARCH_CONFIG = {
  // Minimum similarity score for name suggestions (0.0 to 1.0)
  MIN_SIMILARITY_SCORE: parseFloat(process.env.DOLLHOUSE_MIN_SIMILARITY || '0.3'),
  
  // Maximum number of suggestions to return
  MAX_SUGGESTIONS: parseInt(process.env.DOLLHOUSE_MAX_SUGGESTIONS || '5')
} as const;

/**
 * Environment variable names for documentation
 */
export const ENV_VARS = {
  GITHUB_API_TIMEOUT: 'DOLLHOUSE_GITHUB_API_TIMEOUT',
  MAX_FILE_SIZE: 'DOLLHOUSE_MAX_FILE_SIZE',
  MAX_RETRY_ATTEMPTS: 'DOLLHOUSE_MAX_RETRY_ATTEMPTS',
  INITIAL_RETRY_DELAY: 'DOLLHOUSE_INITIAL_RETRY_DELAY',
  MAX_RETRY_DELAY: 'DOLLHOUSE_MAX_RETRY_DELAY',
  MIN_SIMILARITY: 'DOLLHOUSE_MIN_SIMILARITY',
  MAX_SUGGESTIONS: 'DOLLHOUSE_MAX_SUGGESTIONS'
} as const;

/**
 * Validation helper to ensure timeout is within acceptable bounds
 */
export function getValidatedTimeout(): number {
  const timeout = GITHUB_API_TIMEOUT.DEFAULT;
  
  if (timeout < GITHUB_API_TIMEOUT.MIN) {
    return GITHUB_API_TIMEOUT.MIN;
  }
  
  if (timeout > GITHUB_API_TIMEOUT.MAX) {
    return GITHUB_API_TIMEOUT.MAX;
  }
  
  return timeout;
}

/**
 * GitHub API rate limiting configuration
 * Implements client-side rate limiting to respect GitHub's API limits
 */
export const GITHUB_API_RATE_LIMITS = {
  // GitHub API limits: 5000/hour authenticated, 60/hour unauthenticated
  AUTHENTICATED_LIMIT: parseInt(process.env.DOLLHOUSE_GITHUB_RATE_LIMIT_AUTH || '5000'),
  UNAUTHENTICATED_LIMIT: parseInt(process.env.DOLLHOUSE_GITHUB_RATE_LIMIT_UNAUTH || '60'),
  
  // Time window for rate limiting (1 hour)
  WINDOW_MS: 60 * 60 * 1000,
  
  // Minimum delay between API calls to prevent rapid-fire requests
  MIN_DELAY_MS: parseInt(process.env.DOLLHOUSE_GITHUB_MIN_DELAY || '1000'),
  
  // Buffer percentage - stay below actual limits to avoid hitting them
  BUFFER_PERCENTAGE: parseFloat(process.env.DOLLHOUSE_GITHUB_RATE_BUFFER || '0.9')
} as const;

/**
 * Calculate retry delay using exponential backoff
 */
export function calculateRetryDelay(attempt: number): number {
  const delay = Math.min(
    RETRY_CONFIG.INITIAL_DELAY * Math.pow(RETRY_CONFIG.BACKOFF_MULTIPLIER, attempt - 1),
    RETRY_CONFIG.MAX_DELAY
  );
  return delay;
}