import {
  validateConsoleAdminAuditEvent,
  type ConsoleAdminAuditEvent,
  type IAdminAuditWriter,
} from './IAdminAuditWriter.js';
import { InMemoryTransactionGate } from '../../utils/InMemoryTransactionGate.js';

export class InMemoryAdminAuditWriter implements IAdminAuditWriter {
  private readonly events: ConsoleAdminAuditEvent[] = [];
  private transactionGate: InMemoryTransactionGate | null = null;

  attachTransactionGate(gate: InMemoryTransactionGate): InMemoryTransactionGate {
    this.transactionGate ??= gate;
    return this.transactionGate;
  }

  async write(event: ConsoleAdminAuditEvent): Promise<void> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateConsoleAdminAuditEvent(event);
      this.events.push(cloneEvent(event));
    });
  }

  getEvents(): readonly ConsoleAdminAuditEvent[] {
    return this.events.map(event => cloneEvent(event));
  }

  readEvents(): Promise<readonly ConsoleAdminAuditEvent[]> {
    return this.runRead(async () => this.events.map(event => cloneEvent(event)));
  }

  createTransactionSnapshot(): unknown {
    return this.events.map(cloneEvent);
  }

  restoreTransactionSnapshot(snapshot: unknown): void {
    this.events.length = 0;
    this.events.push(...(snapshot as readonly ConsoleAdminAuditEvent[]).map(cloneEvent));
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runMutation(operation) ?? operation();
  }

  private runRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runRead(operation) ?? operation();
  }
}

function cloneEvent(event: ConsoleAdminAuditEvent): ConsoleAdminAuditEvent {
  return {
    ...event,
    occurredAt: new Date(event.occurredAt),
    actorConsoleSessionHash: Buffer.from(event.actorConsoleSessionHash),
    elevationAmr: [...event.elevationAmr],
    elevationAuthTime: event.elevationAuthTime
      ? new Date(event.elevationAuthTime)
      : null,
    argsRedacted: cloneJsonRecord(event.argsRedacted),
    resultDetailRedacted: event.resultDetailRedacted
      ? cloneJsonRecord(event.resultDetailRedacted)
      : null,
  };
}

function cloneJsonRecord(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return structuredClone(record) as Readonly<Record<string, unknown>>;
}
