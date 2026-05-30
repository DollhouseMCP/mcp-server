import type { IConsoleSessionStore } from '../../stores/IConsoleSessionStore.js';
import type {
  IConsoleSecurityInvalidationStore,
  SecurityInvalidationEvent,
} from './IConsoleSecurityInvalidationStore.js';
import { validateReplicaId } from './IConsoleSecurityInvalidationStore.js';

export const DEFAULT_SECURITY_INVALIDATION_PROCESSOR_INTERVAL_MS = 5_000;
export const DEFAULT_SECURITY_INVALIDATION_LEASE_DURATION_MS = 15_000;
export const DEFAULT_SECURITY_INVALIDATION_BATCH_SIZE = 100;
export const SECURITY_INVALIDATION_PROCESSOR_TASK_LABEL = 'webConsole.securityInvalidationProcessor';

export interface ConsoleSecurityInvalidationProcessorLifecycle {
  registerPeriodicTask(intervalMs: number, task: () => Promise<void>, label: string): unknown;
}

export interface ConsoleSecurityInvalidationProcessorOptions {
  readonly store: IConsoleSecurityInvalidationStore;
  readonly sessionStore: Pick<IConsoleSessionStore,
    'revoke' | 'revokeForUser' | 'clearElevationsForUser'
  >;
  readonly replicaId: string;
  readonly intervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly batchSize?: number;
  readonly now?: () => Date;
  readonly reportError?: (error: unknown) => void;
}

export interface ConsoleSecurityInvalidationProcessorRunResult {
  readonly replicaId: string;
  readonly leasedUntil: Date;
  readonly processed: number;
  readonly acknowledged: number;
  readonly cursorSequenceId: number;
}

export interface IConsoleSecurityInvalidationProcessor {
  isRunning(): boolean;
  register(lifecycle: ConsoleSecurityInvalidationProcessorLifecycle): void;
  runOnce(): Promise<ConsoleSecurityInvalidationProcessorRunResult | null>;
}

export class ConsoleSecurityInvalidationProcessor implements IConsoleSecurityInvalidationProcessor {
  private readonly intervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private running = false;
  private registered = false;

  constructor(private readonly options: ConsoleSecurityInvalidationProcessorOptions) {
    validateReplicaId(options.replicaId);
    this.intervalMs = validatePositiveInteger(
      options.intervalMs ?? DEFAULT_SECURITY_INVALIDATION_PROCESSOR_INTERVAL_MS,
      'security invalidation processor interval',
    );
    this.leaseDurationMs = validatePositiveInteger(
      options.leaseDurationMs ?? DEFAULT_SECURITY_INVALIDATION_LEASE_DURATION_MS,
      'security invalidation replica lease duration',
    );
    this.batchSize = validateBatchSize(options.batchSize ?? DEFAULT_SECURITY_INVALIDATION_BATCH_SIZE);
    this.now = options.now ?? (() => new Date());
  }

  isRunning(): boolean {
    return this.registered;
  }

  register(lifecycle: ConsoleSecurityInvalidationProcessorLifecycle): void {
    if (this.registered) return;
    this.registered = true;
    lifecycle.registerPeriodicTask(
      this.intervalMs,
      async () => { await this.runOnce(); },
      SECURITY_INVALIDATION_PROCESSOR_TASK_LABEL,
    );
  }

  async runOnce(): Promise<ConsoleSecurityInvalidationProcessorRunResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.drainOnce();
    } catch (error) {
      this.options.reportError?.(error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async drainOnce(): Promise<ConsoleSecurityInvalidationProcessorRunResult> {
    const renewedAt = this.now();
    const leasedUntil = new Date(renewedAt.getTime() + this.leaseDurationMs);
    await this.options.store.acquireReplicaLease({
      replicaId: this.options.replicaId,
      renewedAt,
      leaseUntil: leasedUntil,
    });

    let cursor = await this.options.store.getReplicaCursor(this.options.replicaId);
    let processed = 0;
    let acknowledged = 0;
    while (processed < this.batchSize) {
      const events = await this.options.store.listEventsAfter(cursor, this.batchSize - processed);
      if (events.length === 0) break;
      const outcome = await this.applyEventBatch(events, cursor);
      cursor = outcome.cursor;
      processed += outcome.processed;
      acknowledged += outcome.acknowledged;
    }

    return {
      replicaId: this.options.replicaId,
      leasedUntil,
      processed,
      acknowledged,
      cursorSequenceId: cursor,
    };
  }

  private async applyEventBatch(
    events: readonly SecurityInvalidationEvent[],
    initialCursor: number,
  ): Promise<Pick<ConsoleSecurityInvalidationProcessorRunResult, 'processed' | 'acknowledged'> & { cursor: number }> {
    let cursor = initialCursor;
    let processed = 0;
    let acknowledged = 0;
    for (const event of events) {
      await this.applyEvent(event);
      await this.options.store.acknowledgeEvent(event.eventId, this.options.replicaId, this.now());
      await this.options.store.recordReplicaCursor(this.options.replicaId, event.sequenceId, this.now());
      cursor = event.sequenceId;
      processed += 1;
      acknowledged += 1;
    }
    return { cursor, processed, acknowledged };
  }

  private async applyEvent(event: SecurityInvalidationEvent): Promise<void> {
    switch (event.kind) {
      case 'principal_disabled':
      case 'principal_credentials_revoked':
        await this.revokePrincipalSessions(event);
        return;
      case 'principal_authz_changed':
      case 'admin_factor_disabled':
      case 'console_elevation_revoked':
        await this.clearPrincipalElevations(event);
        return;
      case 'console_session_revoked':
        await this.revokeConsoleSession(event);
        return;
      case 'principal_reenabled':
      case 'runtime_sessions_terminated':
        return;
      default:
        assertNever(event.kind);
    }
  }

  private async revokePrincipalSessions(event: SecurityInvalidationEvent): Promise<void> {
    const userId = requireEventUserId(event);
    await this.options.sessionStore.revokeForUser(userId, this.now());
  }

  private async clearPrincipalElevations(event: SecurityInvalidationEvent): Promise<void> {
    const userId = requireEventUserId(event);
    await this.options.sessionStore.clearElevationsForUser(userId, this.now());
  }

  private async revokeConsoleSession(event: SecurityInvalidationEvent): Promise<void> {
    if (!event.consoleSessionIdHash) {
      throw new Error(`Security invalidation event ${event.eventId} is missing consoleSessionIdHash`);
    }
    await this.options.sessionStore.revoke(event.consoleSessionIdHash, this.now());
  }
}

function requireEventUserId(event: SecurityInvalidationEvent): string {
  if (!event.userId) {
    throw new Error(`Security invalidation event ${event.eventId} is missing userId`);
  }
  return event.userId;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported security invalidation event kind '${String(value)}'`);
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  return value;
}

function validateBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new Error('security invalidation processor batch size must be between 1 and 1000');
  }
  return value;
}
