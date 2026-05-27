import { randomUUID } from 'node:crypto';

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
  normalizeAllowlistValue,
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
      !entry.revokedAt && entry.kind === input.kind && entry.normalizedValue === normalizedValue)) {
      throw new ConsoleStoreConflictError('active allowlist entry already exists');
    }
    const entry: ConsoleAccountAllowlistEntry = {
      id: randomUUID(),
      kind: input.kind,
      normalizedValue,
      displayValue: input.value.trim(),
      note: input.note ?? null,
      createdByUserId: input.createdByUserId,
      createdAt: new Date(input.createdAt.getTime()),
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
      revokedAt: new Date(input.revokedAt.getTime()),
    };
    this.entries.set(entry.id, cloneAllowlistEntry(revoked));
    return cloneAllowlistEntry(revoked);
  }
}
