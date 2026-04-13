/**
 * Unit tests for FileActivationStateStore
 *
 * Tests file-backed activation state persistence — persist/restore cycle,
 * ENOENT tolerance, element type normalization, and session ID validation.
 *
 * Issue #1945
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockLogSecurityEvent = jest.fn();

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
    logSecurityEvent: mockLogSecurityEvent,
  },
}));

const mockMkdir = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('fs/promises', () => ({
  default: { mkdir: mockMkdir },
  mkdir: mockMkdir,
}));

const { FileActivationStateStore } = await import('../../../src/state/FileActivationStateStore.js');

function createMockFileOps(options?: {
  readFileResult?: string;
  readFileError?: Error;
  writeFileError?: Error;
}) {
  return {
    readFile: options?.readFileError
      ? jest.fn<() => Promise<string>>().mockRejectedValue(options.readFileError)
      : options?.readFileResult !== undefined
        ? jest.fn<() => Promise<string>>().mockResolvedValue(options.readFileResult)
        : jest.fn<() => Promise<string>>().mockRejectedValue(
            Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          ),
    writeFile: options?.writeFileError
      ? jest.fn<() => Promise<void>>().mockRejectedValue(options.writeFileError)
      : jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as any;
}

describe('FileActivationStateStore', () => {
  let store: InstanceType<typeof FileActivationStateStore>;
  let mockFileOps: ReturnType<typeof createMockFileOps>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DOLLHOUSE_SESSION_ID;
    delete process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE;
    mockFileOps = createMockFileOps();
    store = new FileActivationStateStore(mockFileOps, '/tmp/test-state', 'test-session');
  });

  describe('session identity', () => {
    it('should use the provided sessionId', () => {
      expect(store.getSessionId()).toBe('test-session');
    });

    it('should reject invalid sessionId and fall back to default', () => {
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test', '../evil-path');
      expect(s.getSessionId()).toBe('default');
    });
  });

  describe('initialize()', () => {
    it('should start fresh when no file exists (ENOENT)', async () => {
      await store.initialize();
      expect(store.getActivations('skill')).toEqual([]);
    });

    it('should load valid persisted state from disk', async () => {
      const persisted = {
        version: 1,
        sessionId: 'test-session',
        lastUpdated: '2026-04-13T00:00:00Z',
        activations: {
          skill: [{ name: 'code-reviewer', activatedAt: '2026-04-13T00:00:00Z' }],
          persona: [{ name: 'Dev', filename: 'dev.md', activatedAt: '2026-04-13T00:00:00Z' }],
        },
      };
      mockFileOps = createMockFileOps({ readFileResult: JSON.stringify(persisted) });
      store = new FileActivationStateStore(mockFileOps, '/tmp/test-state', 'test-session');

      await store.initialize();

      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('skill')[0].name).toBe('code-reviewer');
      expect(store.getActivations('persona')).toHaveLength(1);
      expect(store.getActivations('persona')[0].filename).toBe('dev.md');
    });

    it('should handle corrupt JSON gracefully', async () => {
      mockFileOps = createMockFileOps({ readFileResult: '{invalid json' });
      store = new FileActivationStateStore(mockFileOps, '/tmp/test-state', 'test-session');

      await store.initialize();
      expect(store.getActivations('skill')).toEqual([]);
    });

    it('should ignore unknown element types from file', async () => {
      const persisted = {
        version: 1,
        sessionId: 'test-session',
        lastUpdated: '2026-04-13T00:00:00Z',
        activations: {
          skill: [{ name: 'valid', activatedAt: '2026-04-13T00:00:00Z' }],
          bogus: [{ name: 'should-not-load', activatedAt: '2026-04-13T00:00:00Z' }],
        },
      };
      mockFileOps = createMockFileOps({ readFileResult: JSON.stringify(persisted) });
      store = new FileActivationStateStore(mockFileOps, '/tmp/test-state', 'test-session');

      await store.initialize();

      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('bogus')).toEqual([]);
    });

    it('should start fresh on non-ENOENT errors (graceful degradation)', async () => {
      mockFileOps = createMockFileOps({
        readFileError: Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      });
      store = new FileActivationStateStore(mockFileOps, '/tmp/test-state', 'test-session');

      await store.initialize();

      // Should not throw, should start with empty state
      expect(store.getActivations('skill')).toEqual([]);
    });
  });

  describe('recordActivation() + recordDeactivation()', () => {
    it('should record and retrieve activations', () => {
      store.recordActivation('skill', 'code-reviewer');
      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('skill')[0].name).toBe('code-reviewer');
    });

    it('should deduplicate repeated activations', () => {
      store.recordActivation('skill', 'code-reviewer');
      store.recordActivation('skill', 'code-reviewer');
      expect(store.getActivations('skill')).toHaveLength(1);
    });

    it('should accept plural element type forms', () => {
      store.recordActivation('skills', 'my-skill');
      store.recordActivation('personas', 'my-persona');
      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('persona')).toHaveLength(1);
    });

    it('should reject unknown element types', () => {
      store.recordActivation('webhook', 'my-hook');
      expect(store.getActivations('webhook')).toEqual([]);
    });

    it('should remove deactivated elements', () => {
      store.recordActivation('skill', 'a');
      store.recordActivation('skill', 'b');
      store.recordDeactivation('skill', 'a');
      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('skill')[0].name).toBe('b');
    });
  });

  describe('round-trip persistence', () => {
    it('should survive a write → read cycle', async () => {
      store.recordActivation('skill', 'code-reviewer');
      store.recordActivation('persona', 'Creative Dev', 'creative-dev.md');

      await new Promise(resolve => setTimeout(resolve, 10));

      const writtenContent = mockFileOps.writeFile.mock.calls[mockFileOps.writeFile.mock.calls.length - 1][1];

      const readMockFileOps = createMockFileOps({ readFileResult: writtenContent });
      const store2 = new FileActivationStateStore(readMockFileOps, '/tmp/test-state', 'test-session');
      await store2.initialize();

      expect(store2.getActivations('skill')).toHaveLength(1);
      expect(store2.getActivations('skill')[0].name).toBe('code-reviewer');
      expect(store2.getActivations('persona')).toHaveLength(1);
      expect(store2.getActivations('persona')[0].filename).toBe('creative-dev.md');
    });
  });

  describe('clearAll()', () => {
    it('should clear all activations and persist', async () => {
      store.recordActivation('skill', 'my-skill');
      store.recordActivation('agent', 'my-agent');
      store.clearAll();

      expect(store.getActivations('skill')).toEqual([]);
      expect(store.getActivations('agent')).toEqual([]);

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(mockFileOps.writeFile).toHaveBeenCalled();
    });
  });
});
