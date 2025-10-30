/**
 * AutoLoadError - Structured error type for auto-load memory failures
 *
 * Provides detailed context about memory auto-load failures including:
 * - Memory name that failed
 * - Phase where failure occurred (load/validate/budget)
 * - Descriptive error message
 *
 * Factory methods provide convenient creation for common scenarios.
 */

export class AutoLoadError extends Error {
  public readonly memoryName: string;
  public readonly phase: 'load' | 'validate' | 'budget';

  constructor(
    message: string,
    memoryName: string,
    phase: 'load' | 'validate' | 'budget'
  ) {
    super(message);
    this.name = 'AutoLoadError';
    this.memoryName = memoryName;
    this.phase = phase;

    // Maintains proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AutoLoadError);
    }
  }

  /**
   * Create error for memory load failures
   */
  static loadFailed(memoryName: string, reason: string): AutoLoadError {
    return new AutoLoadError(
      `Failed to load memory: ${reason}`,
      memoryName,
      'load'
    );
  }

  /**
   * Create error for memory validation failures
   */
  static validationFailed(memoryName: string, reason: string): AutoLoadError {
    return new AutoLoadError(
      `Memory validation failed: ${reason}`,
      memoryName,
      'validate'
    );
  }

  /**
   * Create error for budget constraint violations
   */
  static budgetExceeded(memoryName: string, tokens: number, budget: number): AutoLoadError {
    return new AutoLoadError(
      `Memory exceeds token budget (${tokens} > ${budget} tokens)`,
      memoryName,
      'budget'
    );
  }
}
