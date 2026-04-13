/**
 * Unit tests for FileChallengeStore
 *
 * Tests file-backed verification challenge persistence — persist/restore cycle,
 * expiry handling, one-time-use deletion.
 *
 * Issue #1945
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    logSecurityEvent: jest.fn(),
  },
}));

const mockMkdir = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('fs/promises', () => ({
  default: { mkdir: mockMkdir },
  mkdir: mockMkdir,
}));

const { FileChallengeStore } = await import('../../../src/state/FileChallengeStore.js');

function createMockFileOps(options?: {
  readFileResult?: string;
  readFileError?: Error;
}) {
  return {
    readFile: options?.readFileError
      ? jest.fn<() => Promise<string>>().mockRejectedValue(options.readFileError)
      : options?.readFileResult !== undefined
        ? jest.fn<() => Promise<string>>().mockResolvedValue(options.readFileResult)
        : jest.fn<() => Promise<string>>().mockRejectedValue(
            Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          ),
    writeFile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as any;
}

describe('FileChallengeStore', () => {
  let store: InstanceType<typeof FileChallengeStore>;
  let mockFileOps: ReturnType<typeof createMockFileOps>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFileOps = createMockFileOps();
    // Disable auto-cleanup timer in tests (pass 0)
    store = new FileChallengeStore(mockFileOps, '/tmp/test-state', 'test-session', 0);
  });

  afterEach(() => {
    store.destroy();
  });

  describe('set() and get()', () => {
    it('should store and retrieve a challenge', () => {
      const challenge = { code: '123456', expiresAt: Date.now() + 60000, reason: 'test' };
      store.set('challenge-1', challenge);

      expect(store.get('challenge-1')).toEqual(challenge);
      expect(store.size()).toBe(1);
    });

    it('should return undefined for unknown challenge', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('should auto-delete expired challenges on get()', () => {
      const expired = { code: '123456', expiresAt: Date.now() - 1000, reason: 'test' };
      store.set('challenge-expired', expired);

      expect(store.get('challenge-expired')).toBeUndefined();
      expect(store.size()).toBe(0);
    });
  });

  describe('verify()', () => {
    it('should return true for correct code', () => {
      store.set('c1', { code: 'secret', expiresAt: Date.now() + 60000, reason: 'test' });

      expect(store.verify('c1', 'secret')).toBe(true);
    });

    it('should return false for wrong code', () => {
      store.set('c1', { code: 'secret', expiresAt: Date.now() + 60000, reason: 'test' });

      expect(store.verify('c1', 'wrong')).toBe(false);
    });

    it('should delete challenge after verification (one-time use)', () => {
      store.set('c1', { code: 'secret', expiresAt: Date.now() + 60000, reason: 'test' });

      store.verify('c1', 'secret');
      expect(store.get('c1')).toBeUndefined();
      expect(store.size()).toBe(0);
    });

    it('should delete challenge even on failed verification', () => {
      store.set('c1', { code: 'secret', expiresAt: Date.now() + 60000, reason: 'test' });

      store.verify('c1', 'wrong');
      expect(store.get('c1')).toBeUndefined();
    });

    it('should return false for expired challenge', () => {
      store.set('c1', { code: 'secret', expiresAt: Date.now() - 1000, reason: 'test' });

      expect(store.verify('c1', 'secret')).toBe(false);
    });
  });

  describe('initialize()', () => {
    it('should restore non-expired challenges from disk', async () => {
      const persisted = {
        version: 1,
        sessionId: 'test-session',
        lastUpdated: new Date().toISOString(),
        challenges: [
          ['c-active', { code: 'abc', expiresAt: Date.now() + 60000, reason: 'active' }],
          ['c-expired', { code: 'def', expiresAt: Date.now() - 1000, reason: 'expired' }],
        ],
      };
      mockFileOps = createMockFileOps({ readFileResult: JSON.stringify(persisted) });
      store = new FileChallengeStore(mockFileOps, '/tmp/test-state', 'test-session', 0);

      await store.initialize();

      expect(store.size()).toBe(1);
      expect(store.get('c-active')?.code).toBe('abc');
      expect(store.get('c-expired')).toBeUndefined();
    });

    it('should start fresh when no file exists', async () => {
      await store.initialize();
      expect(store.size()).toBe(0);
    });
  });

  describe('round-trip persistence', () => {
    it('should survive a write → read cycle', async () => {
      store.set('c1', { code: 'test-code', expiresAt: Date.now() + 300000, reason: 'round-trip test' });

      await new Promise(resolve => setTimeout(resolve, 10));

      const writtenContent = mockFileOps.writeFile.mock.calls[mockFileOps.writeFile.mock.calls.length - 1][1];

      const readMockFileOps = createMockFileOps({ readFileResult: writtenContent });
      const store2 = new FileChallengeStore(readMockFileOps, '/tmp/test-state', 'test-session', 0);
      await store2.initialize();

      expect(store2.size()).toBe(1);
      expect(store2.get('c1')?.code).toBe('test-code');
      store2.destroy();
    });
  });

  describe('cleanup()', () => {
    it('should remove expired challenges', () => {
      store.set('active', { code: 'a', expiresAt: Date.now() + 60000, reason: 'active' });
      store.set('expired', { code: 'b', expiresAt: Date.now() - 1000, reason: 'expired' });

      store.cleanup();

      expect(store.size()).toBe(1);
      expect(store.get('active')).toBeDefined();
      expect(store.get('expired')).toBeUndefined();
    });
  });

  describe('clear()', () => {
    it('should remove all challenges', () => {
      store.set('c1', { code: 'a', expiresAt: Date.now() + 60000, reason: 'test' });
      store.set('c2', { code: 'b', expiresAt: Date.now() + 60000, reason: 'test' });

      store.clear();
      expect(store.size()).toBe(0);
    });
  });
});
