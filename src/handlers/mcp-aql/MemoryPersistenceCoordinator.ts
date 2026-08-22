import { AsyncKeyedLock } from '../../utils/AsyncKeyedLock.js';

export interface MemoryPersistenceVersion {
  readonly key: string;
  readonly generation: number;
}

interface MemoryPersistenceToken {
  readonly generation: number;
  invalidated: boolean;
  references: number;
}

interface MemoryPersistenceLease {
  readonly token: MemoryPersistenceToken;
  released: boolean;
}

/**
 * Coordinates memory persistence across HTTP sessions in this process.
 *
 * Session-local debounce state remains isolated, but the storage target belongs
 * to the user. A deletion therefore advances a user-and-memory generation so a
 * delayed save captured by any older session is discarded after the delete.
 */
export class MemoryPersistenceCoordinator {
  private readonly lock = new AsyncKeyedLock();
  private readonly currentTokens = new Map<string, MemoryPersistenceToken>();
  private readonly versionTokens = new WeakMap<MemoryPersistenceVersion, MemoryPersistenceLease>();
  private nextGeneration = 0;

  capture(key: string): MemoryPersistenceVersion {
    let token = this.currentTokens.get(key);
    if (!token) {
      token = { generation: this.nextGeneration, invalidated: false, references: 0 };
      this.nextGeneration += 1;
      this.currentTokens.set(key, token);
    }
    token.references += 1;
    const version = { key, generation: token.generation };
    this.versionTokens.set(version, { token, released: false });
    return version;
  }

  async runSave(
    version: MemoryPersistenceVersion,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    const outcome = await this.runMutation(version, operation);
    return outcome.accepted;
  }

  async runMutation<T>(
    version: MemoryPersistenceVersion,
    operation: () => Promise<T>,
  ): Promise<{ accepted: false } | { accepted: true; value: T }> {
    return this.lock.runExclusive(version.key, async () => {
      const lease = this.versionTokens.get(version);
      const token = lease?.token;
      if (!token || token.invalidated || token.generation !== version.generation
          || this.currentTokens.get(version.key) !== token) {
        this.release(version);
        return { accepted: false } as const;
      }
      // A failed durable save may be retried with the same lease by the
      // failure ledger, so release only after the operation succeeds.
      const value = await operation();
      this.release(version);
      return { accepted: true, value } as const;
    });
  }

  release(version: MemoryPersistenceVersion): void {
    const lease = this.versionTokens.get(version);
    if (!lease || lease.released) return;
    lease.released = true;
    lease.token.references = Math.max(0, lease.token.references - 1);
    if (lease.token.references === 0 && this.currentTokens.get(version.key) === lease.token) {
      lease.token.invalidated = true;
      this.currentTokens.delete(version.key);
    }
  }

  async runDelete<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.lock.runExclusive(key, async () => {
      const result = await operation();
      const token = this.currentTokens.get(key);
      if (token) {
        token.invalidated = true;
        this.currentTokens.delete(key);
      }
      return result;
    });
  }

  /** @internal Focused assertion that successful deletes reclaim key state. */
  trackedKeyCountForTesting(): number {
    return this.currentTokens.size;
  }
}

export const sharedMemoryPersistenceCoordinator = new MemoryPersistenceCoordinator();
