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
 * Same design intent as instrumentAuthMethod: wrap from outside so the
 * concrete provider class file is untouched (no SonarCloud complexity
 * re-flag on the existing validate() bodies).
 *
 * When `monitor` is undefined, returns the original provider untouched.
 *
 * @module auth/instrumentAuthProvider
 */

import type { IAuthProvider, AuthResult } from './IAuthProvider.js';
import type { PerformanceMonitor } from '../utils/PerformanceMonitor.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

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
        return async (token: string): Promise<AuthResult> => {
          const result = await monitor.timeAuthOp(OP_VALIDATE, () => target.validate(token), target.name);
          if (!result.ok) {
            SecurityMonitor.logSecurityEvent({
              type: 'TOKEN_VALIDATION_FAILURE',
              severity: 'LOW',
              source: 'instrumentAuthProvider',
              details: `Instrumented provider token validation failed: ${target.name}`,
              additionalData: { provider: target.name, reason: result.reason },
            });
          }
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
