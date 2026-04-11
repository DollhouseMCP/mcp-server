/**
 * Tests for transport-aware process error handlers.
 *
 * Verifies that uncaughtException and unhandledRejection handlers
 * exit in stdio mode but continue serving in HTTP mode.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock logger before importing the module under test
jest.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('Transport-aware process error handlers', () => {
  let httpModeActive: boolean;
  let setHttpModeActive: (active: boolean) => void;
  let mockExit: jest.SpiedFunction<typeof process.exit>;

  beforeEach(async () => {
    // Dynamic import to get the mutable exports after mocks are in place
    const indexModule = await import('../../../src/index.js');
    setHttpModeActive = indexModule.setHttpModeActive;

    // Reset to stdio mode
    setHttpModeActive(false);

    // Mock process.exit to prevent actual termination
    mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    setHttpModeActive(false);
    mockExit.mockRestore();
  });

  describe('stdio mode (default)', () => {
    it('should call process.exit(1) on uncaughtException', () => {
      process.emit('uncaughtException', new Error('test stdio exception'));
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should call process.exit(1) on unhandledRejection', () => {
      process.emit('unhandledRejection', new Error('test stdio rejection'), Promise.resolve());
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('HTTP mode', () => {
    beforeEach(() => {
      setHttpModeActive(true);
    });

    it('should NOT call process.exit on uncaughtException', () => {
      process.emit('uncaughtException', new Error('test http exception'));
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('should NOT call process.exit on unhandledRejection', () => {
      process.emit('unhandledRejection', new Error('test http rejection'), Promise.resolve());
      expect(mockExit).not.toHaveBeenCalled();
    });
  });
});
