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

import { and, eq, inArray, lt, desc, sql } from 'drizzle-orm';

import type { DatabaseInstance } from '../../database/connection.js';
import type { DrizzleTx } from '../../database/db-utils.js';
import { withSystemContext } from '../../database/admin.js';
import { authSigningKeys } from '../../database/schema/index.js';
import type {
  ISigningKeyStore,
  SigningKey,
  SigningKeyKind,
  SigningKeyModeTransition,
  SigningKeyModeTransitionResult,
  SigningKeyWrite,
} from './ISigningKeyStore.js';
import {
  inheritAuthorizationGeneration,
  SigningKeyLifecycleConflictError,
  stageSigningKeyModeTransition,
} from './signingKeyLifecycle.js';
import {
  createDefaultSigningKeyPayloadEncryption,
  type SigningKeyPayloadEncryption,
} from './signingKeyPayloadEncryption.js';

export interface PostgresSigningKeyStoreOptions {
  db: DatabaseInstance;
  payloadEncryption?: SigningKeyPayloadEncryption;
}

export interface PostgresSigningKeyTransactionAdapter {
  getByKid(tx: DrizzleTx, kid: string): Promise<SigningKey | null>;
  rotate(tx: DrizzleTx, write: SigningKeyWrite): Promise<SigningKey>;
  retire(tx: DrizzleTx, kid: string, retiredAt?: number): Promise<SigningKey | null>;
  delete(tx: DrizzleTx, kid: string, options?: { readonly force?: boolean }): Promise<boolean>;
}

export interface PostgresSigningKeyTransactionProvider {
  createPostgresTransactionAdapter(database: DatabaseInstance): PostgresSigningKeyTransactionAdapter;
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

export class PostgresSigningKeyStore implements ISigningKeyStore, PostgresSigningKeyTransactionProvider {
  private readonly db: DatabaseInstance;
  private readonly payloadEncryption: SigningKeyPayloadEncryption;

  constructor(options: PostgresSigningKeyStoreOptions) {
    this.db = options.db;
    this.payloadEncryption = options.payloadEncryption ?? createDefaultSigningKeyPayloadEncryption();
  }

  createPostgresTransactionAdapter(database: DatabaseInstance): PostgresSigningKeyTransactionAdapter {
    if (database !== this.db) {
      throw new Error('PostgreSQL signing-key transaction adapter requires the store database');
    }
    const payloadEncryption = this.payloadEncryption;
    const adapter: PostgresSigningKeyTransactionAdapter = {
      getByKid: (tx, kid) => getSigningKeyByKidWithTx(tx, kid, payloadEncryption),
      rotate: (tx, write) => rotateSigningKeyWithTx(tx, write, payloadEncryption),
      retire: (tx, kid, retiredAt) => retireSigningKeyWithTx(tx, kid, retiredAt, payloadEncryption),
      delete: (tx, kid, options) => deleteSigningKeyWithTx(tx, kid, options),
    };
    return Object.freeze(adapter);
  }

  async getActive(kind: SigningKeyKind): Promise<SigningKey | null> {
    return withSystemContext(this.db, async tx => {
      await lockSigningKeyReadsWithTx(tx);
      const rows = await tx
        .select()
        .from(authSigningKeys)
        .where(and(eq(authSigningKeys.kind, kind), eq(authSigningKeys.active, true)))
        .limit(1);
      const row = rows.at(0);
      return row ? rowToKeyWithTx(tx, row, this.payloadEncryption) : null;
    });
  }

  async getByKid(kid: string): Promise<SigningKey | null> {
    return withSystemContext(this.db, async tx => {
      await lockSigningKeyReadsWithTx(tx);
      const rows = await tx.select().from(authSigningKeys)
        .where(eq(authSigningKeys.kid, kid)).limit(1);
      const row = rows.at(0);
      return row ? rowToKeyWithTx(tx, row, this.payloadEncryption) : null;
    });
  }

  async listByKind(kind: SigningKeyKind): Promise<SigningKey[]> {
    return withSystemContext(this.db, async tx => {
      await lockSigningKeyReadsWithTx(tx);
      const rows = await tx
        .select()
        .from(authSigningKeys)
        .where(eq(authSigningKeys.kind, kind))
        .orderBy(desc(authSigningKeys.createdAt));
      return Promise.all(rows.map(row => rowToKeyWithTx(tx, row, this.payloadEncryption)));
    });
  }

  async withActiveKey<T>(kind: SigningKeyKind, operation: (key: SigningKey) => Promise<T>): Promise<T> {
    return withSystemContext(this.db, async tx => {
      await lockSigningKeyReadsWithTx(tx);
      const rows = await tx.select().from(authSigningKeys).where(and(
        eq(authSigningKeys.kind, kind),
        eq(authSigningKeys.active, true),
      )).limit(1);
      const row = rows.at(0);
      if (!row || row.retiredAt) throw new Error(`No active '${kind}' signing key is available`);
      return operation(await rowToKeyWithTx(tx, row, this.payloadEncryption));
    });
  }

  /**
   * Explicit maintenance operation for plaintext migration or master-key
   * rotation. It is intentionally never called by ordinary reads: operators
   * first roll decrypt capability to every replica, then opt into one
   * exclusive rewrap after the fleet uses the new active key.
   */
  async rewrapPayloadsUnderExclusiveLock(): Promise<number> {
    return withSystemContext(this.db, async tx => {
      await lockSigningKeyMutationsWithTx(tx);
      const rows = await tx.select().from(authSigningKeys).for('update');
      let rewrapped = 0;
      for (const row of rows) {
        const kind = row.kind as SigningKeyKind;
        const decoded = this.payloadEncryption.decrypt(row.payload, kind, row.kid);
        if (!decoded.legacyPlaintext && !decoded.rewrapRequired) continue;
        await tx.update(authSigningKeys)
          .set({ payload: this.payloadEncryption.encrypt(decoded.payload, kind, row.kid) })
          .where(eq(authSigningKeys.kid, row.kid));
        rewrapped += 1;
      }
      return rewrapped;
    });
  }

  async rotate(write: SigningKeyWrite): Promise<SigningKey> {
    return withSystemContext(this.db, tx => rotateSigningKeyWithTx(tx, write, this.payloadEncryption));
  }

  async assertActiveKey(
    kid: string,
    kind: SigningKeyKind,
    transactionContext?: unknown,
  ): Promise<SigningKey> {
    if (transactionContext) {
      return assertActiveSigningKeyWithTx(
        transactionContext as DrizzleTx,
        kid,
        kind,
        this.payloadEncryption,
      );
    }
    return withSystemContext(this.db, tx =>
      assertActiveSigningKeyWithTx(tx, kid, kind, this.payloadEncryption));
  }

  async transitionAuthorizationMode(
    transition: SigningKeyModeTransition,
  ): Promise<SigningKeyModeTransitionResult> {
    return withSystemContext(this.db, async tx => {
      await lockSigningKeyMutationsWithTx(tx);
      const rows = await tx.select().from(authSigningKeys).for('update');
      const existing = await Promise.all(rows.map(row => rowToKeyWithTx(tx, row, this.payloadEncryption)));
      const transitionedAt = transition.transitionedAt ?? Date.now();
      const staged = stageSigningKeyModeTransition(existing, transition, transitionedAt);

      if (staged.alreadyApplied) {
        return {
          transitionId: staged.transitionId,
          alreadyApplied: true,
          retired: staged.retired,
          installed: staged.installed,
        };
      }

      const retiredKids = staged.retired.map(key => key.kid);
      if (retiredKids.length > 0) {
        const retiredDate = new Date(transitionedAt);
        await tx.update(authSigningKeys).set({
          active: false,
          rotatedAt: sql`COALESCE(${authSigningKeys.rotatedAt}, ${retiredDate})`,
          retiredAt: sql`COALESCE(${authSigningKeys.retiredAt}, ${retiredDate})`,
        }).where(inArray(authSigningKeys.kid, retiredKids));
      }
      if (staged.installed.length > 0) {
        await tx.insert(authSigningKeys).values(staged.installed.map(write => ({
          kid: write.kid,
          kind: write.kind,
          payload: this.payloadEncryption.encrypt(write.payload, write.kind, write.kid),
          active: true,
          createdAt: new Date(transitionedAt),
        })));
      }
      return {
        transitionId: staged.transitionId,
        alreadyApplied: false,
        retired: staged.retired,
        installed: staged.installed,
      };
    });
  }

  async pruneRotatedBefore(beforeEpochMs: number): Promise<number> {
    const result = await withSystemContext(this.db, async tx => {
      await lockSigningKeyMutationsWithTx(tx);
      return tx
        .delete(authSigningKeys)
        .where(
          and(
            eq(authSigningKeys.active, false),
            lt(authSigningKeys.rotatedAt, new Date(beforeEpochMs)),
          ),
        )
        .returning({ kid: authSigningKeys.kid });
    });
    return result.length;
  }

  async retire(kid: string, retiredAt: number = Date.now()): Promise<SigningKey | null> {
    return withSystemContext(this.db, tx => retireSigningKeyWithTx(tx, kid, retiredAt, this.payloadEncryption));
  }

  async delete(kid: string, options: { readonly force?: boolean } = {}): Promise<boolean> {
    return withSystemContext(this.db, tx => deleteSigningKeyWithTx(tx, kid, options));
  }
}

export async function getSigningKeyByKidWithTx(
  tx: DrizzleTx,
  kid: string,
  payloadEncryption = createDefaultSigningKeyPayloadEncryption(),
): Promise<SigningKey | null> {
  // This read participates in account-admin key mutations and takes a row
  // lock. Acquire the lifecycle lock first so its lock order matches rotate,
  // retire, delete, and mode transition; otherwise get-then-retire can
  // deadlock against a transition that already holds the advisory lock.
  await lockSigningKeyMutationsWithTx(tx);
  const rows = await tx.select().from(authSigningKeys).where(eq(authSigningKeys.kid, kid)).limit(1).for('update');
  const row = rows.at(0);
  return row ? rowToKeyWithTx(tx, row, payloadEncryption) : null;
}

export async function rotateSigningKeyWithTx(
  tx: DrizzleTx,
  write: SigningKeyWrite,
  payloadEncryption = createDefaultSigningKeyPayloadEncryption(),
): Promise<SigningKey> {
  await lockSigningKeyMutationsWithTx(tx);
  const now = new Date();
  const activeRows = await tx.select().from(authSigningKeys)
    .where(and(eq(authSigningKeys.kind, write.kind), eq(authSigningKeys.active, true)))
    .limit(1)
    .for('update');
  const active = activeRows.at(0)
    ? await rowToKeyWithTx(tx, activeRows[0], payloadEncryption)
    : null;
  const effectiveWrite = inheritAuthorizationGeneration(active, write);
  await tx.update(authSigningKeys)
    .set({ active: false, rotatedAt: now })
    .where(and(eq(authSigningKeys.kind, write.kind), eq(authSigningKeys.active, true)));
  const inserted = await tx.insert(authSigningKeys).values({
    kid: effectiveWrite.kid,
    kind: effectiveWrite.kind,
    payload: payloadEncryption.encrypt(effectiveWrite.payload, effectiveWrite.kind, effectiveWrite.kid),
    active: true,
    createdAt: now,
  }).returning();
  return rowToKeyWithTx(tx, inserted[0], payloadEncryption);
}

export async function assertActiveSigningKeyWithTx(
  tx: DrizzleTx,
  kid: string,
  kind: SigningKeyKind,
  payloadEncryption = createDefaultSigningKeyPayloadEncryption(),
): Promise<SigningKey> {
  await lockSigningKeyMutationsWithTx(tx);
  const rows = await tx.select().from(authSigningKeys)
    .where(and(
      eq(authSigningKeys.kid, kid),
      eq(authSigningKeys.kind, kind),
      eq(authSigningKeys.active, true),
    ))
    .limit(1)
    .for('update');
  const row = rows.at(0);
  if (!row || row.retiredAt) {
    throw new SigningKeyLifecycleConflictError(
      `Signing key '${kid}' is no longer the active '${kind}' key`,
    );
  }
  return rowToKeyWithTx(tx, row, payloadEncryption);
}

export async function retireSigningKeyWithTx(
  tx: DrizzleTx,
  kid: string,
  retiredAt: number = Date.now(),
  payloadEncryption = createDefaultSigningKeyPayloadEncryption(),
): Promise<SigningKey | null> {
  await lockSigningKeyMutationsWithTx(tx);
  const retiredDate = new Date(retiredAt);
  const rows = await tx.update(authSigningKeys)
    .set({
      active: false,
      rotatedAt: sql`COALESCE(${authSigningKeys.rotatedAt}, ${retiredDate})`,
      retiredAt: sql`COALESCE(${authSigningKeys.retiredAt}, ${retiredDate})`,
    })
    .where(eq(authSigningKeys.kid, kid))
    .returning();
  const row = rows.at(0);
  return row ? rowToKeyWithTx(tx, row, payloadEncryption) : null;
}

export async function deleteSigningKeyWithTx(
  tx: DrizzleTx,
  kid: string,
  options: { readonly force?: boolean } = {},
): Promise<boolean> {
  await lockSigningKeyMutationsWithTx(tx);
  const rows = await tx.select().from(authSigningKeys).where(eq(authSigningKeys.kid, kid)).limit(1).for('update');
  const row = rows.at(0);
  if (!row || (!options.force && (row.active || !row.retiredAt))) return false;
  const deleted = await tx.delete(authSigningKeys).where(eq(authSigningKeys.kid, kid))
    .returning({ kid: authSigningKeys.kid });
  return deleted.length > 0;
}

const SIGNING_KEY_MUTATION_ADVISORY_LOCK = 1_146_119_827;

async function lockSigningKeyReadsWithTx(tx: DrizzleTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${SIGNING_KEY_MUTATION_ADVISORY_LOCK})`);
}

async function lockSigningKeyMutationsWithTx(tx: DrizzleTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SIGNING_KEY_MUTATION_ADVISORY_LOCK})`);
}

async function rowToKeyWithTx(
  _tx: DrizzleTx,
  row: AuthSigningKeyRow,
  payloadEncryption = createDefaultSigningKeyPayloadEncryption(),
): Promise<SigningKey> {
  const kind = row.kind as SigningKeyKind;
  const decoded = payloadEncryption.decrypt(row.payload, kind, row.kid);
  return {
    kid: row.kid,
    kind,
    payload: decoded.payload,
    active: row.active,
    createdAt: row.createdAt.getTime(),
    rotatedAt: row.rotatedAt ? row.rotatedAt.getTime() : undefined,
    retiredAt: row.retiredAt ? row.retiredAt.getTime() : undefined,
  };
}
