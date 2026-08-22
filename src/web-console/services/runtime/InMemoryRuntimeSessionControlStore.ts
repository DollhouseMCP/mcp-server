import { randomUUID } from 'node:crypto';

import type {
  IRuntimeSessionControlStore,
  RuntimeOperationalCursor,
  RuntimeOperationalListQuery,
  RuntimeOperationalPresencePage,
  RuntimeSessionHeartbeatInput,
  RuntimeSessionHeartbeatResult,
  RuntimeSessionListQuery,
  RuntimeSessionPresence,
  RuntimeSessionPresenceInput,
  RuntimeTerminationAck,
  RuntimeTerminationAckInput,
  RuntimeTerminationCommand,
  RuntimeTerminationCommandInput,
} from './IRuntimeSessionControlStore.js';
import {
  cloneRuntimeSessionPresence,
  cloneRuntimeTerminationAck,
  cloneRuntimeTerminationCommand,
  validateRuntimeListQuery,
  validateRuntimeOperationalListQuery,
  validateRuntimeSessionHeartbeatInput,
  validateRuntimeSessionPresenceInput,
  validateRuntimeTerminationAckInput,
  validateRuntimeTerminationCommandInput,
  validateSessionId,
} from './IRuntimeSessionControlStore.js';
import { assertUuid } from '../../stores/ConsoleStoreValidation.js';
import { validateReplicaId } from '../invalidation/IConsoleSecurityInvalidationStore.js';
import { InMemoryTransactionGate } from '../../../utils/InMemoryTransactionGate.js';

export class InMemoryRuntimeSessionControlStore implements IRuntimeSessionControlStore {
  private readonly presence = new Map<string, RuntimeSessionPresence>();
  private readonly commands = new Map<string, RuntimeTerminationCommand>();
  private readonly acknowledgements = new Map<string, RuntimeTerminationAck>();
  private transactionGate: InMemoryTransactionGate | null = null;

  attachTransactionGate(gate: InMemoryTransactionGate): InMemoryTransactionGate {
    this.transactionGate ??= gate;
    return this.transactionGate;
  }

  createTransactionSnapshot(): unknown {
    return {
      presence: [...this.presence.entries()].map(([id, value]) => [id, cloneRuntimeSessionPresence(value)] as const),
      commands: [...this.commands.entries()].map(([id, value]) => [id, cloneRuntimeTerminationCommand(value)] as const),
      acknowledgements: [...this.acknowledgements.entries()].map(([id, value]) => [id, cloneRuntimeTerminationAck(value)] as const),
    };
  }

  restoreTransactionSnapshot(snapshot: unknown): void {
    const state = snapshot as {
      readonly presence: readonly (readonly [string, RuntimeSessionPresence])[];
      readonly commands: readonly (readonly [string, RuntimeTerminationCommand])[];
      readonly acknowledgements: readonly (readonly [string, RuntimeTerminationAck])[];
    };
    this.presence.clear();
    this.commands.clear();
    this.acknowledgements.clear();
    for (const [id, value] of state.presence) this.presence.set(id, cloneRuntimeSessionPresence(value));
    for (const [id, value] of state.commands) this.commands.set(id, cloneRuntimeTerminationCommand(value));
    for (const [id, value] of state.acknowledgements) this.acknowledgements.set(id, cloneRuntimeTerminationAck(value));
  }

  async registerPresence(input: RuntimeSessionPresenceInput): Promise<RuntimeSessionPresence> {
    await Promise.resolve();
    validateRuntimeSessionPresenceInput(input);
    const presence: RuntimeSessionPresence = {
      sessionId: input.sessionId,
      userId: input.userId,
      accountCorrelationId: input.accountCorrelationId,
      replicaId: input.replicaId,
      transport: input.transport,
      clientInfo: input.clientInfo ? { ...input.clientInfo } : null,
      startedAt: new Date(input.startedAt),
      lastActiveAt: new Date(input.lastActiveAt),
      requestCount: input.requestCount ?? 0,
      errorCount: input.errorCount ?? 0,
      leaseUntil: new Date(input.leaseUntil),
      status: 'active',
      closedAt: null,
    };
    this.presence.set(input.sessionId, cloneRuntimeSessionPresence(presence));
    return cloneRuntimeSessionPresence(presence);
  }

  async heartbeatPresence(input: RuntimeSessionHeartbeatInput): Promise<RuntimeSessionHeartbeatResult> {
    await Promise.resolve();
    validateRuntimeSessionHeartbeatInput(input);
    const current = this.presence.get(input.sessionId);
    if (!current) return { kind: 'lost', reason: 'missing' };
    if (current.replicaId !== input.replicaId) return { kind: 'lost', reason: 'replica_mismatch' };
    if (current.status !== 'active') return { kind: 'lost', reason: 'closing' };
    const updated: RuntimeSessionPresence = {
      ...current,
      lastActiveAt: new Date(input.lastActiveAt),
      requestCount: input.requestCount,
      errorCount: input.errorCount,
      leaseUntil: new Date(input.leaseUntil),
    };
    this.presence.set(input.sessionId, cloneRuntimeSessionPresence(updated));
    return { kind: 'updated', presence: cloneRuntimeSessionPresence(updated) };
  }

  async markPresenceClosing(
    sessionId: string,
    replicaId: string,
    closedAt: Date,
  ): Promise<RuntimeSessionPresence | null> {
    await Promise.resolve();
    validateSessionId(sessionId);
    validateReplicaId(replicaId);
    const current = this.presence.get(sessionId);
    if (!current || current.replicaId !== replicaId) return null;
    const updated: RuntimeSessionPresence = {
      ...current,
      status: 'closing',
      closedAt: new Date(closedAt),
    };
    this.presence.set(sessionId, cloneRuntimeSessionPresence(updated));
    return cloneRuntimeSessionPresence(updated);
  }

  async sweepStalePresence(before: Date = new Date()): Promise<number> {
    await Promise.resolve();
    let removed = 0;
    for (const [sessionId, current] of this.presence) {
      if (current.leaseUntil < before) {
        this.presence.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  async findPresence(sessionId: string, now: Date = new Date()): Promise<RuntimeSessionPresence | null> {
    await Promise.resolve();
    validateSessionId(sessionId);
    const current = this.presence.get(sessionId);
    return current && isVisiblePresence(current, now) ? cloneRuntimeSessionPresence(current) : null;
  }

  async findOperationalPresence(sessionId: string, now: Date = new Date()): Promise<RuntimeSessionPresence | null> {
    await Promise.resolve();
    validateSessionId(sessionId);
    const current = this.presence.get(sessionId);
    return current && isOperationalPresence(current, now) ? cloneRuntimeSessionPresence(current) : null;
  }

  async listPresenceByUser(
    userId: string,
    query: RuntimeSessionListQuery = {},
  ): Promise<RuntimeSessionPresence[]> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const parsed = validateRuntimeListQuery(query);
    return [...this.presence.values()]
      .filter(item => item.userId === userId && isVisiblePresence(item, parsed.now))
      .sort(comparePresence)
      .slice(0, parsed.limit)
      .map(item => cloneRuntimeSessionPresence(item));
  }

  async listAllPresenceByUser(userId: string, now: Date = new Date()): Promise<RuntimeSessionPresence[]> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    return [...this.presence.values()]
      .filter(item => item.userId === userId && isVisiblePresence(item, now))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      .map(item => cloneRuntimeSessionPresence(item));
  }

  async listOperationalPresence(query: RuntimeOperationalListQuery = {}): Promise<RuntimeOperationalPresencePage> {
    await Promise.resolve();
    const parsed = validateRuntimeOperationalListQuery(query);
    const filtered = [...this.presence.values()]
      .filter(item => isOperationalPresence(item, parsed.now))
      .filter(item => !parsed.status || item.status === parsed.status)
      .filter(item => !parsed.userId || item.userId === parsed.userId)
      .filter(item => !parsed.after || isAfterOperationalKey(item, parsed.after))
      .sort(compareOperationalKey);
    const items = filtered.slice(0, parsed.limit).map(item => cloneRuntimeSessionPresence(item));
    const last = items.at(-1);
    const nextCursor: RuntimeOperationalCursor | null = filtered.length > parsed.limit && last
      ? { lastActiveAt: last.lastActiveAt, sessionId: last.sessionId }
      : null;
    return { items, nextCursor };
  }

  async createTerminationCommand(input: RuntimeTerminationCommandInput): Promise<RuntimeTerminationCommand> {
    await Promise.resolve();
    validateRuntimeTerminationCommandInput(input);
    const command: RuntimeTerminationCommand = {
      commandId: input.commandId ?? randomUUID(),
      kind: 'terminate_session',
      sessionId: input.sessionId,
      targetReplicaId: input.targetReplicaId,
      reason: input.reason,
      requestedAt: new Date(input.requestedAt),
      requestedBy: { ...input.requestedBy },
      invalidationEventId: input.invalidationEventId ?? null,
    };
    this.commands.set(command.commandId, cloneRuntimeTerminationCommand(command));
    return cloneRuntimeTerminationCommand(command);
  }

  async listPendingCommandsForReplica(
    replicaId: string,
    query: RuntimeSessionListQuery = {},
  ): Promise<RuntimeTerminationCommand[]> {
    await Promise.resolve();
    validateReplicaId(replicaId);
    const parsed = validateRuntimeListQuery(query);
    return [...this.commands.values()]
      .filter(command => command.targetReplicaId === replicaId && !this.acknowledgements.has(command.commandId))
      .sort((left, right) => left.requestedAt.getTime() - right.requestedAt.getTime())
      .slice(0, parsed.limit)
      .map(command => cloneRuntimeTerminationCommand(command));
  }

  async acknowledgeCommand(input: RuntimeTerminationAckInput): Promise<boolean> {
    await Promise.resolve();
    validateRuntimeTerminationAckInput(input);
    if (this.acknowledgements.has(input.commandId)) return false;
    this.acknowledgements.set(input.commandId, {
      commandId: input.commandId,
      replicaId: input.replicaId,
      acknowledgedAt: new Date(input.acknowledgedAt),
      result: input.result,
      errorCode: input.errorCode ?? null,
    });
    return true;
  }

  async getCommandAck(commandId: string): Promise<RuntimeTerminationAck | null> {
    await Promise.resolve();
    assertUuid(commandId, 'commandId');
    const ack = this.acknowledgements.get(commandId);
    return ack ? cloneRuntimeTerminationAck(ack) : null;
  }

  async getCommand(commandId: string): Promise<RuntimeTerminationCommand | null> {
    await Promise.resolve();
    assertUuid(commandId, 'commandId');
    const command = this.commands.get(commandId);
    return command ? cloneRuntimeTerminationCommand(command) : null;
  }
}

/** In-memory mirror of the Postgres `(last_active_at DESC, session_id DESC)` operational ordering + `< cursor` predicate. */
function compareOperationalKey(left: RuntimeSessionPresence, right: RuntimeSessionPresence): number {
  const byTime = right.lastActiveAt.getTime() - left.lastActiveAt.getTime();
  return byTime === 0 ? right.sessionId.localeCompare(left.sessionId) : byTime;
}

function isAfterOperationalKey(item: RuntimeSessionPresence, after: RuntimeOperationalCursor): boolean {
  const byTime = item.lastActiveAt.getTime() - after.lastActiveAt.getTime();
  return byTime === 0 ? item.sessionId.localeCompare(after.sessionId) < 0 : byTime < 0;
}

function isVisiblePresence(presence: RuntimeSessionPresence, now: Date): boolean {
  return presence.status === 'active' && presence.leaseUntil > now;
}

function isOperationalPresence(presence: RuntimeSessionPresence, now: Date): boolean {
  return presence.leaseUntil > now;
}

function comparePresence(left: RuntimeSessionPresence, right: RuntimeSessionPresence): number {
  const activeCompare = right.lastActiveAt.getTime() - left.lastActiveAt.getTime();
  return activeCompare || left.sessionId.localeCompare(right.sessionId);
}
