import { describe, expect, it, jest } from '@jest/globals';
import {
  attachAuthorizationDiagnosticHandlers,
  projectAuthorizationDiagnostic,
} from '../../../../src/auth/embedded-as/EmbeddedAuthorizationServer.js';

class EventSource {
  private readonly listeners = new Map<string, (...args: unknown[]) => void>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, listener);
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.(...args);
  }
}

describe('embedded authorization diagnostics', () => {
  it('classifies the pinned provider no-scope failure using finite fields only', () => {
    const diagnostic = projectAuthorizationDiagnostic(
      'authorization.error',
      {
        oidc: {
          route: 'resume',
          params: {
            scope: undefined,
            redirect_uri: 'https://client.example/callback?code=secret-code',
            client_id: 'private-client-id',
          },
        },
        headers: { cookie: 'session=secret-cookie' },
      },
      {
        error: 'access_denied',
        error_detail: 'authorization request resolved without requesting interactions but no scope was granted',
        token: 'secret-token',
        email: 'person@example.com',
      },
    );

    expect(diagnostic).toEqual({
      providerEvent: 'authorization.error',
      errorCode: 'access_denied',
      reason: 'no_scope_granted',
      hasRequestedScope: false,
    });
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toMatch(/secret|client\.example|person@|cookie|redirect|token/i);
  });

  it.each([
    [{ error: 'access_denied', error_description: 'End-User denied client authorization' }, 'access_denied', 'end_user_denied'],
    [{ error: 'invalid_scope', error_detail: 'untrusted detail' }, 'invalid_scope', 'oauth_error'],
    [{ error: 'attacker-controlled-code', error_detail: 'https://evil.example/?token=secret' }, 'other', 'oauth_error'],
  ] as const)('projects supported and malicious errors safely', (error, errorCode, reason) => {
    expect(projectAuthorizationDiagnostic('authorization.error', {
      oidc: { params: { scope: 'mcp' } },
    }, error)).toEqual({
      providerEvent: 'authorization.error',
      errorCode,
      reason,
      hasRequestedScope: true,
    });
  });

  it('wires each terminal event to exactly one outcome and isolates handler failures', () => {
    const provider = new EventSource();
    const logFailure = jest.fn<() => void>(() => { throw new Error('log sink failed'); });
    const recordOutcome = jest.fn<() => void>(() => { throw new Error('metrics sink failed'); });
    attachAuthorizationDiagnosticHandlers(provider, { logFailure, recordOutcome });

    expect(() => provider.emit('authorization.error', {}, { error: 'invalid_scope' })).not.toThrow();
    expect(() => provider.emit('server_error', { oidc: { route: 'resume' } }, { error: 'server_error' })).not.toThrow();
    expect(() => provider.emit('server_error', { oidc: { route: 'token' } }, { error: 'server_error' })).not.toThrow();

    expect(logFailure).toHaveBeenCalledTimes(2);
    expect(recordOutcome).toHaveBeenCalledTimes(2);
    expect(recordOutcome).toHaveBeenNthCalledWith(1, 'oauth_error');
    expect(recordOutcome).toHaveBeenNthCalledWith(2, 'server_error');
  });

  it('contains hostile payload getters before they can affect the provider', () => {
    const provider = new EventSource();
    const logFailure = jest.fn();
    const recordOutcome = jest.fn();
    attachAuthorizationDiagnosticHandlers(provider, { logFailure, recordOutcome });
    const hostileContext = Object.defineProperty({}, 'oidc', {
      get: () => { throw new Error('hostile getter'); },
    });

    expect(() => provider.emit('authorization.error', hostileContext, { error: 'access_denied' })).not.toThrow();
    expect(() => provider.emit('server_error', hostileContext, { error: 'server_error' })).not.toThrow();
    expect(logFailure).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it('counts only the first terminal outcome emitted for a provider context', () => {
    const provider = new EventSource();
    const logFailure = jest.fn();
    const recordOutcome = jest.fn();
    attachAuthorizationDiagnosticHandlers(provider, { logFailure, recordOutcome });
    const duplicateFailureContext = { oidc: { route: 'resume' } };

    provider.emit('authorization.error', duplicateFailureContext, { error: 'invalid_scope' });
    provider.emit('authorization.error', duplicateFailureContext, { error: 'invalid_scope' });

    expect(recordOutcome.mock.calls).toEqual([['oauth_error']]);
    expect(logFailure).toHaveBeenCalledTimes(1);
  });
});
