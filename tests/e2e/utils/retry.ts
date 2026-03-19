/**
 * Retry utility with exponential backoff for E2E tests
 */

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/**
 * Retry a function with exponential backoff
 * @param fn Function to retry
 * @param options Retry options
 * @returns Result of successful function execution
 * @throws Last error if all attempts fail
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    backoffMultiplier = 2,
    onRetry
  } = options;

  let lastError: Error | undefined;
  let delayMs = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === maxAttempts) {
        throw lastError;
      }

      // Calculate next delay with exponential backoff and jitter
      // Add 20% jitter to help prevent thundering herd in CI
      const jitterFactor = 0.8 + Math.random() * 0.4; // 80% to 120% of delay
      const currentDelay = Math.min(Math.floor(delayMs * jitterFactor), maxDelayMs);

      if (onRetry) {
        onRetry(attempt, lastError, currentDelay);
      }

      // Wait before next attempt
      await new Promise(resolve => setTimeout(resolve, currentDelay));
      
      // Increase delay for next attempt
      delayMs = Math.min(delayMs * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Check if an error is retryable
 * @param error The error to check
 * @returns True if the error is retryable
 */
export function isRetryableError(error: any): boolean {
  // Network errors
  if (error.code === 'ECONNRESET' || 
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND') {
    return true;
  }

  // HTTP status codes that are retryable
  if (error.status) {
    const status = error.status;
    // 429 Too Many Requests, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout
    if (status === 429 || status === 502 || status === 503 || status === 504) {
      return true;
    }
    // GitHub specific: 409 Conflict can happen in parallel CI runs when SHA changes
    if (status === 409 && error.message?.includes('is at')) {
      return true;
    }
    // GitHub specific: 422 can sometimes be transient
    if (status === 422 && error.message?.includes('is at')) {
      return true;
    }
  }

  // GitHub API specific errors
  if (error.message) {
    const msg = error.message.toLowerCase();
    if (msg.includes('rate limit') ||
        msg.includes('timeout') ||
        msg.includes('econnreset') ||
        msg.includes('socket hang up')) {
      return true;
    }
  }

  return false;
}

/**
 * Retry only if the error is retryable
 * @param fn Function to retry
 * @param options Retry options
 * @returns Result of successful function execution
 * @throws Error if non-retryable or all attempts fail
 */
export async function retryIfRetryable<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isRetryableError(error)) {
      throw error;
    }
    return retryWithBackoff(fn, options);
  }
}