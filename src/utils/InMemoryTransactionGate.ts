import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Serializes mutations across in-memory stores participating in one logical
 * transaction. Async-local ownership lets transaction callbacks invoke normal
 * store methods without deadlocking on their own gate.
 */
export class InMemoryTransactionGate {
  private readonly ownerContext = new AsyncLocalStorage<{ active: boolean }>();
  private tail: Promise<void> = Promise.resolve();

  async runTransaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.hasActiveOwner()) return operation();
    return this.runOwnedExclusive(operation);
  }

  async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.hasActiveOwner()) return operation();
    return this.runOwnedExclusive(operation);
  }

  async runRead<T>(operation: () => Promise<T>): Promise<T> {
    if (this.hasActiveOwner()) return operation();
    return this.runOwnedExclusive(operation);
  }

  private runOwnedExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.runExclusive(async () => {
      const owner = { active: true };
      return this.ownerContext.run(owner, async () => {
        try {
          return await operation();
        } finally {
          owner.active = false;
        }
      });
    });
  }

  private hasActiveOwner(): boolean {
    return this.ownerContext.getStore()?.active === true;
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => { /* an earlier caller cannot poison the gate */ }).then(() => current);
    this.tail = tail;
    await previous.catch(() => { /* an earlier caller cannot poison the gate */ });
    try {
      return await operation();
    } finally {
      release();
      if (this.tail === tail) this.tail = Promise.resolve();
    }
  }
}

export interface InMemoryTransactionGateParticipant {
  attachTransactionGate(gate: InMemoryTransactionGate): InMemoryTransactionGate;
}

export function attachSharedInMemoryTransactionGate(
  participants: readonly unknown[],
): InMemoryTransactionGate {
  let shared: InMemoryTransactionGate | null = null;
  for (const participant of participants) {
    if (!isGateParticipant(participant)) continue;
    const attached = participant.attachTransactionGate(shared ?? new InMemoryTransactionGate());
    if (shared && attached !== shared) {
      throw new Error('in-memory transaction participants are attached to different gates');
    }
    shared = attached;
  }
  return shared ?? new InMemoryTransactionGate();
}

function isGateParticipant(value: unknown): value is InMemoryTransactionGateParticipant {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as Partial<InMemoryTransactionGateParticipant>).attachTransactionGate === 'function';
}
