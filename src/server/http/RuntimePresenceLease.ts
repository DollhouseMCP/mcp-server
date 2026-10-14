import { atDeadline } from '../../utils/timers.js';
import { presenceRetryDelay } from '../../utils/PresenceRetry.js';
import type { RuntimeSessionHeartbeatResult } from '../../web-console/services/runtime/IRuntimeSessionControlStore.js';

/** Coalesces writes and retries outages only within the last confirmed lease. */
export class RuntimePresenceLease {
  private timer: (() => void) | undefined;
  private deadline: (() => void) | undefined;
  private watchdog: (() => void) | undefined;
  private pending = false;
  private again = false;
  private stopped = false;
  private streaming = false;
  private postActive = false;
  private failures = 0;
  private confirmed = 0;
  private activityWrites = 0;
  private readonly registrationDeadline: number;

  constructor(private readonly options: {
    intervalMs: number;
    /** Keep POST-only sessions visible when transport idle expiry is disabled. */
    renewWhileIdle?: boolean;
    confirmedLeaseUntil(): Date | undefined;
    renew(): Promise<RuntimeSessionHeartbeatResult>;
    lost(reason: string): void;
    warn?(reason: string): void;
  }) {
    // Registration may still be in flight. This is a bounded initial wait, not
    // a confirmed durable lease; once confirmed, only store results extend it.
    this.registrationDeadline = Date.now() + options.intervalMs * 3;
  }

  /** Guard a pending registration/activity write without starting quiet renewal. */
  guard(): void { this.armExpiry(); }

  activityStarted(): void { this.activityWrites += 1; this.guard(); }

  activityFinished(): void {
    this.activityWrites = Math.max(0, this.activityWrites - 1);
    this.activitySucceeded();
  }

  activitySucceeded(): void {
    if (this.stopped) return;
    this.confirmed = Math.max(this.confirmed, this.options.confirmedLeaseUntil()?.getTime() ?? 0);
    if (!this.confirmed || this.maintainsPresence() || this.pending || this.failures > 0 || this.activityWrites > 0) this.armExpiry();
    else this.park();
    if (!this.maintainsPresence() && this.failures === 0 && !this.pending) {
      this.timer?.();
      this.timer = undefined;
    }
    this.scheduleMaintenance();
  }

  recover(): void {
    this.armExpiry();
    if (!this.timer && !this.pending) this.renew();
  }

  open(): void {
    if (this.stopped) return;
    this.streaming = true;
    this.armExpiry();
    this.renew();
  }

  close(): void {
    if (this.stopped) return;
    this.streaming = false;
    this.renew();
  }

  /** POST lifetime is independent of the standalone GET stream. */
  setPostActive(active: boolean): void {
    if (this.stopped || this.postActive === active) return;
    this.postActive = active;
    this.activitySucceeded();
  }

  dispose(): void {
    this.stopped = true;
    this.again = false;
    this.timer?.();
    this.deadline?.();
    this.watchdog?.();
  }

  /** No outstanding writes or failures: quiet time is governed by session idle expiry. */
  private park(): void {
    this.timer?.();
    this.timer = undefined;
    this.deadline?.();
    this.deadline = undefined;
  }

  /** Local admission check; a delayed expiry callback must not authorize dispatch. */
  hasExpired(): boolean {
    if (this.stopped) return true;
    this.confirmed = Math.max(this.confirmed, this.options.confirmedLeaseUntil()?.getTime() ?? 0);
    return Date.now() >= (this.confirmed || this.registrationDeadline);
  }

  private maintainsPresence(): boolean { return this.streaming || this.postActive || this.options.renewWhileIdle === true; }

  private armExpiry(): void {
    if (this.stopped) return;
    this.deadline?.();
    this.confirmed = Math.max(this.confirmed, this.options.confirmedLeaseUntil()?.getTime() ?? 0);
    const expiresAt = this.confirmed || this.registrationDeadline;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) { this.fail('lease_expired'); return; }
    this.deadline = atDeadline(expiresAt, () => this.armExpiry());
  }

  private scheduleMaintenance(): void {
    // Registration owns the initial write. Split the remaining lease between
    // finishing short work and renewing held work, capped at normal cadence.
    if (!this.maintainsPresence() || !this.confirmed || this.pending || this.timer || this.failures > 0) return;
    const delay = Math.min(this.options.intervalMs, Math.max(0, (this.confirmed - Date.now()) / 2));
    this.schedule(delay);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer?.();
    this.timer = atDeadline(Date.now() + delay, () => { this.timer = undefined; this.renew(); });
  }

  private renew(): void {
    if (this.stopped) return;
    if (this.pending) { this.again = true; return; }
    this.timer?.();
    this.timer = undefined;
    this.armExpiry();
    if (this.stopped) return;
    this.pending = true;
    // Keep the outstanding write coalesced on timeout. A second write cannot
    // bypass the service queue; the confirmed-lease watchdog remains active.
    this.watchdog = atDeadline(Date.now() + Math.min(5_000, this.options.intervalMs), () => this.options.warn?.('timeout'));
    void Promise.resolve().then(() => this.options.renew()).then(result => {
      if (this.stopped) return;
      if (result.kind === 'lost') {
        if (result.reason === 'missing') this.retry('missing');
        else this.fail(result.reason);
      } else {
        this.confirmed = Math.max(this.confirmed, result.presence.leaseUntil.getTime());
        this.failures = 0;
        this.armExpiry();
      }
    }, () => this.retry('outage')).finally(() => {
      this.watchdog?.();
      this.pending = false;
      if (this.stopped) return;
      if (this.again) { this.again = false; this.renew(); }
      else this.activitySucceeded();
    });
  }

  private retry(reason: string): void {
    if (this.stopped) return;
    this.options.warn?.(reason);
    this.armExpiry();
    if (this.stopped) return;
    this.failures += 1;
    const backoff = presenceRetryDelay(this.failures, this.options.intervalMs);
    this.schedule(backoff);
  }

  private fail(reason: string): void {
    if (this.stopped) return;
    this.dispose();
    this.options.lost(reason);
  }
}
