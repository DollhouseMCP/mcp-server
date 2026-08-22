import { randomUUID } from 'node:crypto';

import { InMemoryTransactionGate } from '../../../utils/InMemoryTransactionGate.js';
import { ConsoleStoreValidationError } from '../../stores/ConsoleStoreValidation.js';
import type {
  IConsoleSecurityInvalidationStore,
  ReplicaLease,
  SecurityInvalidationEvent,
  SecurityInvalidationEventInput,
} from './IConsoleSecurityInvalidationStore.js';
import {
  cloneReplicaLease,
  cloneSecurityInvalidationEvent,
  validateEventId,
  validateReplicaId,
  validateReplicaLease,
  validateSecurityInvalidationEventInput,
  validateSequenceId,
} from './IConsoleSecurityInvalidationStore.js';

export class InMemoryConsoleSecurityInvalidationStore implements IConsoleSecurityInvalidationStore {
  private readonly events: SecurityInvalidationEvent[] = [];
  private readonly cursors = new Map<string, number>();
  private readonly leases = new Map<string, ReplicaLease>();
  private readonly acknowledgements = new Map<string, Map<string, Date>>();
  private transactionGate: InMemoryTransactionGate | null = null;

  attachTransactionGate(gate: InMemoryTransactionGate): InMemoryTransactionGate {
    this.transactionGate ??= gate;
    return this.transactionGate;
  }

  createTransactionSnapshot(): unknown {
    return {
      events: this.events.map(cloneSecurityInvalidationEvent),
      cursors: [...this.cursors.entries()],
      leases: [...this.leases.entries()].map(([id, value]) => [id, cloneReplicaLease(value)] as const),
      acknowledgements: [...this.acknowledgements.entries()].map(([eventId, values]) => [
        eventId,
        [...values.entries()].map(([replicaId, at]) => [replicaId, new Date(at)] as const),
      ] as const),
    };
  }

  restoreTransactionSnapshot(snapshot: unknown): void {
    const state = snapshot as {
      events: readonly SecurityInvalidationEvent[];
      cursors: readonly (readonly [string, number])[];
      leases: readonly (readonly [string, ReplicaLease])[];
      acknowledgements: readonly (readonly [string, readonly (readonly [string, Date])[]])[];
    };
    this.events.length = 0;
    this.events.push(...state.events.map(cloneSecurityInvalidationEvent));
    this.cursors.clear();
    this.leases.clear();
    this.acknowledgements.clear();
    for (const [id, value] of state.cursors) this.cursors.set(id, value);
    for (const [id, value] of state.leases) this.leases.set(id, cloneReplicaLease(value));
    for (const [eventId, values] of state.acknowledgements) {
      this.acknowledgements.set(eventId, new Map(values.map(([id, at]) => [id, new Date(at)])));
    }
  }

  async appendEvent(input: SecurityInvalidationEventInput): Promise<SecurityInvalidationEvent> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateSecurityInvalidationEventInput(input);
      const event: SecurityInvalidationEvent = {
        sequenceId: this.events.length + 1,
        eventId: randomUUID(),
        kind: input.kind,
        urgency: input.urgency,
        userId: input.userId,
        consoleSessionIdHash: input.consoleSessionIdHash ? Buffer.from(input.consoleSessionIdHash) : null,
        authzVersion: input.authzVersion ?? null,
        reason: input.reason,
        payload: { ...input.payload },
        createdAt: new Date(input.createdAt),
        createdByUserId: input.createdByUserId ?? null,
      };
      this.events.push(cloneSecurityInvalidationEvent(event));
      return cloneSecurityInvalidationEvent(event);
    });
  }

  async listEventsAfter(sequenceId: number, limit = 100): Promise<SecurityInvalidationEvent[]> {
    return this.runRead(async () => {
      await Promise.resolve();
      validateSequenceId(sequenceId);
      validateLimit(limit);
      return this.events
        .filter(event => event.sequenceId > sequenceId)
        .slice(0, limit)
        .map(event => cloneSecurityInvalidationEvent(event));
    });
  }

  async getReplicaCursor(replicaId: string): Promise<number> {
    return this.runRead(async () => {
      await Promise.resolve();
      validateReplicaId(replicaId);
      return this.cursors.get(replicaId) ?? 0;
    });
  }

  async recordReplicaCursor(replicaId: string, sequenceId: number): Promise<void> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateReplicaId(replicaId);
      validateSequenceId(sequenceId);
      const current = this.cursors.get(replicaId) ?? 0;
      if (sequenceId >= current) this.cursors.set(replicaId, sequenceId);
    });
  }

  async acquireReplicaLease(input: ReplicaLease): Promise<void> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateReplicaLease(input);
      this.leases.set(input.replicaId, cloneReplicaLease(input));
    });
  }

  async listLiveReplicaIds(at: Date = new Date()): Promise<string[]> {
    return this.runRead(async () => {
      await Promise.resolve();
      return [...this.leases.values()]
        .filter(lease => lease.leaseUntil > at)
        .map(lease => lease.replicaId)
        .sort((a, b) => a.localeCompare(b));
    });
  }

  async acknowledgeEvent(eventId: string, replicaId: string, acknowledgedAt: Date = new Date()): Promise<void> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateEventId(eventId);
      validateReplicaId(replicaId);
      const eventAcks = this.acknowledgements.get(eventId) ?? new Map<string, Date>();
      eventAcks.set(replicaId, new Date(acknowledgedAt));
      this.acknowledgements.set(eventId, eventAcks);
    });
  }

  async listAcknowledgedReplicaIds(eventId: string): Promise<string[]> {
    return this.runRead(async () => {
      await Promise.resolve();
      validateEventId(eventId);
      return [...(this.acknowledgements.get(eventId)?.keys() ?? [])].sort((a, b) => a.localeCompare(b));
    });
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runMutation(operation) ?? operation();
  }

  private runRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runRead(operation) ?? operation();
  }
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ConsoleStoreValidationError('security invalidation event limit must be between 1 and 1000');
  }
}
