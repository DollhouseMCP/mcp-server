/**
 * Tests for SecureErrorHandler
 * Verifies that sensitive information is properly sanitized from error messages
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { SecureErrorHandler } from '../../../../src/security/errorHandler.js';
import { logger } from '../../../../src/utils/logger.js';

// Mock the logger
jest.mock('../../../../src/utils/logger.js');

describe('SecureErrorHandler', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('sanitizeError', () => {
    it('should return safe messages in production mode', () => {
      process.env.NODE_ENV = 'production';
      
      const error = new Error('File not found: /Users/john/secret/data.txt');
      error.code = 'ENOENT';
      
      const result = SecureErrorHandler.sanitizeError(error);
      
      expect(result.message).toBe('Resource not found');
      expect(result.code).toBe('ENOENT');
      expect(result.message).not.toContain('/Users/john');
      expect(result.message).not.toContain('secret');
    });

    it('should sanitize paths in development mode', () => {
      process.env.NODE_ENV = 'development';
      
      const error = new Error('Cannot read file /home/user/project/secret.json');
      
      const result = SecureErrorHandler.sanitizeError(error);
      
      expect(result.message).toBe('Cannot read file [PATH]');
      expect(result.message).not.toContain('/home/user');
      expect(result.message).not.toContain('secret.json');
    });

    it('should sanitize Windows paths', () => {
      process.env.NODE_ENV = 'development';
      
      const error = new Error('Access denied: C:\\Users\\Admin\\Documents\\config.ini');
      
      const result = SecureErrorHandler.sanitizeError(error);
      
      expect(result.message).toBe('Access denied: [PATH]');
      expect(result.message).not.toContain('C:\\Users');
      expect(result.message).not.toContain('Admin');
    });

    it('should sanitize IP addresses', () => {
      process.env.NODE_ENV = 'development';
      
      const error = new Error('Connection failed to 192.168.1.100:8080');
      
      const result = SecureErrorHandler.sanitizeError(error);
      
      expect(result.message).toBe('Connection failed to [IP]:[PORT]');
    });

    it('should sanitize file URLs', () => {
      process.env.NODE_ENV = 'development';
      
      const error = new Error('Cannot load file://localhost/Users/test/data.db');
      
      const result = SecureErrorHandler.sanitizeError(error);
      
      expect(result.message).toBe('Cannot load [FILE]');
    });

    it('should sanitize environment variables', () => {
      process.env.NODE_ENV = 'development';
      
      const error = new Error('Missing $HOME or $USER environment variable');
      
      const result = SecureErrorHandler.sanitizeError(error);
      
      expect(result.message).toBe('Missing [ENV] or [ENV] environment variable');
    });

    it('should handle errors without messages', () => {
      process.env.NODE_ENV = 'production';
      
      const error = { code: 'EACCES' };
      
      const result = SecureErrorHandler.sanitizeError(error);
      
      expect(result.message).toBe('Access denied');
    });

    it('should truncate very long error messages', () => {
      process.env.NODE_ENV = 'development';
      
      const longMessage = 'Error: ' + 'x'.repeat(600);
      const error = new Error(longMessage);
      
      const result = SecureErrorHandler.sanitizeError(error);
      
      expect(result.message.length).toBe(500);
      expect(result.message).toEndWith('...');
    });

    it('should log full error details', () => {
      const error = new Error('Sensitive error');
      error.stack = 'Full stack trace';
      error.code = 'TEST_ERROR';
      
      SecureErrorHandler.sanitizeError(error, 'req-123');
      
      expect(logger.error).toHaveBeenCalledWith('Error occurred:', {
        error: error,
        stack: 'Full stack trace',
        code: 'TEST_ERROR',
        requestId: 'req-123'
      });
    });

    it('should handle null and undefined errors', () => {
      process.env.NODE_ENV = 'production';
      
      expect(SecureErrorHandler.sanitizeError(null).message)
        .toBe('An error occurred processing your request.');
      expect(SecureErrorHandler.sanitizeError(undefined).message)
        .toBe('An error occurred processing your request.');
    });

    it('should sanitize temp directory paths', () => {
      process.env.NODE_ENV = 'development';
      
      const error1 = new Error('Failed to write /tmp/node-12345/test.tmp');
      const result1 = SecureErrorHandler.sanitizeError(error1);
      expect(result1.message).toBe('Failed to write [TEMP]');
      
      const error2 = new Error('Cannot access /var/folders/y6/nj790rtn62l/T/test');
      const result2 = SecureErrorHandler.sanitizeError(error2);
      expect(result2.message).toBe('Cannot access [TEMP]');
    });

    it('should handle validation errors specially', () => {
      process.env.NODE_ENV = 'production';
      
      const error = new Error('Invalid input');
      error.name = 'ValidationError';
      
      const result = SecureErrorHandler.sanitizeError(error);
      
      expect(result.message).toBe('Validation failed. Please check your input.');
    });

    it('should handle TypeError specially', () => {
      process.env.NODE_ENV = 'production';
      
      const error = new TypeError('Cannot read property of undefined');
      
      const result = SecureErrorHandler.sanitizeError(error);
      
      expect(result.message).toBe('Invalid operation requested.');
    });
  });

  describe('createErrorResponse', () => {
    it('should create a properly formatted error response', () => {
      const error = new Error('Test error');
      error.code = 'TEST';
      
      const response = SecureErrorHandler.createErrorResponse(error, 'req-456');
      
      expect(response).toEqual({
        success: false,
        error: {
          message: expect.any(String),
          code: 'TEST',
          requestId: 'req-456'
        }
      });
    });
  });

  describe('wrapAsync', () => {
    it('should wrap async functions and sanitize errors', async () => {
      const asyncFn = async () => {
        throw new Error('Secret path: /home/user/password.txt');
      };
      
      const wrapped = SecureErrorHandler.wrapAsync(asyncFn, 'TestOperation');
      
      await expect(wrapped()).rejects.toThrow('TestOperation: Secret path: [PATH]');
    });

    it('should pass through successful results', async () => {
      const asyncFn = async (x: number) => x * 2;
      
      const wrapped = SecureErrorHandler.wrapAsync(asyncFn);
      
      await expect(wrapped(5)).resolves.toBe(10);
    });
  });

  describe('error code mappings', () => {
    const testCases = [
      { code: 'ENOENT', expected: 'Resource not found' },
      { code: 'EACCES', expected: 'Access denied' },
      { code: 'EEXIST', expected: 'Resource already exists' },
      { code: 'EMFILE', expected: 'System resource limit reached' },
      { code: 'ECONNREFUSED', expected: 'Connection refused' },
      { code: 'ETIMEDOUT', expected: 'Operation timed out' },
      { code: 'RATE_LIMITED', expected: 'Too many requests' },
    ];

    testCases.forEach(({ code, expected }) => {
      it(`should map ${code} to "${expected}"`, () => {
        process.env.NODE_ENV = 'production';
        
        const error = { code };
        const result = SecureErrorHandler.sanitizeError(error);
        
        expect(result.message).toBe(expected);
      });
    });
  });
});