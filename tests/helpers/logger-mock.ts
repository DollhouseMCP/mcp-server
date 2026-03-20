/**
 * Mock logger helper for testing
 * Provides a jest-mocked implementation of ILogger for dependency injection in tests
 */

import { jest } from '@jest/globals';
import { ILogger, LogEntry } from '../../src/types/ILogger.js';

/**
 * Create a mock logger instance for testing
 *
 * @param overrides - Optional partial overrides for specific methods
 * @returns A fully mocked ILogger instance
 *
 * @example
 * ```typescript
 * const mockLogger = createMockLogger();
 * const service = new MyService(mockLogger);
 *
 * // Verify logging behavior
 * expect(mockLogger.info).toHaveBeenCalledWith('Operation completed');
 * ```
 *
 * @example
 * ```typescript
 * // Override specific methods
 * const mockLogger = createMockLogger({
 *   getLogs: jest.fn(() => [
 *     { timestamp: new Date(), level: 'info', message: 'Test log' }
 *   ])
 * });
 * ```
 */
export function createMockLogger(overrides?: Partial<jest.Mocked<ILogger>>): jest.Mocked<ILogger> {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    getLogs: jest.fn(() => []),
    clearLogs: jest.fn(),
    setMCPConnected: jest.fn(),
    ...overrides
  } as jest.Mocked<ILogger>;
}

/**
 * Create a mock logger with pre-populated logs for testing log retrieval
 *
 * @param logs - Array of log entries to return from getLogs()
 * @returns A mocked ILogger with pre-populated logs
 *
 * @example
 * ```typescript
 * const logs: LogEntry[] = [
 *   { timestamp: new Date(), level: 'error', message: 'Test error' }
 * ];
 * const mockLogger = createMockLoggerWithLogs(logs);
 *
 * expect(mockLogger.getLogs()).toEqual(logs);
 * ```
 */
export function createMockLoggerWithLogs(logs: LogEntry[]): jest.Mocked<ILogger> {
  return createMockLogger({
    getLogs: jest.fn(() => logs)
  });
}

/**
 * Create a spy logger that tracks calls but also performs real logging
 * Useful for integration tests where you want to verify logging AND see output
 *
 * @param realLogger - The real logger instance to spy on
 * @returns A spied logger that delegates to the real implementation
 *
 * @example
 * ```typescript
 * import { MCPLogger } from '../../src/utils/logger.js';
 *
 * const realLogger = new MCPLogger();
 * const spyLogger = createSpyLogger(realLogger);
 *
 * service.doOperation(spyLogger);
 *
 * // Verify calls while still getting real logging
 * expect(spyLogger.info).toHaveBeenCalled();
 * expect(realLogger.getLogs()).toHaveLength(1);
 * ```
 */
export function createSpyLogger(realLogger: ILogger): jest.Mocked<ILogger> {
  return {
    debug: jest.fn((msg, data) => realLogger.debug(msg, data)),
    info: jest.fn((msg, data) => realLogger.info(msg, data)),
    warn: jest.fn((msg, data) => realLogger.warn(msg, data)),
    error: jest.fn((msg, data) => realLogger.error(msg, data)),
    getLogs: jest.fn((count, level) => realLogger.getLogs(count, level)),
    clearLogs: jest.fn(() => realLogger.clearLogs()),
    setMCPConnected: jest.fn(() => realLogger.setMCPConnected())
  } as jest.Mocked<ILogger>;
}
