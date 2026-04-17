import { describe, expect, it } from '@jest/globals';
import { resolveSessionIdentity } from '../../../src/services/sessionIdentity.js';

describe('sessionIdentity', () => {
  it('uses explicit environment identity unchanged', () => {
    const identity = resolveSessionIdentity({
      envValue: 'claude-code-main',
      cwd: '/tmp/project',
      homeDir: '/tmp/home',
      pid: 1234,
    });

    expect(identity).toEqual({
      sessionId: 'claude-code-main',
      runtimeSessionId: 'claude-code-main',
      source: 'env',
    });
  });

  it('derives a restart-stable session identity from workspace context', () => {
    const identityA = resolveSessionIdentity({
      cwd: '/Users/mick/project-a',
      homeDir: '/Users/mick',
      pid: 1234,
    });
    const identityB = resolveSessionIdentity({
      cwd: '/Users/mick/project-a',
      homeDir: '/Users/mick',
      pid: 5678,
    });

    expect(identityA.sessionId).toBe(identityB.sessionId);
    expect(identityA.sessionId).toMatch(/^local-[a-f0-9]{10}$/);
    expect(identityA.runtimeSessionId).not.toBe(identityB.runtimeSessionId);
    expect(identityA.runtimeSessionId).toBe(`${identityA.sessionId}-${(1234).toString(36)}`);
    expect(identityA.source).toBe('derived');
  });

  it('falls back to the derived identity when the environment value is invalid', () => {
    const identity = resolveSessionIdentity({
      envValue: '../evil',
      cwd: '/Users/mick/project-a',
      homeDir: '/Users/mick',
      pid: 1234,
    });

    expect(identity.sessionId).toMatch(/^local-[a-f0-9]{10}$/);
    expect(identity.runtimeSessionId).toBe(`${identity.sessionId}-${(1234).toString(36)}`);
    expect(identity.source).toBe('derived');
  });
});
