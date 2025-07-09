/**
 * Security-specific error class for DollhouseMCP
 * 
 * Used to indicate security violations, validation failures,
 * and other security-related issues.
 */

export class SecurityError extends Error {
  public readonly code: string;
  public readonly severity: 'low' | 'medium' | 'high' | 'critical';
  public readonly details?: Record<string, any>;

  constructor(
    message: string,
    code: string = 'SECURITY_VIOLATION',
    severity: 'low' | 'medium' | 'high' | 'critical' = 'high',
    details?: Record<string, any>
  ) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
    this.severity = severity;
    this.details = details;

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SecurityError);
    }
  }

  /**
   * Creates a SecurityError for content validation failures
   */
  static contentValidation(message: string, patterns?: string[]): SecurityError {
    return new SecurityError(
      message,
      'CONTENT_VALIDATION_FAILED',
      'high',
      { detectedPatterns: patterns }
    );
  }

  /**
   * Creates a SecurityError for YAML injection attempts
   */
  static yamlInjection(message: string): SecurityError {
    return new SecurityError(
      message,
      'YAML_INJECTION_DETECTED',
      'critical'
    );
  }

  /**
   * Creates a SecurityError for path traversal attempts
   */
  static pathTraversal(message: string, path?: string): SecurityError {
    return new SecurityError(
      message,
      'PATH_TRAVERSAL_DETECTED',
      'high',
      { attemptedPath: path }
    );
  }

  /**
   * Creates a SecurityError for token validation failures
   */
  static tokenValidation(message: string): SecurityError {
    return new SecurityError(
      message,
      'TOKEN_VALIDATION_FAILED',
      'high'
    );
  }
}