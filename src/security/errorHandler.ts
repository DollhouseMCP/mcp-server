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

    // Remove absolute file paths (both Unix and Windows)
    let sanitized = message
      .replace(/\/(?:Users|home|var|etc|opt|usr)\/[^\s]+/gi, '[PATH]')
      .replace(/[A-Z]:\\[^\s]+/gi, '[PATH]')
      .replace(/\\\\[^\s]+/gi, '[PATH]');

    // Remove file URLs
    sanitized = sanitized.replace(/file:\/\/[^\s]+/gi, '[FILE]');

    // Remove potential IP addresses
    sanitized = sanitized.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]');

    // Remove potential ports
    sanitized = sanitized.replace(/:\d{4,5}\b/g, ':[PORT]');

    // Remove home directory references
    sanitized = sanitized.replace(/~\/[^\s]+/g, '[HOME]/...');

    // Remove potential usernames from paths
    sanitized = sanitized.replace(/\/(?:Users|home)\/[^\/\s]+/gi, '/[USER]');

    // Remove temp directory paths
    sanitized = sanitized.replace(/\/tmp\/[^\s]+/gi, '[TEMP]');
    sanitized = sanitized.replace(/\/var\/folders\/[^\s]+/gi, '[TEMP]');

    // Remove potential environment variables
    sanitized = sanitized.replace(/\$[A-Z_][A-Z0-9_]*/g, '[ENV]');

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