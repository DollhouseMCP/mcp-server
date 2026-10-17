import { httpErrorMessage } from '../../../utils/HttpErrorSummary.js';
import { presenceRetryDelay } from '../../../utils/PresenceRetry.js';
import { logger } from '../../../utils/logger.js';
import type {
  IRuntimeSessionControlStore,
  RuntimeClientInfo,
  RuntimeSessionHeartbeatResult,
  RuntimeTerminationAckResult,
} from './IRuntimeSessionControlStore.js';

/**
 * Presence lease duration. This bounds two things: how long a runtime session
 * stays VISIBLE in `/me/sessions` (Connected apps) after its last request or stream-liveness renewal,
 * and how long a crashed replica's presence row lingers before
 * `sweepStalePresence` reaps it.
 *
 * It must reflect the TRANSPORT SESSION LIFETIME. A connected agent that is
 * idle (sending no requests) keeps its streamable-http session alive until the
 * idle timeout (`DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS`, default 15 min); the
 * SDK only ends the transport on DELETE/idle-dispose, which marks presence
 * `closing`. A lease shorter than that window made idle-but-connected agents
 * flicker out of the list and reappear on their next request. The active/idle
 * sub-state is derived from `lastActiveAt` recency at render time — NOT from
 * this lease. Size it from the configured idle timeout via
 * `runtimePresenceLeaseMsFor()`.
 */
export const DEFAULT_RUNTIME_SESSION_LEASE_MS = 15 * 60_000;

/**
 * Grace added on top of the transport idle window so the transport's own
 * idle-dispose (which marks presence `closing`) wins the race against lease
 * expiry — yielding a clean lifecycle transition rather than a gated zombie.
 */
export const RUNTIME_PRESENCE_LEASE_GRACE_MS = 60_000;

export const DEFAULT_RUNTIME_COMMAND_BATCH_LIMIT = 100;

/**
 * Sizes the presence lease from the transport idle timeout so presence
 * visibility tracks the real session lifetime. A non-positive idle timeout
 * (idle expiry disabled) falls back to the default lease window.
 */
export function runtimePresenceLeaseMsFor(idleTimeoutMs: number): number {
  const base = Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0
    ? idleTimeoutMs
    : DEFAULT_RUNTIME_SESSION_LEASE_MS;
  return base + RUNTIME_PRESENCE_LEASE_GRACE_MS;
}

export interface RuntimeMcpSessionRegistration {
  readonly sessionId: string;
  readonly userId: string;
  readonly accountCorrelationId: string;
  readonly clientInfo?: RuntimeClientInfo | null;
}

export type RuntimeLocalTerminationResult = 'terminated' | 'already_absent';

export interface RuntimeMcpSessionTerminator {
  terminateLocalSession(sessionId: string): Promise<RuntimeLocalTerminationResult>;
}

export interface RuntimeMcpSessionControlServiceOptions {
  readonly store: IRuntimeSessionControlStore;
  readonly replicaId: string;
  readonly now?: () => Date;
  readonly leaseDurationMs?: number;
  readonly commandBatchLimit?: number;
}

interface LocalRuntimeSession {
  confirmedLeaseUntil?: Date;
  cancelRegistrationWait?: () => void;
  readonly sessionId: string;
  readonly userId: string;
  readonly accountCorrelationId: string;
  readonly clientInfo: RuntimeClientInfo | null;
  readonly startedAt: Date;
  lastActiveAt: Date;
  requestCount: number;
  errorCount: number;
  disposed: boolean;
  pending: Promise<void>;
}

export class RuntimeMcpSessionControlService {
  private readonly store: IRuntimeSessionControlStore;
  private readonly replicaId: string;
  private readonly now: () => Date;
  private readonly leaseDurationMs: number;
  private readonly commandBatchLimit: number;
  private readonly sessions = new Map<string, LocalRuntimeSession>();

  constructor(options: RuntimeMcpSessionControlServiceOptions) {
    this.store = options.store;
    this.replicaId = options.replicaId;
    this.now = options.now ?? (() => new Date());
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_RUNTIME_SESSION_LEASE_MS;
    this.commandBatchLimit = options.commandBatchLimit ?? DEFAULT_RUNTIME_COMMAND_BATCH_LIMIT;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs <= 0) {
      throw new Error('Runtime session lease duration must be a positive integer number of milliseconds');
    }
    if (!Number.isInteger(this.commandBatchLimit) || this.commandBatchLimit < 1 || this.commandBatchLimit > 500) {
      throw new Error('Runtime command batch limit must be between 1 and 500');
    }
  }

  getReplicaId(): string {
    return this.replicaId;
  }

  getLocalSessionCount(): number {
    return this.sessions.size;
  }

  getConfirmedLeaseUntil(sessionId: string): Date | undefined {
    return this.sessions.get(sessionId)?.confirmedLeaseUntil;
  }

  getLeaseRenewalIntervalMs(): number {
    return Math.max(1, Math.floor(this.leaseDurationMs / 3));
  }

  async registerSession(input: RuntimeMcpSessionRegistration): Promise<void> {
    const now = this.now();
    const session: LocalRuntimeSession = {
      sessionId: input.sessionId,
      userId: input.userId,
      accountCorrelationId: input.accountCorrelationId,
      clientInfo: input.clientInfo ? { ...input.clientInfo } : null,
      startedAt: now,
      lastActiveAt: now,
      requestCount: 0,
      errorCount: 0,
      disposed: false,
      pending: Promise.resolve(),
    };
    this.sessions.set(input.sessionId, session);
    const deadline = Date.now() + this.leaseDurationMs;
    await this.enqueue(session, () => this.registerWithRetry(session, deadline));
  }

  private async registerWithRetry(session: LocalRuntimeSession, deadline: number): Promise<void> {
    let failures = 0;
    while (!session.disposed) {
      if (Date.now() >= deadline) throw new Error('Runtime presence registration deadline exceeded');
      try {
        const presence = await this.store.registerPresence({
          sessionId: session.sessionId, userId: session.userId,
          accountCorrelationId: session.accountCorrelationId,
          replicaId: this.replicaId, transport: 'streamable-http',
          clientInfo: session.clientInfo, startedAt: session.startedAt,
          lastActiveAt: session.lastActiveAt, requestCount: session.requestCount,
          errorCount: session.errorCount, leaseUntil: this.leaseUntil(this.now()),
        });
        session.confirmedLeaseUntil = presence.leaseUntil;
        return;
      } catch (error) {
        if (session.disposed) return;
        failures += 1;
        this.warnRegistrationFailure(session.sessionId, failures, error);
        const delay = Math.min(deadline - Date.now(), presenceRetryDelay(failures, this.getLeaseRenewalIntervalMs()));
        if (delay <= 0) throw new Error('Runtime presence registration deadline exceeded');
        await new Promise<void>(resolve => { // NOSONAR - Sequential retry: each attempt must wait for the previous one to fail.
          const timer = setTimeout(() => { session.cancelRegistrationWait = undefined; resolve(); }, delay);
          timer.unref();
          session.cancelRegistrationWait = () => { clearTimeout(timer); session.cancelRegistrationWait = undefined; resolve(); };
        });
      }
    }
  }

  private warnRegistrationFailure(sessionId: string, failures: number, error: unknown): void {
    // Preserve the first cause without flooding logs during a sustained outage.
    if (failures !== 1 && failures % 10 !== 0) return;
    logger.warn('[RuntimeSessionControl] Initial presence registration failed; retrying', {
      sessionId, failures, error: httpErrorMessage(error).slice(0, 256),
    });
  }

  async recordActivity(sessionId: string, outcome: 'ok' | 'error' = 'ok'): Promise<RuntimeSessionHeartbeatResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { kind: 'lost', reason: 'closing' };
    const now = this.now();
    return this.enqueue(session, async () => {
      if (session.disposed) return { kind: 'lost', reason: 'closing' };
      session.lastActiveAt = now;
      session.requestCount += 1;
      if (outcome === 'error') session.errorCount += 1;
      const result = await this.store.heartbeatPresence({
        sessionId, replicaId: this.replicaId, lastActiveAt: now,
        requestCount: session.requestCount, errorCount: session.errorCount,
        leaseUntil: this.leaseUntil(now),
      });
      // Missing presence is not authority to upsert a possibly revoked session.
      return this.acceptResult(session, result);
    });
  }

  async renewSessionLease(sessionId: string): Promise<RuntimeSessionHeartbeatResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { kind: 'lost', reason: 'closing' };
    return this.enqueue(session, async () => {
      if (session.disposed) return { kind: 'lost', reason: 'closing' };
      const result = await this.store.renewSessionLease({
        sessionId, replicaId: this.replicaId, leaseUntil: this.leaseUntil(this.now()),
      });
      return this.acceptResult(session, result);
    });
  }

  async markSessionDisposed(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Tombstone synchronously. An in-flight registration completes before the
    // guarded close; queued activity/renewals observe the tombstone and skip I/O.
    session.disposed = true;
    session.cancelRegistrationWait?.();
    this.sessions.delete(sessionId);
    await this.enqueue(session, async () => {
      await this.store.markPresenceClosing(sessionId, this.now(), this.replicaId);
    });
  }

  private acceptResult(session: LocalRuntimeSession, result: RuntimeSessionHeartbeatResult): RuntimeSessionHeartbeatResult {
    if (result.kind === 'updated') session.confirmedLeaseUntil = result.presence.leaseUntil;
    if (result.kind === 'lost' && result.reason !== 'missing') {
      session.disposed = true;
      // Keep ownership until the HTTP runtime calls markSessionDisposed so a
      // missing/closing result still gets a guarded durable cleanup attempt.
      if (result.reason === 'replica_mismatch') this.sessions.delete(session.sessionId);
    }
    return session.disposed && result.kind === 'updated' ? { kind: 'lost', reason: 'closing' } : result;
  }

  private enqueue<T>(session: LocalRuntimeSession, action: () => Promise<T>): Promise<T> {
    const result = session.pending.then(action);
    // A failed write must not strand the durable close behind a rejected chain.
    session.pending = result.then(() => {}, () => {});
    return result;
  }

  async reconcilePendingCommands(terminator: RuntimeMcpSessionTerminator): Promise<number> {
    const commands = await this.store.listPendingCommandsForReplica(this.replicaId, {
      limit: this.commandBatchLimit,
      now: this.now(),
    });
    let processed = 0;
    for (const command of commands) {
      let result: RuntimeTerminationAckResult;
      let errorCode: string | null = null;
      try {
        const termination = await terminator.terminateLocalSession(command.sessionId);
        result = termination === 'terminated' ? 'terminated' : 'already_absent';
      } catch (error) {
        result = 'failed';
        errorCode = 'local_termination_failed';
        logger.warn('[RuntimeMcpSessionControl] Runtime termination command failed', {
          commandId: command.commandId,
          sessionId: command.sessionId,
          replicaId: this.replicaId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const recorded = await this.store.acknowledgeCommand({
        commandId: command.commandId,
        replicaId: this.replicaId,
        acknowledgedAt: this.now(),
        result,
        errorCode,
      });
      if (recorded) processed += 1;
    }
    return processed;
  }

  private leaseUntil(now: Date): Date {
    return new Date(now.getTime() + this.leaseDurationMs);
  }

}
