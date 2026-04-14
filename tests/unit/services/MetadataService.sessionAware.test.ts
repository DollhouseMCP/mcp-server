/**
 * Unit tests for MetadataService session-aware identity resolution.
 *
 * Tests the priority chain introduced in Issue #1946:
 * 1. SessionActivationState.userIdentity (session-scoped override)
 * 2. SessionContext identity (HTTP auth, DOLLHOUSE_USER at startup)
 * 3. Singleton fallback (env → OS → anonymous)
 *
 * @since v2.1.0 — Issue #1946
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

const { MetadataService } = await import('../../../src/services/MetadataService.js');
const { ContextTracker } = await import('../../../src/security/encryption/ContextTracker.js');
const { SessionActivationRegistry } = await import('../../../src/state/SessionActivationState.js');
const { SYSTEM_CONTEXT } = await import('../../../src/context/ContextPolicy.js');

describe('MetadataService — session-aware getCurrentUser (Issue #1946)', () => {
  let service: InstanceType<typeof MetadataService>;
  let tracker: InstanceType<typeof ContextTracker>;
  let registry: InstanceType<typeof SessionActivationRegistry>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DOLLHOUSE_USER;
    service = new MetadataService();
    tracker = new ContextTracker();
    registry = new SessionActivationRegistry('default');
    service.configureSessionAwareness(tracker, registry);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns session userIdentity override when set', async () => {
    const state = registry.getOrCreate('session-1');
    state.userIdentity = { username: 'alice', email: 'alice@example.com' };

    const session = {
      userId: 'http-user',
      sessionId: 'session-1',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
    };
    const ctx = tracker.createSessionContext('llm-request', session);

    let result: string | undefined;
    await tracker.runAsync(ctx, async () => {
      result = service.getCurrentUser();
    });

    expect(result).toBe('alice');
  });

  it('returns SessionContext userId when no userIdentity override', async () => {
    registry.getOrCreate('session-2');

    const session = {
      userId: 'bob-from-jwt',
      sessionId: 'session-2',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
    };
    const ctx = tracker.createSessionContext('llm-request', session);

    let result: string | undefined;
    await tracker.runAsync(ctx, async () => {
      result = service.getCurrentUser();
    });

    expect(result).toBe('bob-from-jwt');
  });

  it('returns SessionContext displayName over userId when available', async () => {
    registry.getOrCreate('session-3');

    const session = {
      userId: 'user-id-123',
      sessionId: 'session-3',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      displayName: 'Charlie Display',
    };
    const ctx = tracker.createSessionContext('llm-request', session);

    let result: string | undefined;
    await tracker.runAsync(ctx, async () => {
      result = service.getCurrentUser();
    });

    expect(result).toBe('Charlie Display');
  });

  it('skips system userId and falls through to env/OS', async () => {
    const session = {
      userId: SYSTEM_CONTEXT.userId,
      sessionId: 'system',
      tenantId: null,
      transport: 'stdio' as const,
      createdAt: Date.now(),
    };
    const ctx = tracker.createSessionContext('llm-request', session);

    let result: string | undefined;
    await tracker.runAsync(ctx, async () => {
      result = service.getCurrentUser();
    });

    // Should NOT be 'system' — should fall through to env/OS chain
    expect(result).not.toBe('system');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
  });

  it('returns local-user for stdio sessions (not skipped)', async () => {
    registry.getOrCreate('default');

    const session = {
      userId: 'local-user',
      sessionId: 'default',
      tenantId: null,
      transport: 'stdio' as const,
      createdAt: Date.now(),
    };
    const ctx = tracker.createSessionContext('llm-request', session);

    let result: string | undefined;
    await tracker.runAsync(ctx, async () => {
      result = service.getCurrentUser();
    });

    expect(result).toBe('local-user');
  });

  it('falls back to env/OS when no session context is active', () => {
    // No runAsync wrapping — no session context
    const result = service.getCurrentUser();

    // Should resolve from env or OS, not crash
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('works without session awareness configured', () => {
    const plainService = new MetadataService();
    // No configureSessionAwareness called
    const result = plainService.getCurrentUser();

    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('prefers userIdentity over SessionContext userId', async () => {
    const state = registry.getOrCreate('session-priority');
    state.userIdentity = { username: 'identity-override' };

    const session = {
      userId: 'session-context-user',
      sessionId: 'session-priority',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      displayName: 'Session Display Name',
    };
    const ctx = tracker.createSessionContext('llm-request', session);

    let result: string | undefined;
    await tracker.runAsync(ctx, async () => {
      result = service.getCurrentUser();
    });

    expect(result).toBe('identity-override');
  });
});
