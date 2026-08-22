import { randomUUID } from 'node:crypto';

import type { AllowlistMatchValues } from '../../auth/embedded-as/storage/IAuthStorageLayer.js';
import { InMemoryTransactionGate } from '../../utils/InMemoryTransactionGate.js';
import { ConsoleStoreConflictError } from './ConsoleStoreValidation.js';
import type {
  AllowlistAddInput,
  AllowlistRemoveInput,
  AllowlistUpdateInput,
  ConsoleAccountAllowlistEntry,
  IConsoleAccountAllowlistStore,
} from './IConsoleAccountAllowlistStore.js';
import {
  cloneAllowlistEntry,
  normalizeAllowlistDisplayValue,
  normalizeAllowlistValue,
  storedConsoleAllowlistValueMatches,
  validateAllowlistAddInput,
  validateAllowlistRemoveInput,
  validateAllowlistUpdateInput,
} from './IConsoleAccountAllowlistStore.js';

export class InMemoryConsoleAccountAllowlistStore implements IConsoleAccountAllowlistStore {
  private readonly entries = new Map<string, ConsoleAccountAllowlistEntry>();
  private transactionGate: InMemoryTransactionGate | null = null;

  constructor(initialEntries: readonly ConsoleAccountAllowlistEntry[] = []) {
    for (const entry of initialEntries) {
      this.entries.set(entry.id, cloneAllowlistEntry(entry));
    }
  }

  attachTransactionGate(gate: InMemoryTransactionGate): InMemoryTransactionGate {
    this.transactionGate ??= gate;
    return this.transactionGate;
  }

  createTransactionSnapshot(): unknown {
    return [...this.entries.entries()].map(([id, value]) => [id, cloneAllowlistEntry(value)] as const);
  }

  restoreTransactionSnapshot(snapshot: unknown): void {
    this.entries.clear();
    for (const [id, value] of snapshot as readonly (readonly [string, ConsoleAccountAllowlistEntry])[]) {
      this.entries.set(id, cloneAllowlistEntry(value));
    }
  }

  async listActive(): Promise<ConsoleAccountAllowlistEntry[]> {
    return this.runRead(async () => {
      await Promise.resolve();
      return [...this.entries.values()]
        .filter(entry => !entry.revokedAt)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .map(entry => cloneAllowlistEntry(entry));
    });
  }

  async hasActiveEntries(): Promise<boolean> {
    return this.runRead(async () => {
      await Promise.resolve();
      return [...this.entries.values()].some(entry => !entry.revokedAt);
    });
  }

  async matchesIdentity(values: AllowlistMatchValues): Promise<boolean> {
    return this.runRead(async () => {
      await Promise.resolve();
      for (const entry of this.entries.values()) {
        if (entry.revokedAt) continue;
        if (entry.kind === 'email' && values.email &&
          storedConsoleAllowlistValueMatches(entry.kind, entry.displayValue, values.email)) return true;
        if (entry.kind === 'github_username' && values.githubUsername &&
          storedConsoleAllowlistValueMatches(entry.kind, entry.displayValue, values.githubUsername)) return true;
        if (entry.kind === 'github_id' && values.githubId &&
          storedConsoleAllowlistValueMatches(entry.kind, entry.displayValue, values.githubId)) return true;
      }
      return false;
    });
  }

  async deniesIdentity(values: AllowlistMatchValues): Promise<boolean> {
    return this.runRead(async () => {
      await Promise.resolve();
      let newestActiveAt = Number.NEGATIVE_INFINITY;
      let newestRevokedAt = Number.NEGATIVE_INFINITY;
      for (const entry of this.entries.values()) {
        const matches = (entry.kind === 'email' && values.email &&
            storedConsoleAllowlistValueMatches(entry.kind, entry.displayValue, values.email))
          || (entry.kind === 'github_username' && values.githubUsername &&
            storedConsoleAllowlistValueMatches(entry.kind, entry.displayValue, values.githubUsername))
          || (entry.kind === 'github_id' && values.githubId &&
            storedConsoleAllowlistValueMatches(entry.kind, entry.displayValue, values.githubId));
        if (!matches) continue;
        if (entry.revokedAt) {
          newestRevokedAt = Math.max(newestRevokedAt, entry.revokedAt.getTime());
        } else {
          newestActiveAt = Math.max(newestActiveAt, entry.createdAt.getTime());
        }
      }
      return newestRevokedAt !== Number.NEGATIVE_INFINITY
        && newestRevokedAt >= newestActiveAt;
    });
  }

  async findActive(id: string): Promise<ConsoleAccountAllowlistEntry | null> {
    return this.runRead(async () => {
      await Promise.resolve();
      const entry = this.entries.get(id);
      return entry && !entry.revokedAt ? cloneAllowlistEntry(entry) : null;
    });
  }

  async add(input: AllowlistAddInput): Promise<ConsoleAccountAllowlistEntry> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateAllowlistAddInput(input);
      const normalizedValue = normalizeAllowlistValue(input.kind, input.value);
      if ([...this.entries.values()].some(entry =>
        !entry.revokedAt && entry.kind === input.kind &&
        storedConsoleAllowlistValueMatches(entry.kind, entry.displayValue, input.value))) {
        throw new ConsoleStoreConflictError('active allowlist entry already exists');
      }
      const entry: ConsoleAccountAllowlistEntry = {
        id: randomUUID(),
        kind: input.kind,
        normalizedValue,
        displayValue: normalizeAllowlistDisplayValue(input.value),
        note: input.note ?? null,
        createdByUserId: input.createdByUserId,
        createdAt: new Date(input.createdAt),
        revokedByUserId: null,
        revokedAt: null,
      };
      this.entries.set(entry.id, cloneAllowlistEntry(entry));
      return cloneAllowlistEntry(entry);
    });
  }

  async update(input: AllowlistUpdateInput): Promise<ConsoleAccountAllowlistEntry | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateAllowlistUpdateInput(input);
      const entry = this.entries.get(input.id);
      if (!entry || entry.revokedAt) return null;
      const updated = {
        ...entry,
        note: input.note === undefined ? entry.note : input.note,
      };
      this.entries.set(entry.id, cloneAllowlistEntry(updated));
      return cloneAllowlistEntry(updated);
    });
  }

  async remove(input: AllowlistRemoveInput): Promise<ConsoleAccountAllowlistEntry | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateAllowlistRemoveInput(input);
      const entry = this.entries.get(input.id);
      if (!entry || entry.revokedAt) return null;
      const revoked = {
        ...entry,
        revokedByUserId: input.revokedByUserId,
        revokedAt: new Date(input.revokedAt),
      };
      this.entries.set(entry.id, cloneAllowlistEntry(revoked));
      return cloneAllowlistEntry(revoked);
    });
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runMutation(operation) ?? operation();
  }

  private runRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runRead(operation) ?? operation();
  }
}
