import { describe, expect, it, jest } from '@jest/globals';

import { instrumentAuthProvider } from '../../../src/auth/instrumentAuthProvider.js';
import type { AuthResult, IAuthProvider } from '../../../src/auth/IAuthProvider.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import type { PerformanceMonitor } from '../../../src/utils/PerformanceMonitor.js';

describe('instrumentAuthProvider', () => {
  it('times validation without duplicating concrete provider security events', async () => {
    const providerEvent = {
      type: 'TOKEN_VALIDATION_FAILURE',
      severity: 'MEDIUM',
      source: 'fixture-provider',
      details: 'Fixture token validation failed',
      additionalData: { reason: 'invalid signature' },
    } as const;
    const provider: IAuthProvider = {
      name: 'fixture',
      validate: jest.fn(async (): Promise<AuthResult> => {
        SecurityMonitor.logSecurityEvent(providerEvent);
        return { ok: false, reason: 'invalid signature' };
      }),
    };
    const monitor = {
      timeAuthOp: jest.fn(async <T>(_op: string, fn: () => Promise<T>): Promise<T> => fn()),
    } as unknown as PerformanceMonitor;
    const logSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});

    try {
      const instrumented = instrumentAuthProvider(provider, monitor);
      const result = await instrumented.validate('bad-token');

      expect(result).toEqual({ ok: false, reason: 'invalid signature' });
      expect(monitor.timeAuthOp).toHaveBeenCalledWith('auth.validateToken', expect.any(Function), 'fixture');
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(providerEvent);
    } finally {
      logSpy.mockRestore();
    }
  });
});
