import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { and, eq, isNull, lte, sql } from 'drizzle-orm';

import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext } from '../database/rls.js';
import { agentReplacementJournals } from '../database/schema/agents.js';
import type { SessionIdResolver, UserIdResolver } from '../database/UserContext.js';
import { isUniqueViolation } from '../database/db-utils.js';
import type {
  AgentSnapshotReplacementJournalEntry,
  AgentSnapshotReplacementRecord,
  IAgentSnapshotReplacementJournal,
  NewAgentSnapshotReplacementRecord,
} from '../elements/agents/AgentSnapshotReplacementJournal.js';
import {
  canonicalAgentMutationIdentity,
  parseAgentSnapshotReplacementRecord,
} from '../elements/agents/AgentSnapshotReplacementJournal.js';
import {
  readFilesystemProcessIncarnation,
  sameFilesystemProcessIncarnation,
} from '../security/filesystemInterprocessGuard.js';
import { logger } from '../utils/logger.js';
import {
  afterAgentReplacementCommit,
  hasAgentReplacementTransaction,
  runInAgentReplacementTransaction,
  withAgentReplacementTransactionOr,
} from './AgentReplacementTransactionContext.js';

const JOURNAL_VERSION = 1;
const DEFAULT_LEASE_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const LIVE_DATABASE_OPERATIONS = new Map<string, string>();

export class DatabaseAgentSnapshotReplacementJournal
implements IAgentSnapshotReplacementJournal {
  private readonly instanceId = randomUUID();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly ownershipScopes = new Map<string, { userId: string; sessionId: string }>();

  constructor(
    private readonly db: DatabaseInstance,
    private readonly getCurrentUserId: UserIdResolver,
    private readonly getCurrentSessionId: SessionIdResolver,
    private readonly leaseMs = DEFAULT_LEASE_MS,
    private readonly processIncarnationProvider = readFilesystemProcessIncarnation,
  ) {}

  async initialize(): Promise<void> {
    // Schema migration 0053 owns durable initialization.
  }

  async create(
    input: NewAgentSnapshotReplacementRecord,
  ): Promise<AgentSnapshotReplacementJournalEntry> {
    if (!input.isDatabaseMode) {
      throw new Error('Database replacement journal requires database mode');
    }
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const now = new Date();
    const ownerIncarnation = await this.processIncarnationProvider(process.pid).catch(() => null);
    const record: AgentSnapshotReplacementRecord = {
      version: JOURNAL_VERSION,
      operationId,
      createdAt: now.toISOString(),
      ownerHost: hostname(),
      ownerPid: process.pid,
      ownerIncarnation,
      ownerInstanceId: this.instanceId,
      recoveryNotBefore: new Date(now.getTime() + this.leaseMs).toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      releasedAt: null,
      leaseToken,
      ...input,
    };
    const userId = this.getCurrentUserId();
    const sessionId = this.getCurrentSessionId();
    if (input.stateKey.sessionId !== sessionId) {
      throw new Error('Database replacement journal state session does not match its owner');
    }
    try {
      await this.withMutation(userId, async (tx) => {
        await tx.insert(agentReplacementJournals).values({
        operationId,
        userId,
        sessionId,
        agentId: input.stateKey.agentElementId,
        agentName: input.agentName,
        ownerHost: record.ownerHost,
        ownerPid: record.ownerPid,
        ownerProcessIncarnation: record.ownerIncarnation,
        ownerInstanceId: record.ownerInstanceId,
        leaseToken,
        heartbeatAt: now,
        leaseExpiresAt: new Date(record.leaseExpiresAt),
        payload: record,
        createdAt: now,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(`Agent snapshot replacement is already active for '${input.agentName}'`);
      }
      throw error;
    }
    const entry = { journalPath: operationId, record };
    if (!hasAgentReplacementTransaction(userId)) this.track(entry, userId, sessionId);
    return entry;
  }

  async list(): Promise<AgentSnapshotReplacementJournalEntry[]> {
    const userId = this.getCurrentUserId();
    const rows = await this.withMutation(userId, (tx) => tx
      .select()
      .from(agentReplacementJournals)
      .where(and(
        eq(agentReplacementJournals.userId, userId),
        isNull(agentReplacementJournals.quarantinedAt),
      )));
    const entries: AgentSnapshotReplacementJournalEntry[] = [];
    for (const row of rows) {
      try {
        entries.push(this.toEntry(row));
      } catch (error) {
        await this.quarantineMalformedRow(row.operationId, userId, error);
      }
    }
    return entries;
  }

  async read(operationId: string): Promise<AgentSnapshotReplacementJournalEntry | null> {
    const userId = this.getCurrentUserId();
    const rows = await this.withMutation(userId, (tx) => tx
      .select()
      .from(agentReplacementJournals)
      .where(and(
        eq(agentReplacementJournals.operationId, operationId),
        eq(agentReplacementJournals.userId, userId),
      ))
      .limit(1));
    if (!rows[0]) return null;
    try {
      return this.toEntry(rows[0]);
    } catch (error) {
      await this.quarantineMalformedRow(rows[0].operationId, userId, error);
      return null;
    }
  }

  async remove(operationId: string, expectedLeaseToken: string): Promise<void> {
    const userId = this.getCurrentUserId();
    const removed = await this.withMutation(userId, async (tx) =>
      tx.delete(agentReplacementJournals).where(and(
        eq(agentReplacementJournals.operationId, operationId),
        eq(agentReplacementJournals.userId, userId),
        eq(agentReplacementJournals.leaseToken, expectedLeaseToken),
      )).returning({ operationId: agentReplacementJournals.operationId })
    );
    if (removed.length === 0) {
      throw new Error('Agent replacement journal removal lost its lease fence');
    }
    this.stopAfterCommit(operationId, expectedLeaseToken);
  }

  async runWhileOwned<T>(
    entry: AgentSnapshotReplacementJournalEntry,
    operation: () => Promise<T>,
  ): Promise<T> {
    const userId = this.getCurrentUserId();
    const ambient = hasAgentReplacementTransaction(userId);
    if (!ambient && LIVE_DATABASE_OPERATIONS.get(entry.record.operationId) !== entry.record.leaseToken) {
      throw new Error(`Agent replacement lease was lost for '${entry.record.agentName}'`);
    }
    if (ambient) return this.runOwnedMutation(entry, userId, operation);
    const afterCommit: Array<() => void | Promise<void>> = [];
    const afterRollback: Array<(error: unknown) => void | Promise<void>> = [];
    let result: T;
    try {
      result = await withUserContext(this.db, userId, async (tx) => {
        const rows = await tx
          .select({ leaseToken: agentReplacementJournals.leaseToken })
          .from(agentReplacementJournals)
          .where(and(
            eq(agentReplacementJournals.operationId, entry.record.operationId),
            eq(agentReplacementJournals.userId, userId),
            eq(agentReplacementJournals.leaseToken, entry.record.leaseToken),
            isNull(agentReplacementJournals.quarantinedAt),
          ))
          .for('update')
          .limit(1);
        if (!rows[0]) {
          throw new Error(`Agent replacement lease was lost for '${entry.record.agentName}'`);
        }
        return runInAgentReplacementTransaction(
          tx,
          userId,
          operation,
          afterCommit,
          afterRollback,
        );
      });
    } catch (error) {
      await runRollbackActions(afterRollback, error);
      throw error;
    }
    for (const callback of afterCommit) await callback();
    return result;
  }

  async runWithAgentMutationGate<T>(
    agentName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const userId = this.getCurrentUserId();
    if (hasAgentReplacementTransaction(userId)) return operation();
    const afterCommit: Array<() => void | Promise<void>> = [];
    const afterRollback: Array<(error: unknown) => void | Promise<void>> = [];
    const lockKey = `${userId}:${canonicalAgentMutationIdentity(agentName)}`;
    let result: T;
    try {
      result = await withUserContext(this.db, userId, async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        return runInAgentReplacementTransaction(
          tx,
          userId,
          operation,
          afterCommit,
          afterRollback,
        );
      });
    } catch (error) {
      await runRollbackActions(afterRollback, error);
      throw error;
    }
    for (const callback of afterCommit) await callback();
    return result;
  }

  async quarantine(entry: AgentSnapshotReplacementJournalEntry, reason: string): Promise<void> {
    const userId = this.getCurrentUserId();
    const quarantined = await this.withMutation(userId, async (tx) => tx
      .update(agentReplacementJournals)
      .set({
        quarantinedAt: new Date(),
        quarantineReason: reason.slice(0, 1_000),
        leaseExpiresAt: new Date(0),
      })
      .where(and(
        eq(agentReplacementJournals.operationId, entry.record.operationId),
        eq(agentReplacementJournals.userId, userId),
        eq(agentReplacementJournals.leaseToken, entry.record.leaseToken),
        isNull(agentReplacementJournals.quarantinedAt),
      ))
      .returning({ operationId: agentReplacementJournals.operationId }));
    if (quarantined.length === 0) {
      throw new Error('Agent replacement journal quarantine lost its lease fence');
    }
    this.stopAfterCommit(entry.record.operationId, entry.record.leaseToken);
  }

  async isRecoveryEligible(
    record: AgentSnapshotReplacementRecord,
    now = Date.now(),
  ): Promise<boolean> {
    if (LIVE_DATABASE_OPERATIONS.get(record.operationId) === record.leaseToken) return false;
    if (Date.parse(record.leaseExpiresAt) > now) return false;
    if (record.releasedAt !== null) return true;
    if (record.ownerHost === hostname()) {
      try {
        process.kill(record.ownerPid, 0);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return true;
        if (code !== 'EPERM') throw error;
      }
      const currentIncarnation = await this.processIncarnationProvider(record.ownerPid)
        .catch(() => null);
      if (!record.ownerIncarnation || !currentIncarnation) return false;
      return !sameFilesystemProcessIncarnation(record.ownerIncarnation, currentIncarnation);
    }
    return true;
  }

  async claimForRecovery(
    entry: AgentSnapshotReplacementJournalEntry,
    now = Date.now(),
  ): Promise<AgentSnapshotReplacementJournalEntry | null> {
    if (!await this.isRecoveryEligible(entry.record, now)) return null;
    const userId = this.getCurrentUserId();
    const sessionId = entry.record.stateKey.sessionId;
    if (!sessionId) throw new Error('Database replacement journal is missing its session identity');
    const leaseToken = randomUUID();
    const ownerIncarnation = await this.processIncarnationProvider(process.pid).catch(() => null);
    const claimedAt = new Date(now);
    const leaseExpiresAt = new Date(now + this.leaseMs);
    const ambient = hasAgentReplacementTransaction(userId);
    const claimed = await this.withMutation(userId, async (tx) => {
      const rows = await tx.update(agentReplacementJournals).set({
        ownerHost: hostname(),
        ownerPid: process.pid,
        ownerInstanceId: this.instanceId,
        ownerProcessIncarnation: ownerIncarnation,
        leaseToken,
        heartbeatAt: claimedAt,
        leaseExpiresAt,
        payload: {
          ...entry.record,
          ownerHost: hostname(),
          ownerPid: process.pid,
          ownerIncarnation,
          ownerInstanceId: this.instanceId,
          heartbeatAt: claimedAt.toISOString(),
          leaseExpiresAt: leaseExpiresAt.toISOString(),
          releasedAt: null,
          leaseToken,
        },
      }).where(and(
        eq(agentReplacementJournals.operationId, entry.record.operationId),
        eq(agentReplacementJournals.userId, userId),
        eq(agentReplacementJournals.sessionId, sessionId),
        eq(agentReplacementJournals.leaseToken, entry.record.leaseToken),
        lte(agentReplacementJournals.leaseExpiresAt, claimedAt),
      )).returning();
      return rows[0] ?? null;
    });
    if (!claimed) return null;
    const claimedEntry = this.toEntry(claimed);
    if (!ambient) this.track(claimedEntry, userId, sessionId);
    return claimedEntry;
  }

  async assertOwnership(entry: AgentSnapshotReplacementJournalEntry): Promise<void> {
    const current = await this.read(entry.record.operationId);
    if (
      !current ||
      current.record.leaseToken !== entry.record.leaseToken ||
      (!hasAgentReplacementTransaction(this.getCurrentUserId()) &&
        LIVE_DATABASE_OPERATIONS.get(entry.record.operationId) !== entry.record.leaseToken)
    ) {
      throw new Error(`Agent replacement lease was lost for '${entry.record.agentName}'`);
    }
  }

  async releaseOwnership(entry: AgentSnapshotReplacementJournalEntry): Promise<void> {
    const userId = this.getCurrentUserId();
    const releasedLeaseToken = randomUUID();
    const released = await this.withMutation(userId, async (tx) => {
      const releasedAt = new Date();
      return tx.update(agentReplacementJournals).set({
        ownerProcessIncarnation: null,
        leaseToken: releasedLeaseToken,
        heartbeatAt: releasedAt,
        leaseExpiresAt: new Date(0),
        payload: {
          ...entry.record,
          ownerIncarnation: null,
          heartbeatAt: releasedAt.toISOString(),
          leaseExpiresAt: new Date(0).toISOString(),
          releasedAt: releasedAt.toISOString(),
          leaseToken: releasedLeaseToken,
        },
      }).where(and(
        eq(agentReplacementJournals.operationId, entry.record.operationId),
        eq(agentReplacementJournals.userId, userId),
        eq(agentReplacementJournals.leaseToken, entry.record.leaseToken),
      )).returning({ operationId: agentReplacementJournals.operationId });
    });
    if (released.length !== 1) {
      throw new Error('Agent replacement journal release lost its lease fence');
    }
    this.stopAfterCommit(entry.record.operationId, entry.record.leaseToken);
  }

  private toEntry(row: typeof agentReplacementJournals.$inferSelect): AgentSnapshotReplacementJournalEntry {
    const payload = parseAgentSnapshotReplacementRecord(row.payload);
    if (
      payload.operationId !== row.operationId ||
      payload.agentName !== row.agentName ||
      payload.stateKey.agentElementId !== row.agentId ||
      payload.stateKey.sessionId !== row.sessionId
    ) {
      throw new Error('Agent replacement journal database identity does not match its payload');
    }
    const record = parseAgentSnapshotReplacementRecord({
      ...payload,
      operationId: row.operationId,
      agentName: row.agentName,
      ownerHost: row.ownerHost,
      ownerPid: row.ownerPid,
      ownerInstanceId: row.ownerInstanceId,
      ownerIncarnation: row.ownerProcessIncarnation,
      leaseToken: row.leaseToken,
      heartbeatAt: row.heartbeatAt.toISOString(),
      leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    });
    return {
      journalPath: row.operationId,
      record,
    };
  }

  private async runOwnedMutation<T>(
    entry: AgentSnapshotReplacementJournalEntry,
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withMutation(userId, async (tx) => {
      const rows = await tx
        .select({ leaseToken: agentReplacementJournals.leaseToken })
        .from(agentReplacementJournals)
        .where(and(
          eq(agentReplacementJournals.operationId, entry.record.operationId),
          eq(agentReplacementJournals.userId, userId),
          eq(agentReplacementJournals.leaseToken, entry.record.leaseToken),
          isNull(agentReplacementJournals.quarantinedAt),
        ))
        .for('update')
        .limit(1);
      if (!rows[0]) {
        throw new Error(`Agent replacement lease was lost for '${entry.record.agentName}'`);
      }
      return operation();
    });
  }

  private withMutation<T>(userId: string, operation: (tx: import('../database/db-utils.js').DrizzleTx) => Promise<T>): Promise<T> {
    return withAgentReplacementTransactionOr(
      userId,
      fallbackOperation => withUserContext(this.db, userId, fallbackOperation),
      operation,
    );
  }

  private async quarantineMalformedRow(
    operationId: string,
    userId: string,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    await this.withMutation(userId, async (tx) => {
      await tx.update(agentReplacementJournals).set({
        quarantinedAt: new Date(),
        quarantineReason: reason.slice(0, 1_000),
        leaseExpiresAt: new Date(0),
      }).where(and(
        eq(agentReplacementJournals.operationId, operationId),
        eq(agentReplacementJournals.userId, userId),
        isNull(agentReplacementJournals.quarantinedAt),
      ));
    });
    const liveToken = LIVE_DATABASE_OPERATIONS.get(operationId);
    if (liveToken) this.stop(operationId, liveToken);
    logger.error('Quarantined malformed database agent replacement journal', {
      operationId,
      error,
    });
  }

  private track(
    entry: AgentSnapshotReplacementJournalEntry,
    userId: string,
    sessionId: string,
  ): void {
    LIVE_DATABASE_OPERATIONS.set(entry.record.operationId, entry.record.leaseToken);
    this.ownershipScopes.set(entry.record.operationId, { userId, sessionId });
    const timer = setInterval(() => {
      void this.heartbeat(entry).catch(() => this.stop(
        entry.record.operationId,
        entry.record.leaseToken,
      ));
    }, Math.max(25, Math.min(HEARTBEAT_MS, Math.floor(this.leaseMs / 3))));
    timer.unref();
    this.timers.set(entry.record.operationId, timer);
  }

  private async heartbeat(entry: AgentSnapshotReplacementJournalEntry): Promise<void> {
    if (LIVE_DATABASE_OPERATIONS.get(entry.record.operationId) !== entry.record.leaseToken) return;
    const scope = this.ownershipScopes.get(entry.record.operationId);
    if (!scope) return;
    const { userId, sessionId } = scope;
    const now = new Date();
    const renewed = await withUserContext(this.db, userId, async (tx) => tx
      .update(agentReplacementJournals)
      .set({ heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + this.leaseMs) })
      .where(and(
        eq(agentReplacementJournals.operationId, entry.record.operationId),
        eq(agentReplacementJournals.userId, userId),
        eq(agentReplacementJournals.sessionId, sessionId),
        eq(agentReplacementJournals.leaseToken, entry.record.leaseToken),
      ))
      .returning({ operationId: agentReplacementJournals.operationId }));
    if (renewed.length === 0) this.stop(entry.record.operationId, entry.record.leaseToken);
  }

  private stop(operationId: string, expectedLeaseToken: string): void {
    if (LIVE_DATABASE_OPERATIONS.get(operationId) !== expectedLeaseToken) return;
    LIVE_DATABASE_OPERATIONS.delete(operationId);
    this.ownershipScopes.delete(operationId);
    const timer = this.timers.get(operationId);
    if (timer) clearInterval(timer);
    this.timers.delete(operationId);
  }

  private stopAfterCommit(operationId: string, expectedLeaseToken: string): void {
    const stopOwnership = () => this.stop(operationId, expectedLeaseToken);
    if (!afterAgentReplacementCommit(stopOwnership)) stopOwnership();
  }
}

async function runRollbackActions(
  actions: ReadonlyArray<(error: unknown) => void | Promise<void>>,
  error: unknown,
): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action(error);
    } catch (rollbackError) {
      failures.push(rollbackError);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      [error, ...failures],
      'Agent replacement transaction rollback actions failed',
    );
  }
}
