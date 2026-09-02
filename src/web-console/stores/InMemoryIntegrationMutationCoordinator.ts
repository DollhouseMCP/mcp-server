/**
 * Serializes descriptor mutation with descriptor-bound credential persistence
 * for the loopback-only in-memory backend. PostgreSQL obtains the same
 * guarantee from row/advisory locks inside one transaction.
 */
export class InMemoryIntegrationMutationCoordinator {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous.catch(() => { /* a prior failure must not poison the lock */ });
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
