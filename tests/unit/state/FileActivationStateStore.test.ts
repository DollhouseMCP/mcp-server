/**
 * Unit tests for FileActivationStateStore
 *
 * Tests file-backed activation state persistence — persist/restore cycle,
 * ENOENT tolerance, element type normalization, session ID validation,
 * security event logging, and Unicode handling.
 *
 * Issue #1945, Pre-Phase 4 Store Consolidation
 */

import path from 'path';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

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
    readElementFile: jest.fn<() => Promise<string>>().mockResolvedValue(''),
    deleteFile: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    fileExists: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    listFiles: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
    ensureDirectory: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as ReturnType<typeof createMockFileOps>;
}

describe('FileActivationStateStore', () => {
  let store: InstanceType<typeof FileActivationStateStore>;
  let mockFileOps: ReturnType<typeof createMockFileOps>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DOLLHOUSE_SESSION_ID;
    delete process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE;
    mockFileOps = createMockFileOps();
    store = new FileActivationStateStore(mockFileOps, '/tmp/test-state', 'test-session');
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── Session Identity ────────────────────────────────────────────────

  describe('session identity', () => {
    it('should use the provided sessionId', () => {
      expect(store.getSessionId()).toBe('test-session');
    });

    it('should reject invalid sessionId and fall back to default', () => {
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test', '../evil-path');
      expect(s.getSessionId()).toBe('default');
    });

    it('should generate unique session ID when env var not set and no param', () => {
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test');
      expect(s.getSessionId()).toMatch(/^session-[a-z0-9]+-[a-f0-9]+$/);
    });

    it('should use DOLLHOUSE_SESSION_ID when set and no param', () => {
      process.env.DOLLHOUSE_SESSION_ID = 'my-session';
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test');
      expect(s.getSessionId()).toBe('my-session');
    });

    it('should fall back to default for invalid env session ID', () => {
      process.env.DOLLHOUSE_SESSION_ID = '../evil-path';
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test');
      expect(s.getSessionId()).toBe('default');
    });

    it('should generate unique session ID for empty env session ID', () => {
      process.env.DOLLHOUSE_SESSION_ID = '  ';
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test');
      expect(s.getSessionId()).toMatch(/^session-[a-z0-9]+-[a-f0-9]+$/);
    });

    it('should accept alphanumeric with hyphens and underscores', () => {
      process.env.DOLLHOUSE_SESSION_ID = 'claude-code_v2';
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test');
      expect(s.getSessionId()).toBe('claude-code_v2');
    });

    it('should reject session IDs starting with a number', () => {
      process.env.DOLLHOUSE_SESSION_ID = '123-session';
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test');
      expect(s.getSessionId()).toBe('default');
    });

    it('should prefer explicit sessionId over env var', () => {
      process.env.DOLLHOUSE_SESSION_ID = 'from-env';
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test', 'from-param');
      expect(s.getSessionId()).toBe('from-param');
    });

    it('should fall back to resolveSessionId when sessionId param is empty', () => {
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test', '');
      expect(s.getSessionId()).toMatch(/^session-[a-z0-9]+-[a-f0-9]+$/);
    });

    it('should trim whitespace from provided sessionId', () => {
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test', '  valid-session  ');
      expect(s.getSessionId()).toBe('valid-session');
    });

    it('should reject param sessionId starting with number', () => {
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test', '123-bad');
      expect(s.getSessionId()).toBe('default');
    });
  });

  // ── Enabled/Disabled ────────────────────────────────────────────────

  describe('persistence enabled/disabled', () => {
    it('should be enabled by default', () => {
      expect(store.isEnabled()).toBe(true);
    });

    it('should respect DOLLHOUSE_ACTIVATION_PERSISTENCE=false', () => {
      process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = 'false';
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test', 'test-session');
      expect(s.isEnabled()).toBe(false);
    });

    it('should respect DOLLHOUSE_ACTIVATION_PERSISTENCE=0', () => {
      process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = '0';
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test', 'test-session');
      expect(s.isEnabled()).toBe(false);
    });

    it('should not persist when disabled', async () => {
      process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = 'false';
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test', 'test-session');

      s.recordActivation('skill', 'code-reviewer');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFileOps.writeFile).not.toHaveBeenCalled();
      expect(s.getActivations('skill')).toEqual([]);
    });

    it('should skip initialization when persistence is disabled', async () => {
      process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = 'false';
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test', 'test-session');

      await s.initialize();

      expect(mockFileOps.readFile).not.toHaveBeenCalled();
    });
  });

  // ── Initialize ──────────────────────────────────────────────────────

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
      store = new FileActivationStateStore(mockFileOps, '/tmp/test-state', 'test-session');

      await store.initialize();

      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('skill')[0].name).toBe('valid-skill');
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
      store = new FileActivationStateStore(mockFileOps, '/tmp/test-state', 'test-session');

      await store.initialize();

      expect(store.getActivations('skill')[0].name).toBe('Café Skill');
      expect(store.getActivations('persona')[0].name).toBe('José Persona');
      expect(store.getActivations('persona')[0].filename).toBe('resumé.md');
    });
  });

  // ── recordActivation ────────────────────────────────────────────────

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
      expect(store.getActivations('skill')[0]).not.toHaveProperty('filename');
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
      store.recordActivation('webhook', 'my-webhook');
      expect(store.getActivations('webhook')).toEqual([]);
    });

    it('should handle case-insensitive element types', () => {
      store.recordActivation('Skill', 'my-skill');
      expect(store.getActivations('skill')).toHaveLength(1);
    });

    it('should normalize plural ElementType values to singular', () => {
      store.recordActivation('skills', 'plural-skill');
      store.recordActivation('personas', 'plural-persona');
      store.recordActivation('agents', 'plural-agent');
      store.recordActivation('memories', 'plural-memory');
      store.recordActivation('ensembles', 'plural-ensemble');

      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('persona')).toHaveLength(1);
      expect(store.getActivations('agent')).toHaveLength(1);
      expect(store.getActivations('memory')).toHaveLength(1);
      expect(store.getActivations('ensemble')).toHaveLength(1);
    });

    it('should deduplicate across plural and singular type forms', () => {
      store.recordActivation('skill', 'code-reviewer');
      store.recordActivation('skills', 'code-reviewer');
      expect(store.getActivations('skill')).toHaveLength(1);
    });

    it('should trigger persist on successful recording', async () => {
      store.recordActivation('skill', 'code-reviewer');

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFileOps.writeFile).toHaveBeenCalled();
      const writtenContent = JSON.parse(mockFileOps.writeFile.mock.calls[0][1]);
      expect(writtenContent.version).toBe(1);
      expect(writtenContent.activations.skill).toHaveLength(1);
    });

    it('should log ELEMENT_ACTIVATED security event', async () => {
      const { SecurityMonitor } = await import('../../../src/security/securityMonitor.js');
      const spy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');

      store.recordActivation('skill', 'code-reviewer');

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ELEMENT_ACTIVATED',
          source: 'FileActivationStateStore.recordActivation',
        })
      );

      spy.mockRestore();
    });

    it('should NOT log ELEMENT_ACTIVATED on duplicate (dedup guard)', async () => {
      const { SecurityMonitor } = await import('../../../src/security/securityMonitor.js');
      const spy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');

      store.recordActivation('skill', 'code-reviewer');
      spy.mockClear();

      store.recordActivation('skill', 'code-reviewer');
      expect(spy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ELEMENT_ACTIVATED' })
      );

      spy.mockRestore();
    });
  });

  // ── recordDeactivation ──────────────────────────────────────────────

  describe('recordDeactivation()', () => {
    it('should remove a previously activated element', () => {
      store.recordActivation('skill', 'code-reviewer');
      store.recordActivation('skill', 'debugger');
      expect(store.getActivations('skill')).toHaveLength(2);

      store.recordDeactivation('skill', 'code-reviewer');
      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('skill')[0].name).toBe('debugger');
    });

    it('should handle deactivation of non-activated element gracefully', () => {
      expect(() => store.recordDeactivation('skill', 'never-activated')).not.toThrow();
    });

    it('should not trigger persist when nothing changes', async () => {
      store.recordDeactivation('skill', 'nonexistent');

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFileOps.writeFile).not.toHaveBeenCalled();
    });

    it('should deactivate canonical-equivalent Unicode names', () => {
      store.recordActivation('skill', 'Cafe\u0301 Skill');
      expect(store.getActivations('skill')).toHaveLength(1);

      store.recordDeactivation('skill', 'Café Skill');
      expect(store.getActivations('skill')).toHaveLength(0);
    });

    it('should log ELEMENT_DEACTIVATED security event', async () => {
      // Re-import SecurityMonitor mock to verify it's wired up
      const { SecurityMonitor } = await import('../../../src/security/securityMonitor.js');
      const spy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');

      store.recordActivation('skill', 'code-reviewer');
      expect(store.getActivations('skill')).toHaveLength(1);

      spy.mockClear();
      store.recordDeactivation('skill', 'code-reviewer');
      expect(store.getActivations('skill')).toHaveLength(0);

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ELEMENT_DEACTIVATED',
          source: 'FileActivationStateStore.recordDeactivation',
        })
      );

      spy.mockRestore();
    });

    it('should NOT log ELEMENT_DEACTIVATED when element is not present', async () => {
      const { SecurityMonitor } = await import('../../../src/security/securityMonitor.js');
      const spy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');

      store.recordDeactivation('skill', 'nonexistent');

      expect(spy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ELEMENT_DEACTIVATED' })
      );

      spy.mockRestore();
    });
  });

  // ── removeStaleActivation ───────────────────────────────────────────

  describe('removeStaleActivation()', () => {
    it('should remove stale entries', () => {
      store.recordActivation('agent', 'old-agent');
      expect(store.getActivations('agent')).toHaveLength(1);

      store.removeStaleActivation('agent', 'old-agent');
      expect(store.getActivations('agent')).toHaveLength(0);
    });
  });

  // ── getActivations ─────────────────────────────────────────────────

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

  // ── clearAll ────────────────────────────────────────────────────────

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

  // ── Persistence ─────────────────────────────────────────────────────

  describe('persistence', () => {
    it('should write valid JSON with correct structure', async () => {
      store.recordActivation('skill', 'my-skill');
      store.recordActivation('agent', 'my-agent');

      await new Promise(resolve => setTimeout(resolve, 10));

      const lastCall = mockFileOps.writeFile.mock.calls[mockFileOps.writeFile.mock.calls.length - 1];
      const written = JSON.parse(lastCall[1]);

      expect(written.version).toBe(1);
      expect(written.sessionId).toBe('test-session');
      expect(written.lastUpdated).toBeDefined();
      expect(written.activations.skill).toHaveLength(1);
      expect(written.activations.agent).toHaveLength(1);
    });

    it('should write to session-specific file path', async () => {
      const s = new FileActivationStateStore(mockFileOps, '/tmp/test-state', 'zulip-bridge');
      s.recordActivation('skill', 'my-skill');

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFileOps.writeFile).toHaveBeenCalledWith(
        path.join('/tmp/test-state', 'activations-zulip-bridge.json'),
        expect.any(String)
      );
    });

    it('should handle write failures gracefully — in-memory state preserved', async () => {
      mockFileOps = createMockFileOps({ writeFileError: new Error('Disk full') });
      store = new FileActivationStateStore(mockFileOps, '/tmp/test-state', 'test-session');

      store.recordActivation('skill', 'my-skill');

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(store.getActivations('skill')).toHaveLength(1);
      expect(store.getActivations('skill')[0].name).toBe('my-skill');
    });
  });

  // ── Round-Trip ──────────────────────────────────────────────────────

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

    it('should survive a write → read cycle across all element types', async () => {
      store.recordActivation('skill', 'code-reviewer');
      store.recordActivation('persona', 'Creative Dev', 'creative-dev.md');
      store.recordActivation('memory', 'session-notes');
      store.recordActivation('agent', 'my-agent');
      store.recordActivation('ensemble', 'my-ensemble');
      store.recordActivation('template', 'my-template');

      await new Promise(resolve => setTimeout(resolve, 10));

      const writtenContent = mockFileOps.writeFile.mock.calls[mockFileOps.writeFile.mock.calls.length - 1][1];

      const readMockFileOps = createMockFileOps({ readFileResult: writtenContent });
      const store2 = new FileActivationStateStore(readMockFileOps, '/tmp/test-state', 'test-session');
      await store2.initialize();

      expect(store2.getActivations('skill')).toHaveLength(1);
      expect(store2.getActivations('persona')).toHaveLength(1);
      expect(store2.getActivations('memory')).toHaveLength(1);
      expect(store2.getActivations('agent')).toHaveLength(1);
      expect(store2.getActivations('ensemble')).toHaveLength(1);
      expect(store2.getActivations('template')).toHaveLength(1);
    });
  });
});
