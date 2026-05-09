/**
 * PostgresAuthStorageLayer
 *
 * Database-backed implementation of IAuthStorageLayer using Drizzle
 * against the Phase 4 PostgreSQL infrastructure. Tables defined in
 * src/database/schema/auth.ts (migration 0009).
 *
 * **Identity model (Option C):**
 *   - The Phase 4 `users` table stays the canonical user record.
 *   - `auth_accounts(provider, external_sub, sub, user_id)` is the
 *     OAuth identity mapping. `user_id` is an optional FK to `users.id`;
 *     null when the OAuth identity exists without a Phase 4 user record.
 *   - This layer never reads or writes the `users` table directly —
 *     creating a Phase 4 user is a higher-level concern (Phase 4 path).
 *
 * **RLS:** auth tables are AS-internal infrastructure, not per-user
 * tenant data. All operations run inside `withSystemContext(db, ...)`,
 * which clears the user context for the transaction. The auth tables
 * intentionally do not enable row-level security.
 *
 * **Index strategy:** `auth_kv` has two partial expression indexes
 * (`Session.uid` and `Grant.accountId`) so `genericFindByUid` and
 * `findGrantsByAccountId` are O(log n) instead of the in-memory backend's
 * linear scan. See migration 0009 for index definitions.
 *
 * @module auth/embedded-as/storage/PostgresAuthStorageLayer
 */

import { and, eq, gte, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../database/connection.js';
import { withSystemContext } from '../../../database/admin.js';
import {
  authAccounts,
  authIdentityEvents,
  authKv,
} from '../../../database/schema/auth.js';
import type {
  BootstrapState,
  IAuthStorageLayer,
  IdentityAuditEvent,
  IdentityEventFilter,
  StoredAccount,
} from './IAuthStorageLayer.js';
import { DEFAULT_IDENTITY_EVENTS_LIMIT } from './IAuthStorageLayer.js';

export interface PostgresAuthStorageLayerOptions {
  /** Drizzle DB instance. Pass the same instance the rest of the app uses. */
  db: DatabaseInstance;
}

interface AuthAccountRow {
  provider: string;
  externalSub: string;
  sub: string;
  userId: string | null;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  rawProfile: unknown;
  passwordHash: string | null;
  lastAuthAt: number | null;
  /** Round 5 / B1: roles claim source for extraTokenClaims. */
  roles: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface IdentityEventRow {
  id: string;
  type: string;
  sub: string | null;
  provider: string | null;
  externalSub: string | null;
  details: unknown;
  timestamp: number;
  createdAt: Date;
}

interface AuthKvRow {
  model: string;
  id: string;
  payload: unknown;
  expiresAt: Date | null;
  createdAt: Date;
}

export class PostgresAuthStorageLayer implements IAuthStorageLayer {
  private readonly db: DatabaseInstance;

  constructor(options: PostgresAuthStorageLayerOptions) {
    this.db = options.db;
  }

  // ---- Accounts (must-fix #18) ----

  async findAccountByExternalId(provider: string, externalSub: string): Promise<StoredAccount | null> {
    const rows = await withSystemContext(this.db, (tx) =>
      tx.select().from(authAccounts)
        .where(and(eq(authAccounts.provider, provider), eq(authAccounts.externalSub, externalSub)))
        .limit(1),
    );
    return rows.length > 0 ? rowToStoredAccount(rows[0] as AuthAccountRow) : null;
  }

  async upsertAccount(account: StoredAccount): Promise<void> {
    const row = storedAccountToRow(account);
    await withSystemContext(this.db, async (tx) => {
      await tx.insert(authAccounts).values(row).onConflictDoUpdate({
        target: [authAccounts.provider, authAccounts.externalSub],
        set: {
          sub: row.sub,
          userId: row.userId,
          email: row.email,
          emailVerified: row.emailVerified,
          displayName: row.displayName,
          rawProfile: row.rawProfile,
          passwordHash: row.passwordHash,
          lastAuthAt: row.lastAuthAt,
          // Round 5 / B1: include roles in the conflict-update set or
          // existing rows would keep their stale roles when an
          // upsertAccount with new roles is issued.
          roles: row.roles,
          updatedAt: row.updatedAt,
        },
      });
    });
  }

  async getAccount(sub: string): Promise<StoredAccount | null> {
    const rows = await withSystemContext(this.db, (tx) =>
      tx.select().from(authAccounts).where(eq(authAccounts.sub, sub)).limit(1),
    );
    return rows.length > 0 ? rowToStoredAccount(rows[0] as AuthAccountRow) : null;
  }

  async updateAccountLastAuth(sub: string, lastAuthAt: number): Promise<boolean> {
    // Single-statement UPDATE under row-level locking by Postgres; can't
    // race against concurrent upserts the way a get-then-upsert would.
    const result = await withSystemContext(this.db, (tx) =>
      tx
        .update(authAccounts)
        .set({ lastAuthAt, updatedAt: new Date(lastAuthAt) })
        .where(eq(authAccounts.sub, sub))
        .returning({ sub: authAccounts.sub }),
    );
    return result.length > 0;
  }

  async setAccountRoles(sub: string, roles: string[]): Promise<boolean> {
    // Single-statement UPDATE: same atomicity story as
    // updateAccountLastAuth — Postgres serialises against concurrent
    // upsertAccount on the same row. The roles column has a NOT NULL
    // default of '[]'::jsonb (migration 0010), so we always write a
    // concrete array; mapper-level "empty array → undefined" stays in
    // rowToStoredAccount.
    const result = await withSystemContext(this.db, (tx) =>
      tx
        .update(authAccounts)
        .set({ roles: [...roles], updatedAt: new Date() })
        .where(eq(authAccounts.sub, sub))
        .returning({ sub: authAccounts.sub }),
    );
    return result.length > 0;
  }

  // ---- Bootstrap state (must-fix #22) ----
  //
  // Stored as a single row in auth_kv with model='AuthBootstrap', id='state'.
  // Reuses the existing K/V plane rather than introducing a new table for
  // a single-row resource — schema churn cost > new-table benefit here.

  async getBootstrapState(): Promise<BootstrapState> {
    const payload = await this.genericGet('AuthBootstrap', 'state') as
      BootstrapState | null;
    if (!payload || typeof payload.completed !== 'boolean') {
      return { completed: false };
    }
    return payload;
  }

  async markBootstrapComplete(
    adminSub: string,
    adminMethod: 'local-password' | 'magic-link' | 'github',
  ): Promise<void> {
    // Round 5 / B2: single atomic UPSERT with a conflict-resolution
    // WHERE clause. Earlier shape did read-then-write across separate
    // withSystemContext calls (each opens its own transaction), so two
    // concurrent CLI runs could both observe completed:false and both
    // write — last-writer-wins for the bootstrap admin claim.
    //
    // The Drizzle `.onConflictDoUpdate({ where })` expression filters
    // the conflict path at the SQL level: when adminSub matches the
    // existing row, the UPDATE fires (idempotent re-run). When it
    // differs, the WHERE blocks the UPDATE and Postgres returns zero
    // rows from RETURNING — we read existing state for the error
    // message, but the rejection is already atomic at the DB level.
    const payload = {
      completed: true,
      adminSub,
      adminMethod,
      completedAt: Date.now(),
    };
    const rows = await withSystemContext(this.db, (tx) =>
      tx.insert(authKv)
        .values({
          model: 'AuthBootstrap',
          id: 'state',
          payload: payload as AuthKvRow['payload'],
          expiresAt: null,
        })
        .onConflictDoUpdate({
          target: [authKv.model, authKv.id],
          set: { payload: payload as AuthKvRow['payload'] },
          where: sql`auth_kv.payload->>'adminSub' = ${adminSub}`,
        })
        .returning({ id: authKv.id }),
    );
    if (rows.length === 0) {
      // The conflict-resolution WHERE filtered out our UPDATE — there's
      // an existing row with a DIFFERENT adminSub. Read it back for the
      // error message; the transfer was already rejected atomically by
      // the SQL above.
      const existing = await this.getBootstrapState();
      throw new Error(
        `bootstrap already completed for admin '${existing.adminSub}'; ` +
        `re-running with a different admin '${adminSub}' is rejected (admin transfer is a separate operation)`,
      );
    }
  }

  // ---- Audit (must-fix #21) ----

  async recordIdentityEvent(event: IdentityAuditEvent): Promise<void> {
    await withSystemContext(this.db, async (tx) => {
      await tx.insert(authIdentityEvents).values({
        type: event.type,
        sub: event.sub ?? null,
        provider: event.provider ?? null,
        externalSub: event.externalSub ?? null,
        details: (event.details ?? null) as IdentityEventRow['details'],
        timestamp: event.timestamp,
      });
    });
  }

  async listIdentityEvents(filter?: IdentityEventFilter): Promise<IdentityAuditEvent[]> {
    const clauses: SQL[] = [];
    if (filter?.type) clauses.push(eq(authIdentityEvents.type, filter.type));
    if (filter?.sub) clauses.push(eq(authIdentityEvents.sub, filter.sub));
    if (filter?.since !== undefined) clauses.push(gte(authIdentityEvents.timestamp, filter.since));

    // Cycle-12 fix: cap the result set at the SQL layer so a long-
    // running deployment's audit log doesn't pull millions of rows
    // into Node memory on a single admin call.
    const limit = filter?.limit ?? DEFAULT_IDENTITY_EVENTS_LIMIT;

    const rows = await withSystemContext(this.db, (tx) => {
      const baseSelect = tx.select().from(authIdentityEvents);
      const filtered = clauses.length > 0 ? baseSelect.where(and(...clauses)) : baseSelect;
      const ordered = filtered.orderBy(authIdentityEvents.timestamp);
      return limit > 0 ? ordered.limit(limit) : ordered;
    });

    return (rows as IdentityEventRow[]).map(rowToIdentityEvent);
  }

  // ---- Grants (Phase 5 H14) ----

  async findGrantsByAccountId(sub: string): Promise<string[]> {
    // Uses idx_auth_kv_grant_account partial expression index.
    const rows = await withSystemContext(this.db, (tx) =>
      tx.select({ id: authKv.id }).from(authKv).where(
        and(
          eq(authKv.model, 'Grant'),
          sql`${authKv.payload}->>'accountId' = ${sub}`,
          notExpired(),
        ),
      ),
    );
    return rows.map((r) => r.id);
  }

  // ---- Generic K/V (oidc-provider adapter sink) ----

  async genericGet(model: string, id: string): Promise<unknown | null> {
    const rows = await withSystemContext(this.db, (tx) =>
      tx.select({ payload: authKv.payload, expiresAt: authKv.expiresAt })
        .from(authKv)
        .where(and(eq(authKv.model, model), eq(authKv.id, id)))
        .limit(1),
    );
    if (rows.length === 0) return null;
    const row = rows[0]!;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      // Lazy expiry; best-effort cleanup.
      void this.genericDestroy(model, id);
      return null;
    }
    return row.payload;
  }

  async genericSet(model: string, id: string, payload: unknown, expiresInSec?: number): Promise<void> {
    const expiresAt = expiresInSec ? new Date(Date.now() + expiresInSec * 1000) : null;
    await withSystemContext(this.db, async (tx) => {
      await tx.insert(authKv).values({
        model,
        id,
        payload: payload as AuthKvRow['payload'],
        expiresAt,
      }).onConflictDoUpdate({
        target: [authKv.model, authKv.id],
        set: { payload: payload as AuthKvRow['payload'], expiresAt },
      });
    });
  }

  async genericInsertIfAbsent(
    model: string,
    id: string,
    payload: unknown,
    expiresInSec?: number,
  ): Promise<boolean> {
    const expiresAt = expiresInSec ? new Date(Date.now() + expiresInSec * 1000) : null;
    // Cycle-15 fix: align with InMemory/Filesystem semantics where an
    // expired row is treated as absent — INSERT ... ON CONFLICT DO
    // UPDATE ... WHERE auth_kv.expires_at < NOW() lets a new insert
    // succeed when the existing row has aged out. Without this, the
    // Postgres backend was strictly more restrictive than the other
    // two: a TTL'd row blocked re-insert forever, while InMemory/FS
    // would have allowed it after expiry. The storage-parity rule
    // caught the drift in cycle 15.
    //
    // Atomicity: still single-statement. Two concurrent inserts of
    // the same id with no live row both attempt the UPSERT; Postgres
    // serializes at the row level and exactly one .returning() row
    // is emitted (the winner). Concurrent inserts where a live row
    // exists both hit the conflict path with the WHERE clause
    // rejecting both — `returning` is empty and both correctly
    // return false.
    const rows = await withSystemContext(this.db, (tx) =>
      tx.insert(authKv)
        .values({
          model,
          id,
          payload: payload as AuthKvRow['payload'],
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [authKv.model, authKv.id],
          set: {
            payload: payload as AuthKvRow['payload'],
            expiresAt,
          },
          // Only overwrite when the existing row has expired. Live
          // rows stay untouched.
          where: sql`${authKv.expiresAt} IS NOT NULL AND ${authKv.expiresAt} < NOW()`,
        })
        .returning({ id: authKv.id }),
    );
    return rows.length > 0;
  }

  async genericConsume(model: string, id: string): Promise<boolean> {
    // Single-statement CAS: jsonb_set the `consumed` field only when the
    // row exists, isn't expired, and isn't already consumed. RETURNING
    // tells us whether a row was actually marked. Two concurrent
    // consume() calls cannot both report true because Postgres
    // serializes the row update at the page level — one wins, the
    // other's WHERE clause now sees consumed != null and matches no
    // rows.
    const rows = await withSystemContext(this.db, (tx) =>
      tx.execute<{ id: string }>(sql`
        UPDATE auth_kv
           SET payload = jsonb_set(
             payload,
             '{consumed}',
             to_jsonb((EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
           )
         WHERE model = ${model}
           AND id = ${id}
           AND (expires_at IS NULL OR expires_at > NOW())
           AND NOT (payload ? 'consumed')
        RETURNING id
      `),
    );
    return rows.length > 0;
  }

  async genericDestroy(model: string, id: string): Promise<void> {
    await withSystemContext(this.db, async (tx) => {
      await tx.delete(authKv).where(and(eq(authKv.model, model), eq(authKv.id, id)));
    });
  }

  async clearGenericByModels(models: readonly string[]): Promise<number> {
    if (models.length === 0) return 0;
    const result = await withSystemContext(this.db, (tx) =>
      tx.delete(authKv).where(inArray(authKv.model, [...models])).returning({ id: authKv.id }),
    );
    return result.length;
  }

  async genericRevokeByGrantId(grantId: string): Promise<void> {
    // Delete both the Grant row itself (model='Grant', id=grantId) and
    // every entry whose payload.grantId references it (tokens, sessions,
    // codes). Single statement via OR.
    await withSystemContext(this.db, async (tx) => {
      await tx.delete(authKv).where(or(
        and(eq(authKv.model, 'Grant'), eq(authKv.id, grantId)),
        sql`${authKv.payload}->>'grantId' = ${grantId}`,
      )!);
    });
  }

  /** Uses idx_auth_kv_session_uid partial expression index. */
  async genericFindByUid(uid: string): Promise<unknown | null> {
    const rows = await withSystemContext(this.db, (tx) =>
      tx.select({ payload: authKv.payload }).from(authKv).where(
        and(
          eq(authKv.model, 'Session'),
          sql`${authKv.payload}->>'uid' = ${uid}`,
          notExpired(),
        ),
      ).limit(1),
    );
    return rows.length > 0 ? rows[0]!.payload : null;
  }
}

function notExpired(): SQL {
  return or(
    sql`${authKv.expiresAt} IS NULL`,
    sql`${authKv.expiresAt} > NOW()`,
  )!;
}

function storedAccountToRow(account: StoredAccount): typeof authAccounts.$inferInsert {
  return {
    provider: account.provider,
    externalSub: account.externalSub,
    sub: account.sub,
    userId: null, // §8.1 doesn't auto-link to users.id; future work
    email: account.email ?? null,
    emailVerified: account.emailVerified,
    displayName: account.displayName ?? null,
    rawProfile: (account.rawProfile ?? null) as typeof authAccounts.$inferInsert['rawProfile'],
    passwordHash: account.credentials?.passwordHash ?? null,
    lastAuthAt: account.lastAuthAt ?? null,
    // Round 5 / B1: roles must round-trip through Postgres. Empty array
    // is the column default + the canonical "no roles" sentinel.
    roles: account.roles ?? [],
    createdAt: new Date(account.createdAt),
    updatedAt: new Date(account.updatedAt),
  };
}

function rowToStoredAccount(row: AuthAccountRow): StoredAccount {
  const account: StoredAccount = {
    sub: row.sub,
    provider: row.provider,
    externalSub: row.externalSub,
    emailVerified: row.emailVerified,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
  if (row.email !== null) account.email = row.email;
  if (row.displayName !== null) account.displayName = row.displayName;
  if (row.rawProfile !== null) account.rawProfile = row.rawProfile as Record<string, unknown>;
  if (row.passwordHash !== null) account.credentials = { passwordHash: row.passwordHash };
  if (row.lastAuthAt !== null) account.lastAuthAt = row.lastAuthAt;
  // Round 5 / B1: emit roles only when non-empty so callers checking
  // `account.roles?.length` get the same shape they would from the
  // in-memory and filesystem backends (which preserve undefined when
  // the field was never set).
  if (Array.isArray(row.roles) && row.roles.length > 0) {
    account.roles = row.roles as string[];
  }
  return account;
}

function rowToIdentityEvent(row: IdentityEventRow): IdentityAuditEvent {
  const event: IdentityAuditEvent = {
    type: row.type,
    timestamp: row.timestamp,
  };
  if (row.sub !== null) event.sub = row.sub;
  if (row.provider !== null) event.provider = row.provider;
  if (row.externalSub !== null) event.externalSub = row.externalSub;
  if (row.details !== null) event.details = row.details as Record<string, unknown>;
  return event;
}

