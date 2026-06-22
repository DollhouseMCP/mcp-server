/**
 * Unit tests for ContextPolicy helpers
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  SYSTEM_CONTEXT,
  SessionContextRequiredError,
  isStrictMode,
  getSessionOrSystem,
} from '../../../src/context/ContextPolicy.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import type { SessionContext } from '../../../src/context/SessionContext.js';

const TEST_SESSION: SessionContext = Object.freeze({
  userId: 'test-user',
  sessionId: 'test-session',
  tenantId: null,
  transport: 'stdio' as const,
  createdAt: 1000000,
});

describe('SessionContextRequiredError', () => {
  it('should have name SessionContextRequiredError', () => {
    const err = new SessionContextRequiredError();
    expect(err.name).toBe('SessionContextRequiredError');
  });

  it('should include caller in message when provided', () => {
    const err = new SessionContextRequiredError('PersonaManager.activate');
    expect(err.message).toContain('PersonaManager.activate');
    expect(err.caller).toBe('PersonaManager.activate');
  });

  it('should be instanceof Error', () => {
    const err = new SessionContextRequiredError();
    expect(err).toBeInstanceOf(Error);
  });

  it('should have undefined caller when not provided', () => {
    const err = new SessionContextRequiredError();
    expect(err.caller).toBeUndefined();
  });
});

describe('isStrictMode', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalStrict = process.env['DOLLHOUSE_STRICT_CONTEXT'];

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
    if (originalStrict === undefined) {
      delete process.env['DOLLHOUSE_STRICT_CONTEXT'];
    } else {
      process.env['DOLLHOUSE_STRICT_CONTEXT'] = originalStrict;
    }
  });

  it('should return true in development', () => {
    process.env['NODE_ENV'] = 'development';
    expect(isStrictMode()).toBe(true);
  });

  it('should return true in test', () => {
    process.env['NODE_ENV'] = 'test';
    expect(isStrictMode()).toBe(true);
  });

  it('should return false in production without override', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['DOLLHOUSE_STRICT_CONTEXT'];
    expect(isStrictMode()).toBe(false);
  });

  it('should return true in production with DOLLHOUSE_STRICT_CONTEXT=true', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DOLLHOUSE_STRICT_CONTEXT'] = 'true';
    expect(isStrictMode()).toBe(true);
  });
});

describe('getSessionOrSystem', () => {
  let tracker: ContextTracker;

  beforeEach(() => {
    tracker = new ContextTracker();
  });

  it('should return SYSTEM_CONTEXT when no session is active', () => {
    const result = getSessionOrSystem(tracker);
    expect(result).toBe(SYSTEM_CONTEXT);
  });

  it('should return the active session when one exists', async () => {
    const context = tracker.createSessionContext('background-task', TEST_SESSION);
    let result: SessionContext | undefined;

    await tracker.runAsync(context, async () => {
      result = getSessionOrSystem(tracker);
    });

    expect(result?.userId).toBe('test-user');
    expect(result?.sessionId).toBe('test-session');
  });

  it('should not return SYSTEM_CONTEXT when a session is active', async () => {
    const context = tracker.createSessionContext('llm-request', TEST_SESSION);
    let result: SessionContext | undefined;

    await tracker.runAsync(context, async () => {
      result = getSessionOrSystem(tracker);
    });

    expect(result).not.toBe(SYSTEM_CONTEXT);
  });
});
