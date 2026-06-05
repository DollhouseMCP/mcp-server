import { logger } from '../../../utils/logger.js';
import type {
  IRuntimeSessionControlStore,
  RuntimeClientInfo,
  RuntimeSessionHeartbeatResult,
  RuntimeTerminationAckResult,
} from './IRuntimeSessionControlStore.js';

/**
 * Presence lease duration. This bounds two things: how long a runtime session
 * stays VISIBLE in `/me/sessions` (Connected apps) after its last MCP request,
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
  readonly sessionId: string;
  readonly userId: string;
  readonly accountCorrelationId: string;
  readonly clientInfo: RuntimeClientInfo | null;
  readonly startedAt: Date;
  lastActiveAt: Date;
  requestCount: number;
  errorCount: number;
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
    };
    this.sessions.set(input.sessionId, session);
    await this.store.registerPresence({
      sessionId: input.sessionId,
      userId: input.userId,
      accountCorrelationId: input.accountCorrelationId,
      replicaId: this.replicaId,
      transport: 'streamable-http',
      clientInfo: session.clientInfo,
      startedAt: now,
      lastActiveAt: now,
      requestCount: 0,
      errorCount: 0,
      leaseUntil: this.leaseUntil(now),
    });
  }

  async recordActivity(sessionId: string, outcome: 'ok' | 'error' = 'ok'): Promise<RuntimeSessionHeartbeatResult | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const now = this.now();
    session.lastActiveAt = now;
    session.requestCount += 1;
    if (outcome === 'error') session.errorCount += 1;
    const result = await this.store.heartbeatPresence({
      sessionId,
      replicaId: this.replicaId,
      lastActiveAt: now,
      requestCount: session.requestCount,
      errorCount: session.errorCount,
      leaseUntil: this.leaseUntil(now),
    });
    if (result.kind === 'lost' && result.reason === 'missing') {
      try {
        await this.registerExistingSession(session);
        return await this.store.heartbeatPresence({
          sessionId,
          replicaId: this.replicaId,
          lastActiveAt: session.lastActiveAt,
          requestCount: session.requestCount,
          errorCount: session.errorCount,
          leaseUntil: this.leaseUntil(session.lastActiveAt),
        });
      } catch (error) {
        logger.warn('[RuntimeMcpSessionControl] Runtime session lazy re-registration failed', {
          sessionId,
          replicaId: this.replicaId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (result.kind === 'lost') {
      this.sessions.delete(sessionId);
      logger.warn('[RuntimeMcpSessionControl] Runtime session heartbeat lost ownership', {
        sessionId,
        replicaId: this.replicaId,
        reason: result.reason,
      });
    }
    return result;
  }

  async markSessionDisposed(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    await this.store.markPresenceClosing(sessionId, this.now());
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

  private async registerExistingSession(session: LocalRuntimeSession): Promise<void> {
    await this.store.registerPresence({
      sessionId: session.sessionId,
      userId: session.userId,
      accountCorrelationId: session.accountCorrelationId,
      replicaId: this.replicaId,
      transport: 'streamable-http',
      clientInfo: session.clientInfo,
      startedAt: session.startedAt,
      lastActiveAt: session.lastActiveAt,
      requestCount: session.requestCount,
      errorCount: session.errorCount,
      leaseUntil: this.leaseUntil(session.lastActiveAt),
    });
  }
}
