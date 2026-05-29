/**
 * PostgresSigningKeyStore
 *
 * Database-backed `ISigningKeyStore` using Drizzle against the
 * `auth_signing_keys` table (migration 0015). Operations run inside
 * `withSystemContext` — signing keys are AS-internal, paired with
 * `auth_kv` (also no RLS).
 *
 * Atomicity:
 *   - `rotate()` runs UPDATE-then-INSERT inside a single transaction.
 *     The partial unique index `(kind) WHERE active = TRUE` enforces
 *     the "at most one active per kind" invariant even if two writers
 *     race; the second one's INSERT fails with a constraint violation.
 *
 * @module storage/signingKeys/PostgresSigningKeyStore
 */

import { and, eq, lt, desc } from 'drizzle-orm';

import type { DatabaseInstance } from '../../database/connection.js';
import { withSystemContext } from '../../database/admin.js';
import { authSigningKeys } from '../../database/schema/index.js';
import type {
  ISigningKeyStore,
  SigningKey,
  SigningKeyKind,
  SigningKeyWrite,
} from './ISigningKeyStore.js';

export interface PostgresSigningKeyStoreOptions {
  db: DatabaseInstance;
}

interface AuthSigningKeyRow {
  kid: string;
  kind: string;
  payload: unknown;
  active: boolean;
  createdAt: Date;
  rotatedAt: Date | null;
  retiredAt: Date | null;
}

export class PostgresSigningKeyStore implements ISigningKeyStore {
  private readonly db: DatabaseInstance;

  constructor(options: PostgresSigningKeyStoreOptions) {
    this.db = options.db;
  }

  async getActive(kind: SigningKeyKind): Promise<SigningKey | null> {
    const rows = await withSystemContext(this.db, (tx) =>
      tx
        .select()
        .from(authSigningKeys)
        .where(and(eq(authSigningKeys.kind, kind), eq(authSigningKeys.active, true)))
        .limit(1),
    );
    const row = rows.at(0);
    return row ? rowToKey(row) : null;
  }

  async getByKid(kid: string): Promise<SigningKey | null> {
    const rows = await withSystemContext(this.db, (tx) =>
      tx.select().from(authSigningKeys).where(eq(authSigningKeys.kid, kid)).limit(1),
    );
    const row = rows.at(0);
    return row ? rowToKey(row) : null;
  }

  async listByKind(kind: SigningKeyKind): Promise<SigningKey[]> {
    const rows = await withSystemContext(this.db, (tx) =>
      tx
        .select()
        .from(authSigningKeys)
        .where(eq(authSigningKeys.kind, kind))
        .orderBy(desc(authSigningKeys.createdAt)),
    );
    return rows.map(rowToKey);
  }

  async rotate(write: SigningKeyWrite): Promise<SigningKey> {
    const now = new Date();
    return withSystemContext(this.db, async (tx) => {
      // Mark any existing active row of this kind as inactive.
      await tx
        .update(authSigningKeys)
        .set({ active: false, rotatedAt: now })
        .where(and(eq(authSigningKeys.kind, write.kind), eq(authSigningKeys.active, true)));

      // Insert the new active row. The partial unique index on
      // (kind) WHERE active=TRUE catches races: if another transaction
      // beat us, the INSERT fails and the caller sees a constraint
      // violation rather than two active rows.
      const inserted = await tx
        .insert(authSigningKeys)
        .values({
          kid: write.kid,
          kind: write.kind,
          payload: write.payload,
          active: true,
          createdAt: now,
        })
        .returning();

      return rowToKey(inserted[0]);
    });
  }

  async pruneRotatedBefore(beforeEpochMs: number): Promise<number> {
    const result = await withSystemContext(this.db, (tx) =>
      tx
        .delete(authSigningKeys)
        .where(
          and(
            eq(authSigningKeys.active, false),
            lt(authSigningKeys.rotatedAt, new Date(beforeEpochMs)),
          ),
        )
        .returning({ kid: authSigningKeys.kid }),
    );
    return result.length;
  }

  async retire(kid: string, retiredAt: number = Date.now()): Promise<SigningKey | null> {
    const retiredDate = new Date(retiredAt);
    const rows = await withSystemContext(this.db, (tx) =>
      tx
        .update(authSigningKeys)
        .set({ active: false, rotatedAt: retiredDate, retiredAt: retiredDate })
        .where(eq(authSigningKeys.kid, kid))
        .returning(),
    );
    const row = rows.at(0);
    return row ? rowToKey(row) : null;
  }

  async delete(kid: string, options: { readonly force?: boolean } = {}): Promise<boolean> {
    return withSystemContext(this.db, async (tx) => {
      const rows = await tx.select().from(authSigningKeys).where(eq(authSigningKeys.kid, kid)).limit(1);
      const row = rows.at(0);
      if (!row) return false;
      if (!options.force && (row.active || !row.retiredAt)) return false;
      const deleted = await tx.delete(authSigningKeys).where(eq(authSigningKeys.kid, kid)).returning({ kid: authSigningKeys.kid });
      return deleted.length > 0;
    });
  }
}

function rowToKey(row: AuthSigningKeyRow): SigningKey {
  return {
    kid: row.kid,
    kind: row.kind as SigningKeyKind,
    payload: coerceObject(row.payload),
    active: row.active,
    createdAt: row.createdAt.getTime(),
    rotatedAt: row.rotatedAt ? row.rotatedAt.getTime() : undefined,
    retiredAt: row.retiredAt ? row.retiredAt.getTime() : undefined,
  };
}

function coerceObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
