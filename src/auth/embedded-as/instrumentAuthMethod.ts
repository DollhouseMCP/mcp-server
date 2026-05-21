/**
 * Auth method instrumentation decorator.
 *
 * Wraps an IAuthMethod with PerformanceMonitor timing on each async
 * entry point so operators can see how long each phase of the auth
 * flow takes (per-method, separately) in `/healthz`. The decorator
 * lives here rather than inside each method class so:
 *   1. Each method file stays single-purpose (auth logic, not metrics).
 *   2. Adding a new method automatically gets instrumented when its
 *      registration runs through AuthProviderFactory.buildAuthMethod.
 *   3. SonarCloud complexity findings on existing method files are not
 *      re-flagged by adding metrics — the wrapper sits outside them.
 *
 * When `monitor` is undefined, returns the original method untouched
 * (zero overhead).
 *
 * @module auth/embedded-as/instrumentAuthMethod
 */

import type { IAuthMethod } from './IAuthMethod.js';
import type { PerformanceMonitor } from '../../utils/PerformanceMonitor.js';

const OP_BEGIN = 'auth.beginInteraction';
const OP_COMPLETE = 'auth.completeInteraction';
const OP_FIND_ACCOUNT = 'auth.findAccount';

export function instrumentAuthMethod(
  method: IAuthMethod,
  monitor?: PerformanceMonitor,
): IAuthMethod {
  if (!monitor) return method;

  return {
    id: method.id,
    displayName: method.displayName,
    beginInteraction: (ctx) =>
      monitor.timeAuthOp(OP_BEGIN, () => method.beginInteraction(ctx), method.id),
    completeInteraction: (ctx, input) =>
      monitor.timeAuthOp(OP_COMPLETE, () => method.completeInteraction(ctx, input), method.id),
    findAccount: (sub) =>
      monitor.timeAuthOp(OP_FIND_ACCOUNT, () => method.findAccount(sub), method.id),
    contributeRoutes: method.contributeRoutes?.bind(method),
  };
}
