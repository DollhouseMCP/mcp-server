/**
 * Centralized error handling utilities for consistent error processing
 * Preserves stack traces and provides user-friendly messages
 */

import { logger } from './logger.js';

/**
 * Error categories for better error handling
 */
export enum ErrorCategory {
  USER_ERROR = 'USER_ERROR',        // User input issues
  SYSTEM_ERROR = 'SYSTEM_ERROR',    // Internal system failures
  NETWORK_ERROR = 'NETWORK_ERROR',  // API/network issues
  AUTH_ERROR = 'AUTH_ERROR',        // Authentication/authorization
  VALIDATION_ERROR = 'VALIDATION_ERROR' // Validation failures
}

/**
 * Structured error information
 */
export interface ErrorInfo {
  message: string;
  category: ErrorCategory;
  code?: string;
  details?: Record<string, unknown>;
  stack?: string;
  originalError?: Error;
}

/**
 * Custom error class with additional context
 */
export class ApplicationError extends Error {
  public readonly category: ErrorCategory;
  public readonly code?: string;
  public readonly details?: Record<string, unknown>;
  public readonly originalError?: Error;

  constructor(
    message: string,
    category: ErrorCategory = ErrorCategory.SYSTEM_ERROR,
    code?: string,
    details?: Record<string, unknown>,
    originalError?: Error
  ) {
    super(message);
    this.name = 'ApplicationError';
    this.category = category;
    this.code = code;
    this.details = details;
    this.originalError = originalError;

    // Maintain proper stack trace with truncation to prevent memory issues
    if (originalError?.stack) {
      const truncatedOriginalStack = ErrorHandler.truncateStack(originalError.stack);
      this.stack = `${this.stack}\nCaused by: ${truncatedOriginalStack}`;
    }
  }
}

/**
 * Utility class for consistent error handling
 */
export class ErrorHandler {
  /**
   * Maximum stack trace depth to prevent memory issues
   */
  private static readonly MAX_STACK_DEPTH = 10;
  
  /**
   * Maximum length for stack trace strings
   */
  private static readonly MAX_STACK_LENGTH = 5000;
  
  /**
   * Truncate stack trace to prevent memory issues
   */
  private static truncateStack(stack?: string): string | undefined {
    if (!stack) return undefined;
    
    // Limit total length
    if (stack.length > this.MAX_STACK_LENGTH) {
      stack = stack.substring(0, this.MAX_STACK_LENGTH) + '\n... (truncated)';
    }
    
    // Limit number of stack frames
    const lines = stack.split('\n');
    if (lines.length > this.MAX_STACK_DEPTH) {
      return lines.slice(0, this.MAX_STACK_DEPTH).join('\n') + '\n... (truncated)';
    }
    
    return stack;
  }
  
  /**
   * Extract error information while preserving context
   */
  static extractErrorInfo(error: unknown): ErrorInfo {
    // Handle ApplicationError
    if (error instanceof ApplicationError) {
      return {
        message: error.message,
        category: error.category,
        code: error.code,
        details: error.details,
        stack: this.truncateStack(error.stack),
        originalError: error.originalError
      };
    }

    // Handle standard Error
    if (error instanceof Error) {
      return {
        message: error.message,
        category: ErrorCategory.SYSTEM_ERROR,
        stack: this.truncateStack(error.stack),
        originalError: error
      };
    }

    // Handle string errors
    if (typeof error === 'string') {
      return {
        message: error,
        category: ErrorCategory.SYSTEM_ERROR
      };
    }

    // Handle unknown errors
    return {
      message: 'An unknown error occurred',
      category: ErrorCategory.SYSTEM_ERROR,
      details: error
    };
  }

  /**
   * Get user-friendly error message
   */
  static getUserMessage(error: unknown): string {
    const errorInfo = this.extractErrorInfo(error);
    
    // Provide user-friendly messages based on category
    switch (errorInfo.category) {
      case ErrorCategory.AUTH_ERROR:
        return `Authentication error: ${errorInfo.message}`;
      case ErrorCategory.VALIDATION_ERROR:
        return `Validation error: ${errorInfo.message}`;
      case ErrorCategory.NETWORK_ERROR:
        return `Network error: ${errorInfo.message}. Please check your connection and try again.`;
      case ErrorCategory.USER_ERROR:
        return errorInfo.message; // User errors should already be user-friendly
      default:
        // For system errors, provide a generic message
        return 'An unexpected error occurred. Please try again later.';
    }
  }

  /**
   * Log error with appropriate level and context
   */
  static logError(
    context: string,
    error: unknown,
    additionalInfo?: Record<string, unknown>
  ): void {
    const errorInfo = this.extractErrorInfo(error);
    
    const logData = {
      context,
      category: errorInfo.category,
      code: errorInfo.code,
      message: errorInfo.message,
      ...additionalInfo
    };

    // Log based on category
    switch (errorInfo.category) {
      case ErrorCategory.USER_ERROR:
      case ErrorCategory.VALIDATION_ERROR:
        logger.warn(`${context}: ${errorInfo.message}`, logData);
        break;
      case ErrorCategory.AUTH_ERROR:
        logger.warn(`${context}: Authentication error`, logData);
        break;
      case ErrorCategory.NETWORK_ERROR:
        logger.error(`${context}: Network error`, {
          ...logData,
          stack: errorInfo.stack
        });
        break;
      default:
        logger.error(`${context}: System error`, {
          ...logData,
          stack: errorInfo.stack,
          details: errorInfo.details
        });
    }

    // Log stack trace in debug mode for all errors (already truncated)
    if (errorInfo.stack) {
      logger.debug(`${context} - Stack trace:`, { stack: errorInfo.stack });
    }
  }

  /**
   * Create an error with context preservation
   */
  static createError(
    message: string,
    category: ErrorCategory = ErrorCategory.SYSTEM_ERROR,
    code?: string,
    originalError?: unknown
  ): ApplicationError {
    const original = originalError instanceof Error ? originalError : undefined;
    return new ApplicationError(message, category, code, undefined, original);
  }

  /**
   * Wrap an error with additional context
   */
  static wrapError(
    error: unknown,
    context: string,
    category?: ErrorCategory
  ): ApplicationError {
    const errorInfo = this.extractErrorInfo(error);
    return new ApplicationError(
      `${context}: ${errorInfo.message}`,
      category || errorInfo.category,
      errorInfo.code,
      errorInfo.details,
      errorInfo.originalError
    );
  }

  /**
   * Check if error is of a specific category
   */
  static isErrorCategory(error: unknown, category: ErrorCategory): boolean {
    const errorInfo = this.extractErrorInfo(error);
    return errorInfo.category === category;
  }

  /**
   * Format error for API response
   */
  static formatForResponse(error: unknown): {
    success: false;
    message: string;
    error: string;
    details?: Record<string, unknown>;
  } {
    const errorInfo = this.extractErrorInfo(error);
    const userMessage = this.getUserMessage(error);
    
    return {
      success: false,
      message: userMessage,
      error: errorInfo.code || errorInfo.category,
      // Only include details in development
      details: process.env.NODE_ENV === 'development' ? errorInfo.details : undefined
    };
  }
}