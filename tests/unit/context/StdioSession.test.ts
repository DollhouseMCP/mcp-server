/**
 * Unit tests for StdioSession factory
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { createStdioSession } from '../../../src/context/StdioSession.js';

describe('createStdioSession', () => {
  const originalUser = process.env['DOLLHOUSE_USER'];
  const originalSession = process.env['DOLLHOUSE_SESSION_ID'];

  afterEach(() => {
    if (originalUser === undefined) {
      delete process.env['DOLLHOUSE_USER'];
    } else {
      process.env['DOLLHOUSE_USER'] = originalUser;
    }
    if (originalSession === undefined) {
      delete process.env['DOLLHOUSE_SESSION_ID'];
    } else {
      process.env['DOLLHOUSE_SESSION_ID'] = originalSession;
    }
  });

  it('should default userId to "local-user" when DOLLHOUSE_USER is unset', () => {
    delete process.env['DOLLHOUSE_USER'];
    const session = createStdioSession();
    expect(session.userId).toBe('local-user');
  });

  it('should use DOLLHOUSE_USER when set', () => {
    process.env['DOLLHOUSE_USER'] = 'alice';
    const session = createStdioSession();
    expect(session.userId).toBe('alice');
  });

  it('should default sessionId to "default" when DOLLHOUSE_SESSION_ID is unset', () => {
    delete process.env['DOLLHOUSE_SESSION_ID'];
    const session = createStdioSession();
    expect(session.sessionId).toBe('default');
  });

  it('should use DOLLHOUSE_SESSION_ID when set', () => {
    process.env['DOLLHOUSE_SESSION_ID'] = 'claude-code';
    const session = createStdioSession();
    expect(session.sessionId).toBe('claude-code');
  });

  it('should always have transport "stdio"', () => {
    const session = createStdioSession();
    expect(session.transport).toBe('stdio');
  });

  it('should always have tenantId null', () => {
    const session = createStdioSession();
    expect(session.tenantId).toBeNull();
  });

  it('should set createdAt to a recent timestamp', () => {
    const before = Date.now();
    const session = createStdioSession();
    const after = Date.now();
    expect(session.createdAt).toBeGreaterThanOrEqual(before);
    expect(session.createdAt).toBeLessThanOrEqual(after);
  });

  it('should return a frozen object', () => {
    const session = createStdioSession();
    expect(Object.isFrozen(session)).toBe(true);
  });

  it('should trim whitespace from DOLLHOUSE_USER', () => {
    process.env['DOLLHOUSE_USER'] = '  bob  ';
    const session = createStdioSession();
    expect(session.userId).toBe('bob');
  });

  it('should trim whitespace from DOLLHOUSE_SESSION_ID', () => {
    process.env['DOLLHOUSE_SESSION_ID'] = '  my-session  ';
    const session = createStdioSession();
    expect(session.sessionId).toBe('my-session');
  });
});
