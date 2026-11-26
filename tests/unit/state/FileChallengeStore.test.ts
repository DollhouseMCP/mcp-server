/**
 * Unit tests for FileChallengeStore
 *
 * Tests file-backed verification challenge persistence — persist/restore cycle,
 * expiry handling, one-time-use deletion.
 *
 * Issue #1945
 */

import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

const TEST_STATE_DIR = path.join(os.tmpdir(), 'dollhouse-test-state');

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
const keys = { resolve: async () => ({ keyId: 'test', key: Buffer.alloc(32, 0x5d) }) };

function createMockFileOps(options?: {
  readFileResult?: string;
  readFileError?: Error;
}) {
  let readFileMock: jest.Mock<() => Promise<string>>;
  if (options?.readFileError) {
    readFileMock = jest.fn<() => Promise<string>>().mockRejectedValue(options.readFileError);
  } else if (options?.readFileResult === undefined) {
    readFileMock = jest.fn<() => Promise<string>>().mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );
  } else {
    readFileMock = jest.fn<() => Promise<string>>().mockResolvedValue(options.readFileResult);
  }
  return {
    readFile: readFileMock,
    writeFile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    chmod: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    withWriteLock: async <T>(_file: string, operation: () => Promise<T>) => operation(),
  } as ReturnType<typeof createMockFileOps>;
}

describe('FileChallengeStore', () => {
  let store: InstanceType<typeof FileChallengeStore>;
  let mockFileOps: ReturnType<typeof createMockFileOps>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFileOps = createMockFileOps();
    // Disable auto-cleanup timer in tests (pass 0)
    store = new FileChallengeStore(mockFileOps, keys, TEST_STATE_DIR, 'test-session', 0);
    await store.initialize();
  });

  afterEach(() => {
    store.destroy();
  });

  describe('set() and get()', () => {
    it('should store and retrieve a challenge', () => {
      const challenge = { code: '123456', expiresAt: Date.now() + 60000, reason: 'test' };
      store.set('challenge-1', challenge);

      expect(store.get('challenge-1')).toEqual({ expiresAt: challenge.expiresAt, reason: challenge.reason });
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
      store = new FileChallengeStore(mockFileOps, keys, TEST_STATE_DIR, 'test-session', 0);

      await store.initialize();

      const migrated = mockFileOps.writeFile.mock.calls[0][1];
      expect(migrated).not.toContain('"code"');
      expect(migrated).not.toContain('"abc"');
      expect(JSON.parse(migrated)).toMatchObject({ version: 2, challenges: [['c-active', expect.objectContaining({ reason: 'active' })]] });
      expect(store.size()).toBe(1);
      expect(store.get('c-active')).toMatchObject({ reason: 'active' });
      expect(store.get('c-expired')).toBeUndefined();
      expect(store.verify('c-active', 'abc')).toBe(true);
      await store.awaitPendingWrites();
    });

    it('should start fresh when no file exists', async () => {
      await store.initialize();
      expect(store.size()).toBe(0);
    });

    it('keeps a legacy challenge unavailable when its protected state cannot be written', async () => {
      const persisted = JSON.stringify({
        version: 1, challenges: [['pending', { code: 'OLDER', expiresAt: Date.now() + 60_000, reason: 'active' }]],
      });
      mockFileOps = createMockFileOps({ readFileResult: persisted });
      mockFileOps.writeFile.mockRejectedValue(new Error('write unavailable'));
      store = new FileChallengeStore(mockFileOps, keys, TEST_STATE_DIR, 'test-session', 0);
      await store.initialize();
      expect(store.get('pending')).toBeUndefined();
      expect(store.verify('pending', 'OLDER')).toBe(false);
    });
  });

  describe('round-trip persistence', () => {
    it('should survive a write → read cycle', async () => {
      store.set('c1', { code: 'test-code', expiresAt: Date.now() + 300000, reason: 'round-trip test' });

      await store.awaitPendingWrites();

      const writtenContent = mockFileOps.writeFile.mock.calls[mockFileOps.writeFile.mock.calls.length - 1][1];

      const readMockFileOps = createMockFileOps({ readFileResult: writtenContent });
      expect(writtenContent).not.toContain('test-code');
      expect(writtenContent).not.toContain('"code"');
      const store2 = new FileChallengeStore(readMockFileOps, keys, TEST_STATE_DIR, 'test-session', 0);
      await store2.initialize();

      expect(store2.size()).toBe(1);
      expect(store2.get('c1')).toMatchObject({ reason: 'round-trip test' });
      expect(store2.verify('c1', 'test-code')).toBe(true);
      expect(store2.verify('c1', 'test-code')).toBe(false);
      await store2.awaitPendingWrites();
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
