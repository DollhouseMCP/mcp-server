/**
 * rateLimit
 *
 * Per-account exponential backoff + per-IP bucket for local password login
 * attempts (must-fix #16). Without rate limiting, local accounts are a
 * credential-stuffing magnet the moment the server is reachable.
 *
 * Two layers:
 *   - Account: each failed login increments a counter for that sub. After
 *     N consecutive failures, the next attempt is delayed by an exponential
 *     backoff window. Successful login resets the counter.
 *   - IP: each failed login also increments a per-IP bucket. After N
 *     failures from the same IP, all subsequent attempts from that IP are
 *     rejected for a window. Catches credential-stuffing across many
 *     usernames from the same source.
 *
 * `auth.local.brute_force_suspected` audit event fires the first time a
 * given account or IP crosses the threshold.
 *
 * @module auth/embedded-as/rateLimit
 */

import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

const ACCOUNT_THRESHOLD = 5; // failures before backoff kicks in
const ACCOUNT_WINDOW_MS = 60 * 1000; // window over which failures count
const IP_THRESHOLD = 20; // failures from one IP before lockout
const IP_LOCKOUT_MS = 15 * 60 * 1000; // 15 min IP lockout

interface AccountRecord {
  failures: number;
  firstFailureAt: number;
  bruteForceFired: boolean;
}

interface IpRecord {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
  bruteForceFired: boolean;
}

export interface CheckResult {
  allowed: boolean;
  reason?: string;
  /** Suggested ms the caller should ask the client to back off. */
  retryAfterMs?: number;
}

export interface RateLimitDeps {
  storage: IAuthStorageLayer;
}

export class LocalLoginRateLimiter {
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly ips = new Map<string, IpRecord>();
  private readonly storage: IAuthStorageLayer;

  constructor(deps: RateLimitDeps) {
    this.storage = deps.storage;
  }

  /** Call before validating a password. Returns whether the attempt may proceed. */
  check(account: string, ip: string): CheckResult {
    const now = Date.now();

    const ipRec = this.ips.get(ip);
    if (ipRec && ipRec.lockedUntil > now) {
      return {
        allowed: false,
        reason: 'ip locked due to too many failed attempts',
        retryAfterMs: ipRec.lockedUntil - now,
      };
    }

    const acctRec = this.accounts.get(account);
    if (acctRec && acctRec.failures >= ACCOUNT_THRESHOLD) {
      const elapsed = now - acctRec.firstFailureAt;
      const backoffMs = backoffWindow(acctRec.failures);
      if (elapsed < backoffMs) {
        return {
          allowed: false,
          reason: 'account temporarily locked due to repeated failures',
          retryAfterMs: backoffMs - elapsed,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record a successful login; clears any failure state for the account.
   *
   * IP bucket intentionally NOT reset on success: an attacker who
   * succeeds once (e.g. via a stolen credential or after a partial
   * compromise) should not be able to clear the IP-level lockout state
   * accumulated by their failed probes against other usernames. The
   * per-account counter resets so a legitimate user who eventually got
   * the password right doesn't stay rate-limited.
   */
  async noteSuccess(account: string, _ip: string): Promise<void> {
    this.accounts.delete(account);
  }

  /** Record a failed login; updates counters and may emit the audit event. */
  async noteFailure(account: string, ip: string): Promise<void> {
    const now = Date.now();

    // Account counter
    const acctRec = this.accounts.get(account) ?? {
      failures: 0,
      firstFailureAt: now,
      bruteForceFired: false,
    };
    if (now - acctRec.firstFailureAt > ACCOUNT_WINDOW_MS && acctRec.failures < ACCOUNT_THRESHOLD) {
      // Window elapsed; reset.
      acctRec.failures = 0;
      acctRec.firstFailureAt = now;
      acctRec.bruteForceFired = false;
    }
    acctRec.failures += 1;
    if (acctRec.failures === 1) acctRec.firstFailureAt = now;
    this.accounts.set(account, acctRec);

    if (acctRec.failures >= ACCOUNT_THRESHOLD && !acctRec.bruteForceFired) {
      acctRec.bruteForceFired = true;
      await this.storage.recordIdentityEvent({
        type: 'auth.local.brute_force_suspected',
        sub: account,
        details: { dimension: 'account', failures: acctRec.failures },
        timestamp: now,
      });
    }

    // IP bucket
    const ipRec = this.ips.get(ip) ?? {
      failures: 0,
      firstFailureAt: now,
      lockedUntil: 0,
      bruteForceFired: false,
    };
    if (now - ipRec.firstFailureAt > IP_LOCKOUT_MS && ipRec.failures < IP_THRESHOLD) {
      ipRec.failures = 0;
      ipRec.firstFailureAt = now;
      ipRec.bruteForceFired = false;
    }
    ipRec.failures += 1;
    if (ipRec.failures === 1) ipRec.firstFailureAt = now;
    if (ipRec.failures >= IP_THRESHOLD) {
      ipRec.lockedUntil = now + IP_LOCKOUT_MS;
    }
    this.ips.set(ip, ipRec);

    if (ipRec.failures >= IP_THRESHOLD && !ipRec.bruteForceFired) {
      ipRec.bruteForceFired = true;
      await this.storage.recordIdentityEvent({
        type: 'auth.local.brute_force_suspected',
        details: { dimension: 'ip', ip, failures: ipRec.failures },
        timestamp: now,
      });
    }
  }
}

function backoffWindow(failures: number): number {
  // 5 failures → 30s; 6 → 1m; 7 → 2m; 8 → 4m; capped at 15m.
  const exponent = Math.max(0, failures - ACCOUNT_THRESHOLD);
  return Math.min(30_000 * 2 ** exponent, 15 * 60 * 1000);
}
