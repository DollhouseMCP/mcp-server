/**
 * Tests for MCP-safe logger
 */

import { jest } from '@jest/globals';
import { logger } from '../../../../src/utils/logger.js';

describe('MCPLogger', () => {
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;
  let consoleWarnSpy: jest.SpiedFunction<typeof console.warn>;
  
  beforeEach(() => {
    // Clear logs before each test
    logger.clearLogs();
    
    // Mock console methods
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  
  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });
  
  describe('logging methods', () => {
    it('should store debug messages in memory', () => {
      logger.debug('Test debug message', { data: 'test' });
      
      const logs = logger.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('debug');
      expect(logs[0].message).toBe('Test debug message');
      expect(logs[0].data).toEqual({ data: 'test' });
    });
    
    it('should store info messages in memory', () => {
      logger.info('Test info message');
      
      const logs = logger.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('info');
      expect(logs[0].message).toBe('Test info message');
    });
    
    it('should store warn messages in memory', () => {
      logger.warn('Test warning', { code: 'WARN001' });
      
      const logs = logger.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warn');
      expect(logs[0].message).toBe('Test warning');
      expect(logs[0].data).toEqual({ code: 'WARN001' });
    });
    
    it('should store error messages in memory', () => {
      logger.error('Test error', { error: new Error('Test') });
      
      const logs = logger.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('error');
      expect(logs[0].message).toBe('Test error');
    });
  });
  
  describe('memory management', () => {
    it('should maintain circular buffer of 1000 entries', () => {
      // Add 1005 log entries
      for (let i = 0; i < 1005; i++) {
        logger.info(`Log entry ${i}`);
      }
      
      const logs = logger.getLogs(1000);
      expect(logs).toHaveLength(1000);
      // First 5 entries should have been removed
      expect(logs[0].message).toBe('Log entry 5');
      expect(logs[999].message).toBe('Log entry 1004');
    });
    
    it('should clear logs when requested', () => {
      logger.info('Test 1');
      logger.info('Test 2');
      expect(logger.getLogs()).toHaveLength(2);
      
      logger.clearLogs();
      expect(logger.getLogs()).toHaveLength(0);
    });
  });
  
  describe('log filtering', () => {
    it('should filter logs by level', () => {
      logger.debug('Debug message');
      logger.info('Info message');
      logger.warn('Warning message');
      logger.error('Error message');
      
      const errorLogs = logger.getLogs(100, 'error');
      expect(errorLogs).toHaveLength(1);
      expect(errorLogs[0].message).toBe('Error message');
      
      const warnLogs = logger.getLogs(100, 'warn');
      expect(warnLogs).toHaveLength(1);
      expect(warnLogs[0].message).toBe('Warning message');
    });
    
    it('should respect count limit', () => {
      for (let i = 0; i < 10; i++) {
        logger.info(`Message ${i}`);
      }
      
      const logs = logger.getLogs(5);
      expect(logs).toHaveLength(5);
      // Should get the last 5 messages
      expect(logs[0].message).toBe('Message 5');
      expect(logs[4].message).toBe('Message 9');
    });
  });
  
  describe('console output suppression', () => {
    it('should not output to console in test environment', () => {
      logger.error('Critical error');
      logger.warn('Warning');
      logger.info('Info');
      logger.debug('Debug');
      
      // In test environment, nothing should be logged to console
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });
  
  describe('timestamp handling', () => {
    it('should add timestamps to all log entries', () => {
      const before = Date.now();
      logger.info('Test message');
      const after = Date.now();
      
      const logs = logger.getLogs();
      expect(logs[0].timestamp).toBeDefined();
      expect(logs[0].timestamp instanceof Date).toBe(true);
      
      const logTime = logs[0].timestamp.getTime();
      expect(logTime).toBeGreaterThanOrEqual(before);
      expect(logTime).toBeLessThanOrEqual(after);
    });
  });
  
  describe('data handling', () => {
    it('should handle undefined data', () => {
      logger.info('Message without data');
      
      const logs = logger.getLogs();
      expect(logs[0].data).toBeUndefined();
    });
    
    it('should handle complex data objects', () => {
      const complexData = {
        user: { id: 123, name: 'Test' },
        error: new Error('Test error'),
        array: [1, 2, 3],
        nested: { deep: { value: 'test' } }
      };
      
      logger.error('Complex error', complexData);
      
      const logs = logger.getLogs();
      expect(logs[0].data).toEqual(complexData);
    });
  });
});