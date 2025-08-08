/**
 * Tests for ErrorHandler utility
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ErrorHandler, ErrorCategory, ApplicationError } from '../../../../src/utils/ErrorHandler.js';
import { logger } from '../../../../src/utils/logger.js';

describe('ErrorHandler', () => {
  // Store original logger methods
  const originalDebug = logger.debug;
  const originalInfo = logger.info;
  const originalWarn = logger.warn;
  const originalError = logger.error;
  
  beforeEach(() => {
    // Replace logger methods with spies
    logger.debug = jest.fn();
    logger.info = jest.fn();
    logger.warn = jest.fn();
    logger.error = jest.fn();
  });
  
  afterEach(() => {
    // Restore original logger methods
    logger.debug = originalDebug;
    logger.info = originalInfo;
    logger.warn = originalWarn;
    logger.error = originalError;
    jest.clearAllMocks();
  });

  describe('ApplicationError', () => {
    it('should create error with default category', () => {
      const error = new ApplicationError('Test error');
      expect(error.message).toBe('Test error');
      expect(error.category).toBe(ErrorCategory.SYSTEM_ERROR);
      expect(error.code).toBeUndefined();
      expect(error.details).toBeUndefined();
    });

    it('should create error with all properties', () => {
      const originalError = new Error('Original');
      const error = new ApplicationError(
        'Test error',
        ErrorCategory.NETWORK_ERROR,
        'NETWORK_TIMEOUT',
        { url: 'https://api.example.com' },
        originalError
      );
      
      expect(error.message).toBe('Test error');
      expect(error.category).toBe(ErrorCategory.NETWORK_ERROR);
      expect(error.code).toBe('NETWORK_TIMEOUT');
      expect(error.details).toEqual({ url: 'https://api.example.com' });
      expect(error.originalError).toBe(originalError);
    });

    it('should preserve stack trace from original error', () => {
      const originalError = new Error('Original');
      const error = new ApplicationError('Wrapped error', ErrorCategory.SYSTEM_ERROR, undefined, undefined, originalError);
      
      expect(error.stack).toContain('Caused by:');
      expect(error.stack).toContain('Original');
    });
  });

  describe('extractErrorInfo', () => {
    it('should extract info from ApplicationError', () => {
      const error = new ApplicationError(
        'App error',
        ErrorCategory.AUTH_ERROR,
        'AUTH_FAILED',
        { userId: '123' }
      );
      
      const info = ErrorHandler.extractErrorInfo(error);
      
      expect(info.message).toBe('App error');
      expect(info.category).toBe(ErrorCategory.AUTH_ERROR);
      expect(info.code).toBe('AUTH_FAILED');
      expect(info.details).toEqual({ userId: '123' });
      expect(info.stack).toBeDefined();
    });

    it('should extract info from standard Error', () => {
      const error = new Error('Standard error');
      const info = ErrorHandler.extractErrorInfo(error);
      
      expect(info.message).toBe('Standard error');
      expect(info.category).toBe(ErrorCategory.SYSTEM_ERROR);
      expect(info.stack).toBeDefined();
      expect(info.originalError).toBe(error);
    });

    it('should handle string errors', () => {
      const info = ErrorHandler.extractErrorInfo('String error');
      
      expect(info.message).toBe('String error');
      expect(info.category).toBe(ErrorCategory.SYSTEM_ERROR);
      expect(info.stack).toBeUndefined();
    });

    it('should handle unknown errors', () => {
      const info = ErrorHandler.extractErrorInfo({ custom: 'object' });
      
      expect(info.message).toBe('An unknown error occurred');
      expect(info.category).toBe(ErrorCategory.SYSTEM_ERROR);
      expect(info.details).toEqual({ custom: 'object' });
    });

    it('should truncate long stack traces', () => {
      // Create an error with a very long stack trace
      const error = new Error('Test');
      const longStack = Array(50).fill('at someFunction (file.js:1:1)').join('\n');
      error.stack = `Error: Test\n${longStack}`;
      
      const info = ErrorHandler.extractErrorInfo(error);
      
      expect(info.stack).toContain('(truncated)');
      expect(info.stack!.split('\n').length).toBeLessThanOrEqual(11); // MAX_STACK_DEPTH + truncation message
    });
  });

  describe('getUserMessage', () => {
    it('should return user-friendly message for AUTH_ERROR', () => {
      const error = new ApplicationError('Invalid token', ErrorCategory.AUTH_ERROR);
      const message = ErrorHandler.getUserMessage(error);
      
      expect(message).toBe('Authentication error: Invalid token');
    });

    it('should return user-friendly message for VALIDATION_ERROR', () => {
      const error = new ApplicationError('Invalid email', ErrorCategory.VALIDATION_ERROR);
      const message = ErrorHandler.getUserMessage(error);
      
      expect(message).toBe('Validation error: Invalid email');
    });

    it('should return user-friendly message for NETWORK_ERROR', () => {
      const error = new ApplicationError('Connection failed', ErrorCategory.NETWORK_ERROR);
      const message = ErrorHandler.getUserMessage(error);
      
      expect(message).toBe('Network error: Connection failed. Please check your connection and try again.');
    });

    it('should return original message for USER_ERROR', () => {
      const error = new ApplicationError('File not found', ErrorCategory.USER_ERROR);
      const message = ErrorHandler.getUserMessage(error);
      
      expect(message).toBe('File not found');
    });

    it('should return generic message for SYSTEM_ERROR', () => {
      const error = new ApplicationError('Internal error', ErrorCategory.SYSTEM_ERROR);
      const message = ErrorHandler.getUserMessage(error);
      
      expect(message).toBe('An unexpected error occurred. Please try again later.');
    });
  });

  describe('logError', () => {
    it('should log USER_ERROR as warning', () => {
      const error = new ApplicationError('User mistake', ErrorCategory.USER_ERROR);
      
      ErrorHandler.logError('test.context', error);
      
      expect(logger.warn).toHaveBeenCalledWith(
        'test.context: User mistake',
        expect.objectContaining({
          context: 'test.context',
          category: ErrorCategory.USER_ERROR,
          message: 'User mistake'
        })
      );
    });

    it('should log VALIDATION_ERROR as warning', () => {
      const error = new ApplicationError('Invalid input', ErrorCategory.VALIDATION_ERROR);
      
      ErrorHandler.logError('test.validation', error);
      
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should log AUTH_ERROR as warning', () => {
      const error = new ApplicationError('Auth failed', ErrorCategory.AUTH_ERROR);
      
      ErrorHandler.logError('test.auth', error);
      
      expect(logger.warn).toHaveBeenCalledWith(
        'test.auth: Authentication error',
        expect.objectContaining({
          context: 'test.auth',
          category: ErrorCategory.AUTH_ERROR
        })
      );
    });

    it('should log NETWORK_ERROR as error with stack', () => {
      const error = new ApplicationError('Network failed', ErrorCategory.NETWORK_ERROR);
      
      ErrorHandler.logError('test.network', error);
      
      expect(logger.error).toHaveBeenCalledWith(
        'test.network: Network error',
        expect.objectContaining({
          context: 'test.network',
          category: ErrorCategory.NETWORK_ERROR,
          stack: expect.any(String)
        })
      );
    });

    it('should log SYSTEM_ERROR as error with stack and details', () => {
      const error = new ApplicationError('System failed', ErrorCategory.SYSTEM_ERROR);
      
      ErrorHandler.logError('test.system', error);
      
      expect(logger.error).toHaveBeenCalledWith(
        'test.system: System error',
        expect.objectContaining({
          context: 'test.system',
          category: ErrorCategory.SYSTEM_ERROR,
          stack: expect.any(String)
        })
      );
    });

    it('should include additional info in log', () => {
      const error = new Error('Test error');
      
      ErrorHandler.logError('test.context', error, { requestId: '123', userId: '456' });
      
      expect(logger.error).toHaveBeenCalledWith(
        'test.context: System error',
        expect.objectContaining({
          requestId: '123',
          userId: '456'
        })
      );
    });

    it('should log stack trace in debug mode', () => {
      const error = new Error('Test error');
      
      ErrorHandler.logError('test.debug', error);
      
      expect(logger.debug).toHaveBeenCalledWith(
        'test.debug - Stack trace:',
        expect.objectContaining({
          stack: expect.any(String)
        })
      );
    });
  });

  describe('createError', () => {
    it('should create error with default category', () => {
      const error = ErrorHandler.createError('Test message');
      
      expect(error).toBeInstanceOf(ApplicationError);
      expect(error.message).toBe('Test message');
      expect(error.category).toBe(ErrorCategory.SYSTEM_ERROR);
    });

    it('should create error with specified properties', () => {
      const originalError = new Error('Original');
      const error = ErrorHandler.createError(
        'Wrapped message',
        ErrorCategory.NETWORK_ERROR,
        'TIMEOUT',
        originalError
      );
      
      expect(error.message).toBe('Wrapped message');
      expect(error.category).toBe(ErrorCategory.NETWORK_ERROR);
      expect(error.code).toBe('TIMEOUT');
      expect(error.originalError).toBe(originalError);
    });
  });

  describe('wrapError', () => {
    it('should wrap error with context', () => {
      const originalError = new Error('Original error');
      const wrapped = ErrorHandler.wrapError(
        originalError,
        'Failed to process request',
        ErrorCategory.NETWORK_ERROR
      );
      
      expect(wrapped).toBeInstanceOf(ApplicationError);
      expect(wrapped.message).toBe('Failed to process request: Original error');
      expect(wrapped.category).toBe(ErrorCategory.NETWORK_ERROR);
      expect(wrapped.originalError).toBe(originalError);
    });

    it('should preserve category if not specified', () => {
      const originalError = new ApplicationError('Original', ErrorCategory.AUTH_ERROR);
      const wrapped = ErrorHandler.wrapError(originalError, 'Authentication failed');
      
      expect(wrapped.category).toBe(ErrorCategory.AUTH_ERROR);
    });
  });

  describe('isErrorCategory', () => {
    it('should correctly identify error category', () => {
      const authError = new ApplicationError('Auth', ErrorCategory.AUTH_ERROR);
      const networkError = new ApplicationError('Network', ErrorCategory.NETWORK_ERROR);
      
      expect(ErrorHandler.isErrorCategory(authError, ErrorCategory.AUTH_ERROR)).toBe(true);
      expect(ErrorHandler.isErrorCategory(authError, ErrorCategory.NETWORK_ERROR)).toBe(false);
      expect(ErrorHandler.isErrorCategory(networkError, ErrorCategory.NETWORK_ERROR)).toBe(true);
    });

    it('should handle non-ApplicationError', () => {
      const error = new Error('Standard error');
      
      expect(ErrorHandler.isErrorCategory(error, ErrorCategory.SYSTEM_ERROR)).toBe(true);
      expect(ErrorHandler.isErrorCategory(error, ErrorCategory.AUTH_ERROR)).toBe(false);
    });
  });

  describe('formatForResponse', () => {
    it('should format error for API response', () => {
      const error = new ApplicationError(
        'Validation failed',
        ErrorCategory.VALIDATION_ERROR,
        'INVALID_EMAIL'
      );
      
      const response = ErrorHandler.formatForResponse(error);
      
      expect(response).toEqual({
        success: false,
        message: 'Validation error: Validation failed',
        error: 'INVALID_EMAIL',
        details: undefined // Not in development mode
      });
    });

    it('should include details in development mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      
      const error = new ApplicationError(
        'Error with details',
        ErrorCategory.SYSTEM_ERROR,
        'SYS_001',
        { debug: 'info' }
      );
      
      const response = ErrorHandler.formatForResponse(error);
      
      expect(response.details).toEqual({ debug: 'info' });
      
      process.env.NODE_ENV = originalEnv;
    });

    it('should use category as error code if no code provided', () => {
      const error = new ApplicationError('Auth failed', ErrorCategory.AUTH_ERROR);
      
      const response = ErrorHandler.formatForResponse(error);
      
      expect(response.error).toBe(ErrorCategory.AUTH_ERROR);
    });
  });

  describe('stack trace truncation', () => {
    it('should truncate very long stack traces', () => {
      const originalError = new Error('Deep error');
      // Create a very long stack
      const longStack = Array(100).fill('at function (file.js:1:1)').join('\n');
      originalError.stack = `Error: Deep error\n${longStack}`;
      
      const error = new ApplicationError('Wrapped', ErrorCategory.SYSTEM_ERROR, undefined, undefined, originalError);
      
      // Check that stack was truncated
      expect(error.stack).toContain('(truncated)');
      
      // Extract info should also have truncated stack
      const info = ErrorHandler.extractErrorInfo(error);
      expect(info.stack).toContain('(truncated)');
    });

    it('should handle missing stack gracefully', () => {
      const error = { message: 'No stack' };
      const info = ErrorHandler.extractErrorInfo(error);
      
      expect(info.stack).toBeUndefined();
    });
  });
});