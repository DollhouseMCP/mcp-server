/**
 * Unit tests for LifecycleService (Issue #1948).
 *
 * Verifies idempotency guard, transport mode, and error handler behavior.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { LifecycleService } = await import('../../../src/lifecycle/LifecycleService.js');

describe('LifecycleService (Issue #1948)', () => {
  let service: InstanceType<typeof LifecycleService>;
  let processOnSpy: jest.SpiedFunction<typeof process.on>;

  beforeEach(() => {
    service = new LifecycleService();
    processOnSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
  });

  describe('transport mode', () => {
    it('should default to stdio mode (httpModeActive = false)', () => {
      expect(service.isHttpModeActive()).toBe(false);
    });

    it('should switch to HTTP mode', () => {
      service.setHttpModeActive(true);
      expect(service.isHttpModeActive()).toBe(true);
    });

    it('should switch back to stdio mode', () => {
      service.setHttpModeActive(true);
      service.setHttpModeActive(false);
      expect(service.isHttpModeActive()).toBe(false);
    });
  });

  describe('installErrorHandlers idempotency', () => {
    it('should register handlers on first call', () => {
      service.installErrorHandlers();

      const uncaughtCalls = processOnSpy.mock.calls.filter(([event]) => event === 'uncaughtException');
      const rejectionCalls = processOnSpy.mock.calls.filter(([event]) => event === 'unhandledRejection');

      expect(uncaughtCalls.length).toBe(1);
      expect(rejectionCalls.length).toBe(1);
    });

    it('should NOT register duplicate handlers on second call', () => {
      service.installErrorHandlers();
      const firstCallCount = processOnSpy.mock.calls.length;

      service.installErrorHandlers();
      const secondCallCount = processOnSpy.mock.calls.length;

      // No additional process.on calls on second invocation
      expect(secondCallCount).toBe(firstCallCount);
    });
  });
});
