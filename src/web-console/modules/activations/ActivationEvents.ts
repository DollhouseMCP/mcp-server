import type { ConsoleActivatableElementType } from './ActivationTypes.js';

export type SessionActivationEventAction = 'activated' | 'deactivated';

export interface SessionActivationChangedEvent {
  readonly type: 'console.session.activation.changed.v1';
  readonly userId: string;
  readonly sessionId: string;
  readonly elementType: ConsoleActivatableElementType;
  readonly elementName: string;
  readonly action: SessionActivationEventAction;
  readonly occurredAt: Date;
}

export interface ISessionActivationEventSink {
  recordActivationChanged(event: SessionActivationChangedEvent): Promise<void>;
}

export class InMemorySessionActivationEventSink implements ISessionActivationEventSink {
  private readonly events: SessionActivationChangedEvent[] = [];

  recordActivationChanged(event: SessionActivationChangedEvent): Promise<void> {
    this.events.push({
      ...event,
      occurredAt: new Date(event.occurredAt),
    });
    return Promise.resolve();
  }

  listEvents(): readonly SessionActivationChangedEvent[] {
    return this.events.map(event => ({
      ...event,
      occurredAt: new Date(event.occurredAt),
    }));
  }
}
