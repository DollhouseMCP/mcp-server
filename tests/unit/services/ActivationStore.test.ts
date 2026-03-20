/**
 * Unit tests for ActivationStore
 *
 * Tests per-session element activation persistence.
 * Issue #598: Activation state survives server restarts.
 */

import path from 'path';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Create mock function for SecurityMonitor
const mockLogSecurityEvent = jest.fn();

// ESM mocking: use unstable_mockModule for proper mock isolation
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

// Dynamic import after mocking (required for ESM)
const { ActivationStore } = await import('../../../src/services/ActivationStore.js');

/**
 * Create a mock FileOperationsService with controlled read/write behavior
 */
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
    readElementFile: jest.fn<() => Promise<string>>().mockResolvedValue(''),
    deleteFile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    fileExists: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    listFiles: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
    ensureDirectory: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as any;
}

describe('ActivationStore', () => {
  let store: InstanceType<typeof ActivationStore>;
  let mockFileOps: ReturnType<typeof createMockFileOps>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset env vars
    delete process.env.DOLLHOUSE_SESSION_ID;
    delete process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE;
    mockFileOps = createMockFileOps();
    store = new ActivationStore(mockFileOps, '/tmp/test-state');
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
  });

  describe('constructor', () => {
    it('should use default session ID when env var not set', () => {
      const s = new ActivationStore(mockFileOps, '/tmp/test');
      expect(s.getSessionId()).toBe('default');
    });

    it('should use DOLLHOUSE_SESSION_ID when set', () => {
      process.env.DOLLHOUSE_SESSION_ID = 'my-session';
      const s = new ActivationStore(mockFileOps, '/tmp/test');
      expect(s.getSessionId()).toBe('my-session');
    });

    it('should fall back to default for invalid session ID', () => {
      process.env.DOLLHOUSE_SESSION_ID = '../evil-path';
      const s = new ActivationStore(mockFileOps, '/tmp/test');
      expect(s.getSessionId()).toBe('default');
    });

    it('should fall back to default for empty session ID', () => {
      process.env.DOLLHOUSE_SESSION_ID = '  ';
      const s = new ActivationStore(mockFileOps, '/tmp/test');
      expect(s.getSessionId()).toBe('default');
    });

    it('should accept alphanumeric with hyphens and underscores', () => {
      process.env.DOLLHOUSE_SESSION_ID = 'claude-code_v2';
      const s = new ActivationStore(mockFileOps, '/tmp/test');
      expect(s.getSessionId()).toBe('claude-code_v2');
    });

    it('should reject session IDs starting with a number', () => {
      process.env.DOLLHOUSE_SESSION_ID = '123-session';
      const s = new ActivationStore(mockFileOps, '/tmp/test');
      expect(s.getSessionId()).toBe('default');
    });

    it('should be enabled by default', () => {
      expect(store.isEnabled()).toBe(true);
    });

    it('should respect DOLLHOUSE_ACTIVATION_PERSISTENCE=false', () => {
      process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = 'false';
      const s = new ActivationStore(mockFileOps, '/tmp/test');
      expect(s.isEnabled()).toBe(false);
    });

    it('should respect DOLLHOUSE_ACTIVATION_PERSISTENCE=0', () => {
      process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = '0';
      const s = new ActivationStore(mockFileOps, '/tmp/test');
      expect(s.isEnabled()).toBe(false);
    });
  });

  describe('initialize()', () => {
    it('should start with empty activations when no file exists', async () => {
      await store.initialize();
      expect(store.getActivations('skill')).toEqual([]);
      expect(store.getActivations('persona')).toEqual([]);
    });

    it('should load valid persisted state from disk', async () => {
      const persisted = {
        version: 1,
        sessionId: 'default',
        lastUpdated: '2026-02-25T00:00:00Z',
        activations: {
          skill: [{ name: 'code-reviewer', activatedAt: '2026-02-25T00:00:00Z' }],
          persona: [{ name: 'Dev', filename: 'dev.md', activatedAt: '2026-02-25T00:00:00Z' }],
        },
      };
      mockFileOps = createMockFileOps({ readFileResult: JSON.stringify(persisted) });
      store = new ActivationStore(mockFileOps, '/tmp/test-state');

      await store.initialize();

      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('skill')[0].name).toBe('code-reviewer');
      expect(store.getActivations('persona')).toHaveLength(1);
      expect(store.getActivations('persona')[0].filename).toBe('dev.md');
    });

    it('should handle corrupt JSON gracefully', async () => {
      mockFileOps = createMockFileOps({ readFileResult: '{invalid json' });
      store = new ActivationStore(mockFileOps, '/tmp/test-state');

      await store.initialize();

      // Should start with empty state
      expect(store.getActivations('skill')).toEqual([]);
    });

    it('should handle wrong version gracefully', async () => {
      const persisted = {
        version: 99,
        sessionId: 'default',
        lastUpdated: '2026-02-25T00:00:00Z',
        activations: {
          skill: [{ name: 'should-not-load', activatedAt: '2026-02-25T00:00:00Z' }],
        },
      };
      mockFileOps = createMockFileOps({ readFileResult: JSON.stringify(persisted) });
      store = new ActivationStore(mockFileOps, '/tmp/test-state');

      await store.initialize();

      expect(store.getActivations('skill')).toEqual([]);
    });

    it('should filter out entries with empty names', async () => {
      const persisted = {
        version: 1,
        sessionId: 'default',
        lastUpdated: '2026-02-25T00:00:00Z',
        activations: {
          skill: [
            { name: 'valid-skill', activatedAt: '2026-02-25T00:00:00Z' },
            { name: '', activatedAt: '2026-02-25T00:00:00Z' },
            { name: '  ', activatedAt: '2026-02-25T00:00:00Z' },
          ],
        },
      };
      mockFileOps = createMockFileOps({ readFileResult: JSON.stringify(persisted) });
      store = new ActivationStore(mockFileOps, '/tmp/test-state');

      await store.initialize();

      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('skill')[0].name).toBe('valid-skill');
    });

    it('should ignore unknown element types from file', async () => {
      const persisted = {
        version: 1,
        sessionId: 'default',
        lastUpdated: '2026-02-25T00:00:00Z',
        activations: {
          skill: [{ name: 'valid', activatedAt: '2026-02-25T00:00:00Z' }],
          bogus: [{ name: 'should-not-load', activatedAt: '2026-02-25T00:00:00Z' }],
        },
      };
      mockFileOps = createMockFileOps({ readFileResult: JSON.stringify(persisted) });
      store = new ActivationStore(mockFileOps, '/tmp/test-state');

      await store.initialize();

      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('bogus')).toEqual([]);
    });

    it('should skip initialization when persistence is disabled', async () => {
      process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = 'false';
      store = new ActivationStore(mockFileOps, '/tmp/test-state');

      await store.initialize();

      expect(mockFileOps.readFile).not.toHaveBeenCalled();
    });

    it('should restore activations and report count on successful load', async () => {
      const persisted = {
        version: 1,
        sessionId: 'default',
        lastUpdated: '2026-02-25T00:00:00Z',
        activations: {
          skill: [{ name: 'my-skill', activatedAt: '2026-02-25T00:00:00Z' }],
          agent: [{ name: 'my-agent', activatedAt: '2026-02-25T00:00:00Z' }],
        },
      };
      mockFileOps = createMockFileOps({ readFileResult: JSON.stringify(persisted) });
      store = new ActivationStore(mockFileOps, '/tmp/test-state');

      await store.initialize();

      // Verify data was loaded across multiple types
      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('agent')).toHaveLength(1);
    });

    it('should normalize persisted activation names and filenames on restore', async () => {
      const persisted = {
        version: 1,
        sessionId: 'default',
        lastUpdated: '2026-02-25T00:00:00Z',
        activations: {
          skill: [{ name: 'Cafe\u0301 Skill', activatedAt: '2026-02-25T00:00:00Z' }],
          persona: [{ name: 'Jose\u0301 Persona', filename: 'resume\u0301.md', activatedAt: '2026-02-25T00:00:00Z' }],
        },
      };
      mockFileOps = createMockFileOps({ readFileResult: JSON.stringify(persisted) });
      store = new ActivationStore(mockFileOps, '/tmp/test-state');

      await store.initialize();

      expect(store.getActivations('skill')[0].name).toBe('Café Skill');
      expect(store.getActivations('persona')[0].name).toBe('José Persona');
      expect(store.getActivations('persona')[0].filename).toBe('resumé.md');
    });
  });

  describe('recordActivation()', () => {
    it('should add an activation for a valid element type', () => {
      store.recordActivation('skill', 'code-reviewer');

      const activations = store.getActivations('skill');
      expect(activations).toHaveLength(1);
      expect(activations[0].name).toBe('code-reviewer');
      expect(activations[0].activatedAt).toBeDefined();
    });

    it('should store filename for personas', () => {
      store.recordActivation('persona', 'Creative Dev', 'creative-dev-abc.md');

      const activations = store.getActivations('persona');
      expect(activations).toHaveLength(1);
      expect(activations[0].name).toBe('Creative Dev');
      expect(activations[0].filename).toBe('creative-dev-abc.md');
    });

    it('should not include filename field for non-persona types', () => {
      store.recordActivation('skill', 'my-skill');

      const activations = store.getActivations('skill');
      expect(activations[0]).not.toHaveProperty('filename');
    });

    it('should deduplicate — no double activation', () => {
      store.recordActivation('skill', 'code-reviewer');
      store.recordActivation('skill', 'code-reviewer');

      expect(store.getActivations('skill')).toHaveLength(1);
    });

    it('should deduplicate canonical-equivalent Unicode names', () => {
      store.recordActivation('skill', 'Cafe\u0301 Skill');
      store.recordActivation('skill', 'Café Skill');

      const activations = store.getActivations('skill');
      expect(activations).toHaveLength(1);
      expect(activations[0].name).toBe('Café Skill');
    });

    it('should ignore unknown element types', () => {
      store.recordActivation('template', 'my-template');
      expect(store.getActivations('template')).toEqual([]);
    });

    it('should trigger persist on successful recording', async () => {
      store.recordActivation('skill', 'code-reviewer');

      // Allow fire-and-forget persist to execute
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFileOps.writeFile).toHaveBeenCalled();
      const writtenContent = JSON.parse(mockFileOps.writeFile.mock.calls[0][1]);
      expect(writtenContent.version).toBe(1);
      expect(writtenContent.activations.skill).toHaveLength(1);
    });

    it('should not persist when disabled', async () => {
      process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = 'false';
      store = new ActivationStore(mockFileOps, '/tmp/test-state');

      store.recordActivation('skill', 'code-reviewer');

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFileOps.writeFile).not.toHaveBeenCalled();
      expect(store.getActivations('skill')).toEqual([]);
    });

    it('should handle case-insensitive element types', () => {
      store.recordActivation('Skill', 'my-skill');
      expect(store.getActivations('skill')).toHaveLength(1);
    });

    it('should normalize plural ElementType values to singular', () => {
      // ElementType enum uses plural forms: 'skills', 'personas', etc.
      store.recordActivation('skills', 'plural-skill');
      store.recordActivation('personas', 'plural-persona');
      store.recordActivation('agents', 'plural-agent');
      store.recordActivation('memories', 'plural-memory');
      store.recordActivation('ensembles', 'plural-ensemble');

      // Should be retrievable via singular form
      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('persona')).toHaveLength(1);
      expect(store.getActivations('agent')).toHaveLength(1);
      expect(store.getActivations('memory')).toHaveLength(1);
      expect(store.getActivations('ensemble')).toHaveLength(1);

      // Should also be retrievable via plural form
      expect(store.getActivations('skills')).toHaveLength(1);
      expect(store.getActivations('personas')).toHaveLength(1);
    });

    it('should deduplicate across plural and singular type forms', () => {
      store.recordActivation('skill', 'code-reviewer');
      store.recordActivation('skills', 'code-reviewer'); // should be deduped
      expect(store.getActivations('skill')).toHaveLength(1);
    });
  });

  describe('recordDeactivation()', () => {
    it('should remove a previously activated element', () => {
      store.recordActivation('skill', 'code-reviewer');
      store.recordActivation('skill', 'debugger');
      expect(store.getActivations('skill')).toHaveLength(2);

      store.recordDeactivation('skill', 'code-reviewer');
      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('skill')[0].name).toBe('debugger');
    });

    it('should not trigger persist when nothing changes', async () => {
      store.recordDeactivation('skill', 'nonexistent');

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFileOps.writeFile).not.toHaveBeenCalled();
    });

    it('should handle deactivation of non-activated element gracefully', () => {
      expect(() => store.recordDeactivation('skill', 'never-activated')).not.toThrow();
    });

    it('should deactivate canonical-equivalent Unicode names', () => {
      store.recordActivation('skill', 'Cafe\u0301 Skill');
      expect(store.getActivations('skill')).toHaveLength(1);

      store.recordDeactivation('skill', 'Café Skill');
      expect(store.getActivations('skill')).toHaveLength(0);
    });
  });

  describe('removeStaleActivation()', () => {
    it('should remove stale entries', () => {
      store.recordActivation('agent', 'old-agent');
      expect(store.getActivations('agent')).toHaveLength(1);

      store.removeStaleActivation('agent', 'old-agent');
      expect(store.getActivations('agent')).toHaveLength(0);
    });
  });

  describe('getActivations()', () => {
    it('should return empty array for element type with no activations', () => {
      expect(store.getActivations('agent')).toEqual([]);
    });

    it('should return a copy, not a reference', () => {
      store.recordActivation('skill', 'my-skill');

      const activations1 = store.getActivations('skill');
      const activations2 = store.getActivations('skill');

      expect(activations1).toEqual(activations2);
      expect(activations1).not.toBe(activations2);
    });
  });

  describe('clearAll()', () => {
    it('should remove all activations', () => {
      store.recordActivation('skill', 'skill-1');
      store.recordActivation('agent', 'agent-1');
      store.recordActivation('persona', 'persona-1');

      store.clearAll();

      expect(store.getActivations('skill')).toEqual([]);
      expect(store.getActivations('agent')).toEqual([]);
      expect(store.getActivations('persona')).toEqual([]);
    });

    it('should trigger persist', async () => {
      store.recordActivation('skill', 'skill-1');
      jest.clearAllMocks();

      store.clearAll();

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(mockFileOps.writeFile).toHaveBeenCalled();
    });
  });

  describe('persistence', () => {
    it('should write valid JSON with correct structure', async () => {
      store.recordActivation('skill', 'my-skill');
      store.recordActivation('agent', 'my-agent');

      await new Promise(resolve => setTimeout(resolve, 10));

      // Get the last write call
      const lastCall = mockFileOps.writeFile.mock.calls[mockFileOps.writeFile.mock.calls.length - 1];
      const written = JSON.parse(lastCall[1]);

      expect(written.version).toBe(1);
      expect(written.sessionId).toBe('default');
      expect(written.lastUpdated).toBeDefined();
      expect(written.activations.skill).toHaveLength(1);
      expect(written.activations.agent).toHaveLength(1);
    });

    it('should write to session-specific file path', async () => {
      process.env.DOLLHOUSE_SESSION_ID = 'zulip-bridge';
      store = new ActivationStore(mockFileOps, '/tmp/test-state');

      store.recordActivation('skill', 'my-skill');

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFileOps.writeFile).toHaveBeenCalledWith(
        path.join('/tmp/test-state', 'activations-zulip-bridge.json'),
        expect.any(String)
      );
    });

    it('should handle write failures gracefully — in-memory state preserved', async () => {
      mockFileOps = createMockFileOps({ writeFileError: new Error('Disk full') });
      store = new ActivationStore(mockFileOps, '/tmp/test-state');

      // Should not throw even when disk write fails
      store.recordActivation('skill', 'my-skill');

      await new Promise(resolve => setTimeout(resolve, 50));

      // In-memory state should still be updated despite disk failure
      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('skill')[0].name).toBe('my-skill');
    });
  });

  describe('round-trip persistence', () => {
    it('should survive a write → read cycle', async () => {
      // Write phase
      store.recordActivation('skill', 'code-reviewer');
      store.recordActivation('persona', 'Creative Dev', 'creative-dev.md');
      store.recordActivation('memory', 'session-notes');

      await new Promise(resolve => setTimeout(resolve, 10));

      // Capture what was written
      const writtenContent = mockFileOps.writeFile.mock.calls[mockFileOps.writeFile.mock.calls.length - 1][1];

      // Read phase — create new store that reads the written content
      const readMockFileOps = createMockFileOps({ readFileResult: writtenContent });
      const store2 = new ActivationStore(readMockFileOps, '/tmp/test-state');
      await store2.initialize();

      expect(store2.getActivations('skill')).toHaveLength(1);
      expect(store2.getActivations('skill')[0].name).toBe('code-reviewer');
      expect(store2.getActivations('persona')).toHaveLength(1);
      expect(store2.getActivations('persona')[0].filename).toBe('creative-dev.md');
      expect(store2.getActivations('memory')).toHaveLength(1);
      expect(store2.getActivations('memory')[0].name).toBe('session-notes');
    });
  });
});
