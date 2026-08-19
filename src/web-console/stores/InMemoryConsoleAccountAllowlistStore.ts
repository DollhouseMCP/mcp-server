import { randomUUID } from 'node:crypto';

import type { AllowlistMatchValues } from '../../auth/embedded-as/storage/IAuthStorageLayer.js';
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

  constructor(initialEntries: readonly ConsoleAccountAllowlistEntry[] = []) {
    for (const entry of initialEntries) {
      this.entries.set(entry.id, cloneAllowlistEntry(entry));
    }
  }

  async listActive(): Promise<ConsoleAccountAllowlistEntry[]> {
    await Promise.resolve();
    return [...this.entries.values()]
      .filter(entry => !entry.revokedAt)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map(entry => cloneAllowlistEntry(entry));
  }

  async hasActiveEntries(): Promise<boolean> {
    await Promise.resolve();
    return [...this.entries.values()].some(entry => !entry.revokedAt);
  }

  async matchesIdentity(values: AllowlistMatchValues): Promise<boolean> {
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
  }

  async deniesIdentity(values: AllowlistMatchValues): Promise<boolean> {
    await Promise.resolve();
    for (const entry of this.entries.values()) {
      if (!entry.revokedAt) continue;
      if (entry.kind === 'email' && values.email &&
        storedConsoleAllowlistValueMatches(entry.kind, entry.displayValue, values.email)) return true;
      if (entry.kind === 'github_username' && values.githubUsername &&
        storedConsoleAllowlistValueMatches(entry.kind, entry.displayValue, values.githubUsername)) return true;
      if (entry.kind === 'github_id' && values.githubId &&
        storedConsoleAllowlistValueMatches(entry.kind, entry.displayValue, values.githubId)) return true;
    }
    return false;
  }

  async findActive(id: string): Promise<ConsoleAccountAllowlistEntry | null> {
    await Promise.resolve();
    const entry = this.entries.get(id);
    return entry && !entry.revokedAt ? cloneAllowlistEntry(entry) : null;
  }

  async add(input: AllowlistAddInput): Promise<ConsoleAccountAllowlistEntry> {
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
  }

  async update(input: AllowlistUpdateInput): Promise<ConsoleAccountAllowlistEntry | null> {
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
  }

  async remove(input: AllowlistRemoveInput): Promise<ConsoleAccountAllowlistEntry | null> {
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
  }
}
