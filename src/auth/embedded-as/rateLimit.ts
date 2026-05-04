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

import { logger } from '../../utils/logger.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

const ACCOUNT_THRESHOLD = 5; // failures before backoff kicks in
const ACCOUNT_WINDOW_MS = 60 * 1000; // window over which failures count
const IP_THRESHOLD = 20; // failures from one IP before lockout
const IP_LOCKOUT_MS = 15 * 60 * 1000; // 15 min IP lockout

// Bound the in-memory tracking Maps. Without these, an attacker can drive
// memory exhaustion by failing logins under unique usernames or from unique
// source IPs. The cap is enforced after every failure: expired entries are
// swept first, then FIFO eviction kicks in only as a last resort.
const MAX_TRACKED_ACCOUNTS = 10_000;
const MAX_TRACKED_IPS = 10_000;

const UNKNOWN_IP = 'unknown';

/**
 * Strip the IPv4-mapped IPv6 prefix so `::ffff:1.2.3.4` and `1.2.3.4` share
 * the same bucket. Without this an attacker can bypass per-IP limits by
 * alternating address families.
 */
function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

/**
 * Whether `ip` is a real source we can rate-limit on. An unresolvable IP
 * (typically when `req.ip` is missing) is reported as `UNKNOWN_IP` by
 * callers; lumping every such request into a single bucket is itself a DoS
 * vector — one misbehaving caller would lock out every other unresolvable
 * caller. Skip the per-IP path instead and rely on per-account limits.
 */
function isResolvableIp(ip: string): boolean {
  return ip.length > 0 && ip !== UNKNOWN_IP;
}

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
  /** One-shot guard so the saturation audit fires once per process, not on every flood call. */
  private accountSaturationFired = false;
  private ipSaturationFired = false;

  constructor(deps: RateLimitDeps) {
    this.storage = deps.storage;
  }

  /** Call before validating a password. Returns whether the attempt may proceed. */
  check(account: string, ip: string): CheckResult {
    const now = Date.now();
    const normIp = normalizeIp(ip);

    if (isResolvableIp(normIp)) {
      const ipRec = this.ips.get(normIp);
      if (ipRec && ipRec.lockedUntil > now) {
        return {
          allowed: false,
          reason: 'ip locked due to too many failed attempts',
          retryAfterMs: ipRec.lockedUntil - now,
        };
      }
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
    const normIp = normalizeIp(ip);

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
    if (this.boundAccounts(now)) await this.recordAccountSaturation(now);

    if (acctRec.failures >= ACCOUNT_THRESHOLD && !acctRec.bruteForceFired) {
      acctRec.bruteForceFired = true;
      await this.storage.recordIdentityEvent({
        type: 'auth.local.brute_force_suspected',
        sub: account,
        details: { dimension: 'account', failures: acctRec.failures },
        timestamp: now,
      });
    }

    // IP bucket — only track real source IPs. Unresolvable callers go
    // through per-account limits only (see isResolvableIp).
    if (!isResolvableIp(normIp)) return;

    const ipRec = this.ips.get(normIp) ?? {
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
    this.ips.set(normIp, ipRec);
    if (this.boundIps(now)) await this.recordIpSaturation(now);

    if (ipRec.failures >= IP_THRESHOLD && !ipRec.bruteForceFired) {
      ipRec.bruteForceFired = true;
      await this.storage.recordIdentityEvent({
        type: 'auth.local.brute_force_suspected',
        details: { dimension: 'ip', ip: normIp, failures: ipRec.failures },
        timestamp: now,
      });
    }
  }

  /**
   * Cap the accounts Map. Three passes:
   *   1. Drop entries whose protection window has fully elapsed (safe).
   *   2. FIFO-drop any entry that is NOT currently in active backoff —
   *      preserves load-bearing locked entries even though they were
   *      inserted before the flood.
   *   3. If every entry is currently locked we are at saturation; plain
   *      FIFO breaks the tie rather than refuse to track new failures.
   *
   * Returns true when pass-3 had to evict a still-locked record — that
   * is the security-meaningful saturation event. The caller emits an
   * audit + log so the operator can see that a flood has reached the
   * point where historical lockouts are being rotated out. The deeper
   * fix (refuse-new-tracking instead of FIFO-on-locked) is tracked as a
   * follow-up; pass-3 is a known compromise of availability over
   * lockout-persistence and the alarm is the mitigation today.
   */
  private boundAccounts(now: number): boolean {
    if (this.accounts.size <= MAX_TRACKED_ACCOUNTS) return false;

    for (const [key, rec] of this.accounts) {
      if (this.accounts.size <= MAX_TRACKED_ACCOUNTS) return false;
      const elapsed = now - rec.firstFailureAt;
      const safeToEvict = rec.failures < ACCOUNT_THRESHOLD
        ? elapsed > ACCOUNT_WINDOW_MS
        : elapsed >= backoffWindow(rec.failures);
      if (safeToEvict) this.accounts.delete(key);
    }

    if (this.accounts.size <= MAX_TRACKED_ACCOUNTS) return false;
    for (const [key, rec] of this.accounts) {
      if (this.accounts.size <= MAX_TRACKED_ACCOUNTS) return false;
      const stillLocked = rec.failures >= ACCOUNT_THRESHOLD
        && (now - rec.firstFailureAt) < backoffWindow(rec.failures);
      if (!stillLocked) this.accounts.delete(key);
    }

    let evictedLocked = false;
    while (this.accounts.size > MAX_TRACKED_ACCOUNTS) {
      const oldest = this.accounts.keys().next().value;
      if (oldest === undefined) break;
      this.accounts.delete(oldest);
      evictedLocked = true;
    }
    return evictedLocked;
  }

  /**
   * Cap the ips Map. Mirrors boundAccounts: actively-locked IPs are
   * load-bearing and survive FIFO until their lockout window passes or
   * total saturation forces eviction. Returns true when pass-3 evicted
   * a still-locked record — the saturation alarm condition.
   */
  private boundIps(now: number): boolean {
    if (this.ips.size <= MAX_TRACKED_IPS) return false;

    for (const [key, rec] of this.ips) {
      if (this.ips.size <= MAX_TRACKED_IPS) return false;
      const beyondLock = rec.lockedUntil <= now;
      const beyondWindow = (now - rec.firstFailureAt) > IP_LOCKOUT_MS;
      if (beyondLock && beyondWindow) this.ips.delete(key);
    }

    if (this.ips.size <= MAX_TRACKED_IPS) return false;
    for (const [key, rec] of this.ips) {
      if (this.ips.size <= MAX_TRACKED_IPS) return false;
      const stillLocked = rec.lockedUntil > now;
      if (!stillLocked) this.ips.delete(key);
    }

    let evictedLocked = false;
    while (this.ips.size > MAX_TRACKED_IPS) {
      const oldest = this.ips.keys().next().value;
      if (oldest === undefined) break;
      this.ips.delete(oldest);
      evictedLocked = true;
    }
    return evictedLocked;
  }

  private async recordAccountSaturation(now: number): Promise<void> {
    if (this.accountSaturationFired) return;
    this.accountSaturationFired = true;
    logger.warn(
      '[LocalLoginRateLimiter] account-table saturation: locked entries are being FIFO-evicted under flood. ' +
      'Lockout persistence is degraded until the flood subsides.',
    );
    await this.storage.recordIdentityEvent({
      type: 'auth.local.rate_limit_saturated',
      details: { dimension: 'account', tracked: this.accounts.size },
      timestamp: now,
    });
  }

  private async recordIpSaturation(now: number): Promise<void> {
    if (this.ipSaturationFired) return;
    this.ipSaturationFired = true;
    logger.warn(
      '[LocalLoginRateLimiter] ip-table saturation: locked entries are being FIFO-evicted under flood. ' +
      'Lockout persistence is degraded until the flood subsides.',
    );
    await this.storage.recordIdentityEvent({
      type: 'auth.local.rate_limit_saturated',
      details: { dimension: 'ip', tracked: this.ips.size },
      timestamp: now,
    });
  }
}

function backoffWindow(failures: number): number {
  // 5 failures → 30s; 6 → 1m; 7 → 2m; 8 → 4m; capped at 15m.
  const exponent = Math.max(0, failures - ACCOUNT_THRESHOLD);
  return Math.min(30_000 * 2 ** exponent, 15 * 60 * 1000);
}
