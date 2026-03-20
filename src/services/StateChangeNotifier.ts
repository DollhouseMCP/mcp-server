import { EventEmitter } from 'events';

export type PersonaStateChangeType =
  | 'persona-activated'
  | 'persona-deactivated'
  | 'user-changed';

export interface PersonaStateChangeEvent {
  type: PersonaStateChangeType;
  previousValue: string | null;
  newValue: string | null;
  timestamp: Date;
}

/**
 * Lightweight pub/sub helper for persona-related state transitions.
 * Acts as the central hub that services can observe to stay in sync.
 */
export class StateChangeNotifier extends EventEmitter {
  notifyPersonaChange(event: PersonaStateChangeEvent): void {
    this.emit('state-change', event);
    this.emit(`state-change:${event.type}`, event);
  }

  async dispose(): Promise<void> {
    this.removeAllListeners();
  }
}
