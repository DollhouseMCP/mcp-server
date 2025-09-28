/**
 * Tests for GitHubRateLimiter
 *
 * Coverage for PR #1161 fixes:
 * - Lazy initialization pattern
 * - Error recovery behavior
 * - Secure ID generation with crypto
 * - Concurrent initialization handling
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// Create mock before importing
const mockRandomBytes = jest.fn();
const mockGetGitHubTokenAsync = jest.fn();
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

jest.unstable_mockModule('node:crypto', () => ({
  randomBytes: mockRandomBytes
}));

jest.unstable_mockModule('../../../../src/security/tokenManager.js', () => ({
  TokenManager: {
    getGitHubTokenAsync: mockGetGitHubTokenAsync
  }
}));

jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
  logger: mockLogger
}));

// Import after mocks are set up
const { GitHubRateLimiter } = await import('../../../../src/utils/GitHubRateLimiter.js');

describe('GitHubRateLimiter', () => {
  let rateLimiter: GitHubRateLimiter;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Setup default mock implementations
    mockGetGitHubTokenAsync.mockResolvedValue('test-token');

    mockRandomBytes.mockImplementation((size: number) => {
      if (size === 6) {
        return Buffer.from('1234567890ab', 'hex');
      } else if (size === 1) {
        return Buffer.from([25]); // < 26, so shouldUpdate is true ~10% of the time
      }
      return Buffer.alloc(size);
    });

    rateLimiter = new GitHubRateLimiter();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Constructor behavior', () => {
    it('should not call async functions in constructor', () => {
      // Constructor already called in beforeEach
      expect(mockGetGitHubTokenAsync).not.toHaveBeenCalled();
    });

    it('should set up periodic check timer', () => {
      expect(setInterval).toHaveBeenCalledWith(
        expect.any(Function),
        5 * 60 * 1000 // 5 minutes
      );
    });

    it('should initialize with default rate limiter synchronously', () => {
      // The constructor should complete without any async operations
      expect(rateLimiter).toBeDefined();
      // Should not have called token manager yet
      expect(mockGetGitHubTokenAsync).not.toHaveBeenCalled();
    });
  });

  describe('Lazy initialization', () => {
    it('should initialize on first queueRequest call', async () => {
      const apiCall = jest.fn().mockResolvedValue({ data: 'test' });

      // Queue a request - this should trigger initialization
      const promise = rateLimiter.queueRequest('test-operation', apiCall);

      // Allow microtasks to run
      await Promise.resolve();

      // Process the queue
      jest.runAllTimers();

      await promise;

      // Now token should have been fetched
      expect(mockGetGitHubTokenAsync).toHaveBeenCalled();
    });

    it('should only initialize once even with multiple concurrent requests', async () => {
      const apiCall1 = jest.fn().mockResolvedValue({ data: 'test1' });
      const apiCall2 = jest.fn().mockResolvedValue({ data: 'test2' });
      const apiCall3 = jest.fn().mockResolvedValue({ data: 'test3' });

      // Queue multiple requests concurrently
      const promises = [
        rateLimiter.queueRequest('operation1', apiCall1),
        rateLimiter.queueRequest('operation2', apiCall2),
        rateLimiter.queueRequest('operation3', apiCall3)
      ];

      // Allow microtasks to run
      await Promise.resolve();

      // Process the queue
      jest.runAllTimers();

      await Promise.all(promises);

      // Token should only be fetched once
      expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe('Error recovery', () => {
    it('should continue with defaults if initialization fails', async () => {
      // Make token fetching fail
      mockGetGitHubTokenAsync.mockRejectedValue(new Error('Auth service down'));

      const apiCall = jest.fn().mockResolvedValue({ data: 'test' });

      // Queue a request - initialization will fail but should continue
      const promise = rateLimiter.queueRequest('test-operation', apiCall);

      // Allow microtasks to run
      await Promise.resolve();

      // Process the queue
      jest.runAllTimers();

      await promise;

      // Should have attempted to get token
      expect(mockGetGitHubTokenAsync).toHaveBeenCalled();

      // Should have logged the error
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Continuing with default rate limits after init failure',
        expect.objectContaining({ error: expect.any(Error) })
      );

      // API call should still have been made
      expect(apiCall).toHaveBeenCalled();
    });

    it('should retry initialization on subsequent requests after failure', async () => {
      // First call fails
      mockGetGitHubTokenAsync.mockRejectedValueOnce(new Error('Temporary failure'));
      // Second call succeeds
      mockGetGitHubTokenAsync.mockResolvedValueOnce('test-token');

      const apiCall1 = jest.fn().mockResolvedValue({ data: 'test1' });
      const apiCall2 = jest.fn().mockResolvedValue({ data: 'test2' });

      // First request - initialization fails
      const promise1 = rateLimiter.queueRequest('operation1', apiCall1);
      await Promise.resolve();
      jest.runAllTimers();
      await promise1;

      expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(1);

      // Second request - should retry initialization
      const promise2 = rateLimiter.queueRequest('operation2', apiCall2);
      await Promise.resolve();
      jest.runAllTimers();
      await promise2;

      // Should have attempted to get token again
      expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(2);
    });
  });

  describe('Secure ID generation', () => {
    it('should use crypto.randomBytes for request ID generation', async () => {
      const apiCall = jest.fn().mockResolvedValue({ data: 'test' });

      const promise = rateLimiter.queueRequest('test-operation', apiCall);
      await Promise.resolve();
      jest.runAllTimers();
      await promise;

      // Should have called randomBytes for ID generation
      expect(mockRandomBytes).toHaveBeenCalledWith(6);
    });

    it('should generate unique request IDs with crypto', async () => {
      // Mock different random values for each call
      let callCount = 0;
      mockRandomBytes.mockImplementation((size: number) => {
        if (size === 6) {
          callCount++;
          return Buffer.from(`${callCount}234567890ab`.slice(0, 12), 'hex');
        }
        return Buffer.from([25]);
      });

      const apiCall = jest.fn().mockResolvedValue({ data: 'test' });

      // Queue multiple requests
      const promises = [
        rateLimiter.queueRequest('operation1', apiCall),
        rateLimiter.queueRequest('operation2', apiCall)
      ];

      await Promise.resolve();
      jest.runAllTimers();
      await Promise.all(promises);

      // Should have called randomBytes for each request ID
      const randomBytesCalls = mockRandomBytes.mock.calls.filter(call => call[0] === 6);
      expect(randomBytesCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Periodic auth status updates', () => {
    it('should use crypto.randomBytes for periodic update decision', async () => {
      const apiCall = jest.fn().mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({ data: 'test' }), 100))
      );

      // Mock to return value < 26 (will trigger update)
      mockRandomBytes.mockImplementation((size: number) => {
        if (size === 1) return Buffer.from([20]); // < 26
        return Buffer.from('1234567890ab', 'hex');
      });

      const promise = rateLimiter.queueRequest('test-operation', apiCall);
      await Promise.resolve();
      jest.runAllTimers();
      await promise;

      // Should have called randomBytes(1) for the periodic check
      const singleByteCalls = mockRandomBytes.mock.calls.filter(call => call[0] === 1);
      expect(singleByteCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Race condition prevention', () => {
    it('should handle concurrent initialization attempts properly', async () => {
      let resolveInit: (value: string) => void;
      const initPromise = new Promise<string>((resolve) => {
        resolveInit = resolve;
      });

      // Mock a slow initialization
      mockGetGitHubTokenAsync.mockImplementationOnce(() => initPromise);

      const apiCall1 = jest.fn().mockResolvedValue({ data: 'test1' });
      const apiCall2 = jest.fn().mockResolvedValue({ data: 'test2' });

      // Start both requests
      const promise1 = rateLimiter.queueRequest('operation1', apiCall1);
      const promise2 = rateLimiter.queueRequest('operation2', apiCall2);

      // Let microtasks run
      await Promise.resolve();

      // Complete initialization
      resolveInit!('test-token');

      jest.runAllTimers();
      await Promise.all([promise1, promise2]);

      // Token should only be fetched once (no race condition)
      expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(1);
    });
  });
});