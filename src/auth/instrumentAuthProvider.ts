/**
 * IAuthProvider instrumentation decorator.
 *
 * Wraps `validate(token)` with PerformanceMonitor timing so operators
 * can see token-validation latency in `/healthz`. For OIDC bridge mode
 * this includes the JWKS fetch + JWT signature verify; for the local-dev
 * provider it's just the local signing-key check. Separate from
 * `instrumentAuthMethod` (which decorates IAuthMethod entry points)
 * because IAuthProvider is the outer abstraction the HTTP middleware
 * calls on every request.
 *
 * Audit logging remains owned by concrete providers because they have the
 * issuer/key/source context operators need. This wrapper is performance-only
 * so one validation failure does not emit duplicate TOKEN_VALIDATION_FAILURE
 * events when a concrete provider already logged the failure.
 *
 * When `monitor` is undefined, returns the original provider untouched.
 *
 * @module auth/instrumentAuthProvider
 */

import type { IAuthProvider, AuthResult } from './IAuthProvider.js';
import type { PerformanceMonitor } from '../utils/PerformanceMonitor.js';

const OP_VALIDATE = 'auth.validateToken';

export function instrumentAuthProvider(
  provider: IAuthProvider,
  monitor?: PerformanceMonitor,
): IAuthProvider {
  if (!monitor) return provider;

  // Use a Proxy so optional methods (issue, getProtectedResourceMetadataUrl,
  // isReadyForTraffic, etc.) and properties (name) pass through unchanged.
  // Only validate() is wrapped — that's the per-request hot path the
  // metrics target.
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === 'validate') {
        return (token: string): Promise<AuthResult> =>
          monitor.timeAuthOp(OP_VALIDATE, () => target.validate(token), target.name);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
