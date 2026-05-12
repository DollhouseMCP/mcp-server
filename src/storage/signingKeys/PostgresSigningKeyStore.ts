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
    if (rows.length === 0) return null;
    return rowToKey(rows[0] as AuthSigningKeyRow);
  }

  async getByKid(kid: string): Promise<SigningKey | null> {
    const rows = await withSystemContext(this.db, (tx) =>
      tx.select().from(authSigningKeys).where(eq(authSigningKeys.kid, kid)).limit(1),
    );
    if (rows.length === 0) return null;
    return rowToKey(rows[0] as AuthSigningKeyRow);
  }

  async listByKind(kind: SigningKeyKind): Promise<SigningKey[]> {
    const rows = await withSystemContext(this.db, (tx) =>
      tx
        .select()
        .from(authSigningKeys)
        .where(eq(authSigningKeys.kind, kind))
        .orderBy(desc(authSigningKeys.createdAt)),
    );
    return rows.map((r) => rowToKey(r as AuthSigningKeyRow));
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

      return rowToKey(inserted[0] as AuthSigningKeyRow);
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
}

function rowToKey(row: AuthSigningKeyRow): SigningKey {
  return {
    kid: row.kid,
    kind: row.kind as SigningKeyKind,
    payload: coerceObject(row.payload),
    active: row.active,
    createdAt: row.createdAt.getTime(),
    rotatedAt: row.rotatedAt ? row.rotatedAt.getTime() : undefined,
  };
}

function coerceObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
