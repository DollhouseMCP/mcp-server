/**
 * Unit tests for SessionContext interface and SYSTEM_CONTEXT sentinel
 */

import { describe, it, expect } from '@jest/globals';
import type { SessionContext } from '../../../src/context/SessionContext.js';
import { SYSTEM_CONTEXT } from '../../../src/context/ContextPolicy.js';

describe('SYSTEM_CONTEXT', () => {
  it('should be frozen', () => {
    expect(Object.isFrozen(SYSTEM_CONTEXT)).toBe(true);
  });

  it('should have userId "system"', () => {
    expect(SYSTEM_CONTEXT.userId).toBe('system');
  });

  it('should have sessionId "system"', () => {
    expect(SYSTEM_CONTEXT.sessionId).toBe('system');
  });

  it('should have null tenantId', () => {
    expect(SYSTEM_CONTEXT.tenantId).toBeNull();
  });

  it('should have transport "stdio"', () => {
    expect(SYSTEM_CONTEXT.transport).toBe('stdio');
  });

  it('should have createdAt of 0', () => {
    expect(SYSTEM_CONTEXT.createdAt).toBe(0);
  });

  it('should not allow mutation', () => {
    expect(() => {
      (SYSTEM_CONTEXT as any).userId = 'hacked';
    }).toThrow();
  });

  it('should satisfy SessionContext interface shape', () => {
    const session: SessionContext = SYSTEM_CONTEXT;
    expect(session).toBeDefined();
    expect(session.userId).toBe('system');
  });
});
