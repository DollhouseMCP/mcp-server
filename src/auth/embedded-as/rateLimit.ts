/**
 * Shared-storage rate limits for local password login.
 *
 * State machine logic lives here; storage only supplies atomic CAS semantics.
 */

import { createHash } from 'node:crypto';

import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';
import type { IRateLimitStore } from './storage/IRateLimitStore.js';

const ACCOUNT_THRESHOLD = 5;
const ACCOUNT_WINDOW_MS = 60 * 1000;
const IP_THRESHOLD = 20;
const IP_LOCKOUT_MS = 15 * 60 * 1000;

const UNKNOWN_IP = 'unknown';

export function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function isResolvableIp(ip: string): boolean {
  return ip.length > 0 && ip !== UNKNOWN_IP;
}

export interface AccountFailureState {
  failures: number;
  firstFailureAt: number;
  bruteForceFired: boolean;
}

export interface IpFailureState {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
  bruteForceFired: boolean;
}

export interface CheckResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export interface RateLimitDeps {
  storage: IAuthStorageLayer;
  /**
   * Shared rate-limit state store. Required — there is no implicit
   * in-memory fallback. The DI registrar constructs the store (memory or
   * postgres) and threads it through; tests must construct one explicitly.
   * A silent fallback masks DI wiring bugs (each consumer would get its
   * own Map and limits would silently stop sharing across replicas / methods).
   */
  store: IRateLimitStore;
  /** Identifier ('memory' | 'postgres') for store-failure metric labelling. */
  storeBackend?: string;
}

type AccountTransition = { event: 'brute_force_threshold_crossed' };
type IpTransition = { event: 'ip_locked_out' };

// Bounded counter map for store-failure metrics. Keys are
// `rate_limit_store_failures_total{scope="...",backend="..."}` strings; the
// cardinality is bounded in practice by the number of (scope × backend)
// combinations (low single digits). The cap is defense-in-depth so a
// future caller passing varying backend labels can't grow the map without
// limit. Once full, new keys are dropped (and counted under an overflow
// metric) rather than evicting existing counters, since dropping
// established counters would obscure persistent issues.
const MAX_STORE_FAILURE_METRIC_KEYS = 64;
const STORE_FAILURE_OVERFLOW_KEY = 'rate_limit_store_failures_total{overflow="true"}';
const rateLimitStoreFailures = new Map<string, number>();

export function getRateLimitStoreFailureMetrics(): Record<string, number> {
  return Object.fromEntries(rateLimitStoreFailures);
}

export class LocalLoginRateLimiter {
  private readonly storage: IAuthStorageLayer;
  private readonly store: IRateLimitStore;
  private readonly storeBackend: string;

  constructor(deps: RateLimitDeps) {
    this.storage = deps.storage;
    this.store = deps.store;
    this.storeBackend = deps.storeBackend ?? 'unknown';
  }

  async check(account: string, ip: string): Promise<CheckResult> {
    const now = Date.now();
    const normIp = normalizeIp(ip);

    try {
      if (isResolvableIp(normIp)) {
        const ipRec = await this.store.get<IpFailureState>('local_ip', normIp);
        if (ipRec?.state.lockedUntil && ipRec.state.lockedUntil > now) {
          return {
            allowed: false,
            reason: 'ip locked due to too many failed attempts',
            retryAfterMs: ipRec.state.lockedUntil - now,
          };
        }
      }

      const acctRec = await this.store.get<AccountFailureState>('local_account', account);
      if (acctRec && acctRec.state.failures >= ACCOUNT_THRESHOLD) {
        const elapsed = now - acctRec.state.firstFailureAt;
        const backoffMs = backoffWindow(acctRec.state.failures);
        if (elapsed < backoffMs) {
          return {
            allowed: false,
            reason: 'account temporarily locked due to repeated failures',
            retryAfterMs: backoffMs - elapsed,
          };
        }
      }

      return { allowed: true };
    } catch (err) {
      logStoreFailure('check', 'local_login', `${account}|${normIp}`, err, this.storeBackend);
      return {
        allowed: false,
        reason: 'rate limit temporarily unavailable; try again shortly',
        retryAfterMs: 30_000,
      };
    }
  }

  /**
   * Record a successful authentication.
   *
   * The `_ip` parameter is intentionally unused: per H9 (credential-stuffing
   * carryover) we do NOT clear an IP lockout on a single successful login.
   * If an attacker tried 20 accounts from one IP and finally guessed one,
   * the IP lockout still applies to subsequent attempts from that source.
   * The account-side bucket is only cleared if the rolling window has
   * already expired naturally; sub-window successes preserve the failure
   * record so the lockout still trips on continued attempts.
   */
  async noteSuccess(account: string, _ip: string): Promise<void> {
    const now = Date.now();
    try {
      await this.store.update<AccountFailureState>(
        'local_account',
        account,
        (prev) => {
          if (!prev) return { state: null };
          return now - prev.firstFailureAt > ACCOUNT_WINDOW_MS
            ? { state: null }
            : { state: prev };
        },
        { expiresAt: now + Math.max(ACCOUNT_WINDOW_MS, backoffWindow(ACCOUNT_THRESHOLD)) },
      );
    } catch (err) {
      logStoreFailure('noteSuccess', 'local_account', account, err, this.storeBackend);
    }
  }

  async noteFailure(account: string, ip: string): Promise<void> {
    const now = Date.now();
    const normIp = normalizeIp(ip);

    try {
      const accountUpdate = await this.store.update<AccountFailureState, AccountTransition>(
        'local_account',
        account,
        (prev) => stepAccountStateMachine(prev, { now }),
        { expiresAt: now + Math.max(ACCOUNT_WINDOW_MS, backoffWindow(ACCOUNT_THRESHOLD + 8)) },
      );
      if (accountUpdate.result?.event === 'brute_force_threshold_crossed') {
        SecurityMonitor.logSecurityEvent({
          type: 'BRUTE_FORCE_ATTEMPT_BLOCKED',
          severity: 'HIGH',
          source: 'LocalLoginRateLimiter',
          details: 'Local account brute-force threshold crossed',
          additionalData: { dimension: 'account', account, failures: accountUpdate.state?.failures },
        });
        await this.storage.recordIdentityEvent({
          type: 'auth.local.brute_force_suspected',
          sub: account,
          details: { dimension: 'account', failures: accountUpdate.state?.failures },
          timestamp: now,
        });
      }
    } catch (err) {
      // Sustained CAS exhaustion can mean either (a) the rate-limit store
      // is unhealthy or (b) a coordinated attack is keeping the row hot
      // enough to starve writers. The two have very different runbooks
      // — infrastructure remediation vs. incident response — so emit a
      // distinct event type. Account identity is hashed into the details
      // string so SecurityMonitor's (type|source|details) dedup still
      // collapses true storms (10k events in a second) but does not hide
      // the breadth of distinct affected identities. `check()` already
      // fails closed on subsequent store errors, which gates the next
      // attempt regardless of what this event triggers.
      logStoreFailure('noteFailure', 'local_account', account, err, this.storeBackend);
      const accountHash = createHash('sha256').update(account).digest('base64url').slice(0, 12);
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_STORE_DEGRADED',
        severity: 'HIGH',
        source: 'LocalLoginRateLimiter',
        details: `Rate-limit store CAS exhausted; failure count for affected account could not be advanced (account_hash=${accountHash})`,
        additionalData: { dimension: 'account', account, backend: this.storeBackend },
      });
    }

    if (!isResolvableIp(normIp)) return;

    try {
      const ipUpdate = await this.store.update<IpFailureState, IpTransition>(
        'local_ip',
        normIp,
        (prev) => stepIpStateMachine(prev, { now }),
        { expiresAt: now + IP_LOCKOUT_MS * 2 },
      );
      if (ipUpdate.result?.event === 'ip_locked_out') {
        SecurityMonitor.logSecurityEvent({
          type: 'BRUTE_FORCE_ATTEMPT_BLOCKED',
          severity: 'HIGH',
          source: 'LocalLoginRateLimiter',
          details: 'Local IP brute-force threshold crossed',
          additionalData: { dimension: 'ip', ip: normIp, failures: ipUpdate.state?.failures },
        });
        await this.storage.recordIdentityEvent({
          type: 'auth.local.brute_force_suspected',
          details: { dimension: 'ip', ip: normIp, failures: ipUpdate.state?.failures },
          timestamp: now,
        });
      }
    } catch (err) {
      // IP-dimension store degradation — same rationale as the account
      // dimension above. Hash the IP into details so distinct sources
      // surface as separate events under dedup.
      logStoreFailure('noteFailure', 'local_ip', normIp, err, this.storeBackend);
      const ipHash = createHash('sha256').update(normIp).digest('base64url').slice(0, 12);
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_STORE_DEGRADED',
        severity: 'HIGH',
        source: 'LocalLoginRateLimiter',
        details: `Rate-limit store CAS exhausted; failure count for affected IP could not be advanced (ip_hash=${ipHash})`,
        additionalData: { dimension: 'ip', ip: normIp, backend: this.storeBackend },
      });
    }
  }

  async reset(account: string, ip?: string): Promise<void> {
    await this.store.reset('local_account', account);
    if (ip) await this.store.reset('local_ip', normalizeIp(ip));
  }
}

export function stepAccountStateMachine(
  prev: AccountFailureState | null,
  ctx: { now: number },
): { state: AccountFailureState; result?: AccountTransition } {
  const state = prev
    ? { ...prev }
    : { failures: 0, firstFailureAt: ctx.now, bruteForceFired: false };
  if (ctx.now - state.firstFailureAt > ACCOUNT_WINDOW_MS && state.failures < ACCOUNT_THRESHOLD) {
    state.failures = 0;
    state.firstFailureAt = ctx.now;
    state.bruteForceFired = false;
  }
  state.failures += 1;
  if (state.failures === 1) state.firstFailureAt = ctx.now;
  if (state.failures >= ACCOUNT_THRESHOLD && !state.bruteForceFired) {
    state.bruteForceFired = true;
    return { state, result: { event: 'brute_force_threshold_crossed' } };
  }
  return { state };
}

export function stepIpStateMachine(
  prev: IpFailureState | null,
  ctx: { now: number },
): { state: IpFailureState; result?: IpTransition } {
  const state = prev
    ? { ...prev }
    : { failures: 0, firstFailureAt: ctx.now, lockedUntil: 0, bruteForceFired: false };
  if (ctx.now - state.firstFailureAt > IP_LOCKOUT_MS && state.failures < IP_THRESHOLD) {
    state.failures = 0;
    state.firstFailureAt = ctx.now;
    state.bruteForceFired = false;
    state.lockedUntil = 0;
  }
  state.failures += 1;
  if (state.failures === 1) state.firstFailureAt = ctx.now;
  if (state.failures >= IP_THRESHOLD && state.lockedUntil <= ctx.now) {
    state.lockedUntil = ctx.now + IP_LOCKOUT_MS;
  }
  if (state.failures >= IP_THRESHOLD && !state.bruteForceFired) {
    state.bruteForceFired = true;
    return { state, result: { event: 'ip_locked_out' } };
  }
  return { state };
}

function backoffWindow(failures: number): number {
  const exponent = Math.max(0, failures - ACCOUNT_THRESHOLD);
  return Math.min(30_000 * 2 ** exponent, 15 * 60 * 1000);
}

function logStoreFailure(operation: string, scope: string, key: string, err: unknown, backend: string): void {
  const metricKey = `rate_limit_store_failures_total{scope="${scope}",backend="${backend}"}`;
  if (rateLimitStoreFailures.has(metricKey) || rateLimitStoreFailures.size < MAX_STORE_FAILURE_METRIC_KEYS) {
    rateLimitStoreFailures.set(metricKey, (rateLimitStoreFailures.get(metricKey) ?? 0) + 1);
  } else {
    // Cap reached — count under the overflow bucket so operators see the
    // misconfiguration in a single metric rather than losing the failure.
    rateLimitStoreFailures.set(
      STORE_FAILURE_OVERFLOW_KEY,
      (rateLimitStoreFailures.get(STORE_FAILURE_OVERFLOW_KEY) ?? 0) + 1,
    );
  }
  logger.warn('[rateLimit] store operation failed', {
    operation,
    scope,
    backend,
    keyHash: createHash('sha256').update(key).digest('base64url'),
    error: err instanceof Error ? err.message : String(err),
  });
}
