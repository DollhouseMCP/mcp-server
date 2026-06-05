import {
  validateConsoleAdminAuditEvent,
  type ConsoleAdminAuditEvent,
  type IAdminAuditWriter,
} from './IAdminAuditWriter.js';

export class InMemoryAdminAuditWriter implements IAdminAuditWriter {
  private readonly events: ConsoleAdminAuditEvent[] = [];

  async write(event: ConsoleAdminAuditEvent): Promise<void> {
    await Promise.resolve();
    validateConsoleAdminAuditEvent(event);
    this.events.push(cloneEvent(event));
  }

  getEvents(): readonly ConsoleAdminAuditEvent[] {
    return this.events.map(event => cloneEvent(event));
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
