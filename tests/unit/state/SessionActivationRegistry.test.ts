/**
 * Unit tests for SessionActivationState and SessionActivationRegistry
 *
 * Tests session-scoped activation state management — creation, lookup,
 * disposal, isolation between sessions.
 *
 * Issue #1946
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { SessionActivationRegistry, createSessionActivationState } =
  await import('../../../src/state/SessionActivationState.js');

describe('createSessionActivationState', () => {
  it('should create state with empty Sets and given sessionId', () => {
    const state = createSessionActivationState('test-session');
    expect(state.sessionId).toBe('test-session');
    expect(state.personas.size).toBe(0);
    expect(state.skills.size).toBe(0);
    expect(state.agents.size).toBe(0);
    expect(state.memories.size).toBe(0);
    expect(state.ensembles.size).toBe(0);
    expect(state.userIdentity).toBeUndefined();
  });

  it('should create independent instances', () => {
    const a = createSessionActivationState('a');
    const b = createSessionActivationState('b');
    a.skills.add('skill-1');
    expect(b.skills.size).toBe(0);
  });
});

describe('SessionActivationRegistry', () => {
  let registry: InstanceType<typeof SessionActivationRegistry>;

  beforeEach(() => {
    registry = new SessionActivationRegistry('default-session');
  });

  describe('getDefaultSessionId()', () => {
    it('should return the default session ID', () => {
      expect(registry.getDefaultSessionId()).toBe('default-session');
    });
  });

  describe('getOrCreate()', () => {
    it('should create state on first call', () => {
      const state = registry.getOrCreate('session-1');
      expect(state.sessionId).toBe('session-1');
      expect(state.skills.size).toBe(0);
      expect(registry.size).toBe(1);
    });

    it('should return same instance on repeated calls with same id', () => {
      const first = registry.getOrCreate('session-1');
      first.skills.add('my-skill');
      const second = registry.getOrCreate('session-1');
      expect(second).toBe(first);
      expect(second.skills.has('my-skill')).toBe(true);
    });

    it('should create independent states for different sessions', () => {
      const a = registry.getOrCreate('session-a');
      const b = registry.getOrCreate('session-b');
      a.skills.add('skill-a');
      b.skills.add('skill-b');

      expect(a.skills.has('skill-a')).toBe(true);
      expect(a.skills.has('skill-b')).toBe(false);
      expect(b.skills.has('skill-b')).toBe(true);
      expect(b.skills.has('skill-a')).toBe(false);
      expect(registry.size).toBe(2);
    });
  });

  describe('get()', () => {
    it('should return undefined for unknown session', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('should return state for known session', () => {
      registry.getOrCreate('session-1');
      expect(registry.get('session-1')).toBeDefined();
      expect(registry.get('session-1')!.sessionId).toBe('session-1');
    });
  });

  describe('dispose()', () => {
    it('should remove session state', () => {
      registry.getOrCreate('session-1');
      expect(registry.size).toBe(1);

      registry.dispose('session-1');
      expect(registry.get('session-1')).toBeUndefined();
      expect(registry.size).toBe(0);
    });

    it('should not affect other sessions', () => {
      registry.getOrCreate('session-a');
      registry.getOrCreate('session-b');

      registry.dispose('session-a');
      expect(registry.get('session-a')).toBeUndefined();
      expect(registry.get('session-b')).toBeDefined();
    });

    it('should be safe to call on nonexistent session', () => {
      expect(() => registry.dispose('nonexistent')).not.toThrow();
    });
  });

  describe('session isolation', () => {
    it('should isolate activation state across all element types', () => {
      const sessionA = registry.getOrCreate('session-a');
      const sessionB = registry.getOrCreate('session-b');

      sessionA.personas.add('persona-a.md');
      sessionA.skills.add('skill-a');
      sessionA.agents.add('agent-a');
      sessionA.memories.add('memory-a');
      sessionA.ensembles.add('ensemble-a');

      sessionB.personas.add('persona-b.md');
      sessionB.skills.add('skill-b');

      // Session A has its own elements
      expect(sessionA.personas.has('persona-a.md')).toBe(true);
      expect(sessionA.personas.has('persona-b.md')).toBe(false);
      expect(sessionA.skills.has('skill-a')).toBe(true);
      expect(sessionA.skills.has('skill-b')).toBe(false);

      // Session B has its own elements
      expect(sessionB.personas.has('persona-b.md')).toBe(true);
      expect(sessionB.personas.has('persona-a.md')).toBe(false);
      expect(sessionB.agents.size).toBe(0);
      expect(sessionB.memories.size).toBe(0);
    });

    it('should isolate userIdentity overrides', () => {
      const sessionA = registry.getOrCreate('session-a');
      const sessionB = registry.getOrCreate('session-b');

      sessionA.userIdentity = { username: 'alice', email: 'alice@example.com' };

      expect(sessionA.userIdentity?.username).toBe('alice');
      expect(sessionB.userIdentity).toBeUndefined();
    });
  });

  describe('size', () => {
    it('should track active session count', () => {
      expect(registry.size).toBe(0);
      registry.getOrCreate('a');
      expect(registry.size).toBe(1);
      registry.getOrCreate('b');
      expect(registry.size).toBe(2);
      registry.dispose('a');
      expect(registry.size).toBe(1);
    });
  });
});
