import { randomUUID } from 'node:crypto';

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

  async appendEvent(input: SecurityInvalidationEventInput): Promise<SecurityInvalidationEvent> {
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
      payload: { ...(input.payload ?? {}) },
      createdAt: new Date(input.createdAt.getTime()),
      createdByUserId: input.createdByUserId ?? null,
    };
    this.events.push(cloneSecurityInvalidationEvent(event));
    return cloneSecurityInvalidationEvent(event);
  }

  async listEventsAfter(sequenceId: number, limit = 100): Promise<SecurityInvalidationEvent[]> {
    await Promise.resolve();
    validateSequenceId(sequenceId);
    validateLimit(limit);
    return this.events
      .filter(event => event.sequenceId > sequenceId)
      .slice(0, limit)
      .map(event => cloneSecurityInvalidationEvent(event));
  }

  async getReplicaCursor(replicaId: string): Promise<number> {
    await Promise.resolve();
    validateReplicaId(replicaId);
    return this.cursors.get(replicaId) ?? 0;
  }

  async recordReplicaCursor(replicaId: string, sequenceId: number): Promise<void> {
    await Promise.resolve();
    validateReplicaId(replicaId);
    validateSequenceId(sequenceId);
    const current = this.cursors.get(replicaId) ?? 0;
    if (sequenceId >= current) this.cursors.set(replicaId, sequenceId);
  }

  async acquireReplicaLease(input: ReplicaLease): Promise<void> {
    await Promise.resolve();
    validateReplicaLease(input);
    this.leases.set(input.replicaId, cloneReplicaLease(input));
  }

  async listLiveReplicaIds(at: Date = new Date()): Promise<string[]> {
    await Promise.resolve();
    return [...this.leases.values()]
      .filter(lease => lease.leaseUntil > at)
      .map(lease => lease.replicaId)
      .sort();
  }

  async acknowledgeEvent(eventId: string, replicaId: string, acknowledgedAt: Date = new Date()): Promise<void> {
    await Promise.resolve();
    validateEventId(eventId);
    validateReplicaId(replicaId);
    const eventAcks = this.acknowledgements.get(eventId) ?? new Map<string, Date>();
    eventAcks.set(replicaId, new Date(acknowledgedAt.getTime()));
    this.acknowledgements.set(eventId, eventAcks);
  }

  async listAcknowledgedReplicaIds(eventId: string): Promise<string[]> {
    await Promise.resolve();
    validateEventId(eventId);
    return [...(this.acknowledgements.get(eventId)?.keys() ?? [])].sort();
  }
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ConsoleStoreValidationError('security invalidation event limit must be between 1 and 1000');
  }
}
