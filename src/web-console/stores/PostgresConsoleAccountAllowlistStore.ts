import { and, asc, eq, isNull } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import type { DrizzleTx } from '../../database/db-utils.js';
import { accountAllowlistEntries } from '../../database/schema/index.js';
import {
  ConsoleStoreConflictError,
  isUniqueViolation,
} from './ConsoleStoreValidation.js';
import type {
  AllowlistAddInput,
  AllowlistRemoveInput,
  AllowlistUpdateInput,
  ConsoleAccountAllowlistEntry,
  IConsoleAccountAllowlistStore,
} from './IConsoleAccountAllowlistStore.js';
import {
  normalizeAllowlistValue,
  validateAllowlistAddInput,
  validateAllowlistRemoveInput,
  validateAllowlistUpdateInput,
} from './IConsoleAccountAllowlistStore.js';

export class PostgresConsoleAccountAllowlistStore implements IConsoleAccountAllowlistStore {
  constructor(private readonly db: DatabaseInstance) {}

  async listActive(): Promise<ConsoleAccountAllowlistEntry[]> {
    return withSystemContext(this.db, tx => listActiveAccountAllowlistEntriesWithTx(tx));
  }

  async findActive(id: string): Promise<ConsoleAccountAllowlistEntry | null> {
    return withSystemContext(this.db, tx => findActiveAccountAllowlistEntryWithTx(tx, id));
  }

  async add(input: AllowlistAddInput): Promise<ConsoleAccountAllowlistEntry> {
    return withSystemContext(this.db, tx => addAccountAllowlistEntryWithTx(tx, input));
  }

  async update(input: AllowlistUpdateInput): Promise<ConsoleAccountAllowlistEntry | null> {
    return withSystemContext(this.db, tx => updateAccountAllowlistEntryWithTx(tx, input));
  }

  async remove(input: AllowlistRemoveInput): Promise<ConsoleAccountAllowlistEntry | null> {
    return withSystemContext(this.db, tx => removeAccountAllowlistEntryWithTx(tx, input));
  }
}

export async function listActiveAccountAllowlistEntriesWithTx(
  tx: DrizzleTx,
): Promise<ConsoleAccountAllowlistEntry[]> {
  const rows = await tx.select().from(accountAllowlistEntries)
    .where(isNull(accountAllowlistEntries.revokedAt))
    .orderBy(asc(accountAllowlistEntries.createdAt));
  return rows.map(fromAllowlistRow);
}

export async function findActiveAccountAllowlistEntryWithTx(
  tx: DrizzleTx,
  id: string,
): Promise<ConsoleAccountAllowlistEntry | null> {
  const rows = await tx.select().from(accountAllowlistEntries)
    .where(and(eq(accountAllowlistEntries.id, id), isNull(accountAllowlistEntries.revokedAt)))
    .limit(1);
  return rows[0] ? fromAllowlistRow(rows[0]) : null;
}

export async function addAccountAllowlistEntryWithTx(
  tx: DrizzleTx,
  input: AllowlistAddInput,
): Promise<ConsoleAccountAllowlistEntry> {
  validateAllowlistAddInput(input);
  try {
    const rows = await tx.insert(accountAllowlistEntries).values({
      kind: input.kind,
      normalizedValue: normalizeAllowlistValue(input.kind, input.value),
      displayValue: input.value.trim(),
      note: input.note ?? null,
      createdByUserId: input.createdByUserId,
      createdAt: input.createdAt,
    }).returning();
    return fromAllowlistRow(rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConsoleStoreConflictError('active allowlist entry already exists');
    }
    throw error;
  }
}

export async function updateAccountAllowlistEntryWithTx(
  tx: DrizzleTx,
  input: AllowlistUpdateInput,
): Promise<ConsoleAccountAllowlistEntry | null> {
  validateAllowlistUpdateInput(input);
  if (input.note === undefined) return findActiveAccountAllowlistEntryWithTx(tx, input.id);
  const rows = await tx.update(accountAllowlistEntries)
    .set({ note: input.note })
    .where(and(eq(accountAllowlistEntries.id, input.id), isNull(accountAllowlistEntries.revokedAt)))
    .returning();
  return rows[0] ? fromAllowlistRow(rows[0]) : null;
}

export async function removeAccountAllowlistEntryWithTx(
  tx: DrizzleTx,
  input: AllowlistRemoveInput,
): Promise<ConsoleAccountAllowlistEntry | null> {
  validateAllowlistRemoveInput(input);
  const rows = await tx.update(accountAllowlistEntries)
    .set({
      revokedByUserId: input.revokedByUserId,
      revokedAt: input.revokedAt,
    })
    .where(and(eq(accountAllowlistEntries.id, input.id), isNull(accountAllowlistEntries.revokedAt)))
    .returning();
  return rows[0] ? fromAllowlistRow(rows[0]) : null;
}

function fromAllowlistRow(row: typeof accountAllowlistEntries.$inferSelect): ConsoleAccountAllowlistEntry {
  return {
    id: row.id,
    kind: row.kind,
    normalizedValue: row.normalizedValue,
    displayValue: row.displayValue,
    note: row.note,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    revokedByUserId: row.revokedByUserId,
    revokedAt: row.revokedAt,
  };
}
