/**
 * SecureErrorHandler - Sanitizes error messages to prevent information disclosure
 * 
 * SECURITY: Addresses Issue #206 - Information Disclosure via Error Messages
 * - Prevents exposure of file paths, system details, and internal structure
 * - Maps system errors to safe user-friendly messages
 * - Preserves full error details for secure logging
 * - Different behavior for production vs development environments
 */

import { logger } from '../utils/logger.js';

export interface SanitizedError {
  message: string;
  code?: string;
  requestId?: string;
}

export class SecureErrorHandler {
  // Pre-compiled regex patterns for better performance
  private static readonly SANITIZATION_PATTERNS = {
    UNIX_PATHS: /\/(?:Users|home|var|etc|opt|usr)\/[^\s]+/gi,
    WINDOWS_PATHS: /[A-Z]:\\[^\s]+/gi,
    UNC_PATHS: /\\\\[^\s]+/gi,
    FILE_URLS: /file:\/\/\/?[^\s]+/gi,
    IP_ADDRESSES: /\b(?:(?:\d{1,3}\.){3}\d{1,3}|(?:0\d{1,2}\.){3}0\d{1,2})\b/g,
    PORTS: /:\d{4,5}\b/g,
    HOME_DIRS: /~\/[^\s]+/g,
    USER_PATHS: /\/(?:Users|home)\/[^\/\s]+/gi,
    TEMP_PATHS: /\/(?:tmp|var\/folders)\/[^\s]+/gi,
    ENV_VARS: /\$[A-Z_][A-Z0-9_]*/g,
  };
  
  private static readonly ERROR_MAP: Record<string, string> = {
    // File system errors
    'ENOENT': 'Resource not found',
    'EACCES': 'Access denied',
    'EEXIST': 'Resource already exists',
    'EISDIR': 'Invalid operation on directory',
    'EMFILE': 'System resource limit reached',
    'ENOMEM': 'Insufficient memory available',
    'ENOSPC': 'Insufficient storage space',
    'EPERM': 'Operation not permitted',
    'EROFS': 'Read-only file system',
    
    // Network errors
    'ECONNREFUSED': 'Connection refused',
    'ECONNRESET': 'Connection reset',
    'ETIMEDOUT': 'Operation timed out',
    'ENOTFOUND': 'Service not found',
    
    // Application errors
    'INVALID_INPUT': 'Invalid input provided',
    'VALIDATION_ERROR': 'Validation failed',
    'NOT_FOUND': 'Resource not found',
    'UNAUTHORIZED': 'Authentication required',
    'FORBIDDEN': 'Access forbidden',
    'RATE_LIMITED': 'Too many requests',
  };

  /**
   * Sanitize an error for safe display to users
   */
  static sanitizeError(error: any, requestId?: string): SanitizedError {
    // Input validation
    if (error === null || error === undefined) {
      return {
        message: process.env.NODE_ENV === 'production' 
          ? 'An error occurred processing your request.'
          : 'An unknown error occurred',
        code: 'UNKNOWN_ERROR',
        requestId
      };
    }
    // Log the full error securely for debugging
    logger.error('Error occurred:', {
      error: error,
      stack: error?.stack,
      code: error?.code,
      requestId
    });

    // Production mode: Return only safe messages
    if (process.env.NODE_ENV === 'production') {
      return {
        message: this.getSafeErrorMessage(error),
        code: error?.code || 'INTERNAL_ERROR',
        requestId
      };
    }

    // Development mode: Return sanitized but more detailed messages
    return {
      message: this.sanitizeErrorMessage(error?.message || String(error)),
      code: error?.code || 'UNKNOWN_ERROR',
      requestId
    };
  }

  /**
   * Get a safe, user-friendly error message
   */
  private static getSafeErrorMessage(error: any): string {
    // Check for known error codes
    if (error?.code && this.ERROR_MAP[error.code]) {
      return this.ERROR_MAP[error.code];
    }

    // Check for common error types
    if (error?.name === 'ValidationError') {
      return 'Validation failed. Please check your input.';
    }
    
    if (error?.name === 'TypeError') {
      return 'Invalid operation requested.';
    }
    
    if (error?.name === 'RangeError') {
      return 'Value out of acceptable range.';
    }

    // Default safe message
    return 'An error occurred processing your request.';
  }

  /**
   * Sanitize error messages to remove sensitive information
   */
  private static sanitizeErrorMessage(message: string): string {
    if (!message) return 'Unknown error';

    // Use pre-compiled patterns for better performance
    // Apply more specific patterns first to avoid conflicts
    let sanitized = message;
    
    // Remove temp directory paths BEFORE general paths
    sanitized = sanitized.replace(this.SANITIZATION_PATTERNS.TEMP_PATHS, '[TEMP]');
    
    // Remove other specific paths
    sanitized = sanitized
      .replace(this.SANITIZATION_PATTERNS.UNIX_PATHS, '[PATH]')
      .replace(this.SANITIZATION_PATTERNS.WINDOWS_PATHS, '[PATH]')
      .replace(this.SANITIZATION_PATTERNS.UNC_PATHS, '[PATH]');

    // Remove file URLs (including Windows file:///c:/ format)
    sanitized = sanitized.replace(this.SANITIZATION_PATTERNS.FILE_URLS, '[FILE]');

    // Remove potential IP addresses (including zero-padded)
    sanitized = sanitized.replace(this.SANITIZATION_PATTERNS.IP_ADDRESSES, '[IP]');

    // Remove potential ports
    sanitized = sanitized.replace(this.SANITIZATION_PATTERNS.PORTS, ':[PORT]');

    // Remove home directory references
    sanitized = sanitized.replace(this.SANITIZATION_PATTERNS.HOME_DIRS, '[HOME]/...');

    // Remove potential usernames from paths
    sanitized = sanitized.replace(this.SANITIZATION_PATTERNS.USER_PATHS, '/[USER]');

    // Remove potential environment variables
    sanitized = sanitized.replace(this.SANITIZATION_PATTERNS.ENV_VARS, '[ENV]');

    // Limit message length to prevent verbose error dumps
    if (sanitized.length > 500) {
      sanitized = sanitized.substring(0, 497) + '...';
    }

    return sanitized;
  }

  /**
   * Create a user-friendly error response
   */
  static createErrorResponse(error: any, requestId?: string): {
    success: false;
    error: SanitizedError;
  } {
    return {
      success: false,
      error: this.sanitizeError(error, requestId)
    };
  }

  /**
   * Wrap an async function with error handling
   */
  static wrapAsync<T extends (...args: any[]) => Promise<any>>(
    fn: T,
    context?: string
  ): T {
    return (async (...args: Parameters<T>) => {
      try {
        return await fn(...args);
      } catch (error) {
        const sanitized = this.sanitizeError(error);
        throw new Error(
          context 
            ? `${context}: ${sanitized.message}`
            : sanitized.message
        );
      }
    }) as T;
  }
}