/**
 * Security-related error classes
 */

export class SecurityError extends Error {
  public readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
    // Maintains proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, SecurityError.prototype);
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class TimeoutError extends SecurityError {
  constructor(message: string = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}