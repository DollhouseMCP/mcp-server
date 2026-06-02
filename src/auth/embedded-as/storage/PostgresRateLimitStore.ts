import { sql } from 'drizzle-orm';

import type { DatabaseInstance } from '../../../database/connection.js';
import { withSystemContext } from '../../../database/admin.js';
import type {
  IRateLimitStore,
  RateLimitEntry,
  RateLimitUpdate,
  RateLimitUpdateOptions,
} from './IRateLimitStore.js';

/**
 * Shape of a row returned by the rate-limit-state SELECT statements.
 * Declared with `Record<string, unknown>` as the base + optional known
 * keys so it's structurally assignable from Drizzle's untyped raw-SQL
 * return shape (`RowList<Record<string, unknown>[]>`). The narrow
 * `as RateLimitRow[]` cast at the call site is enough — no double cast
 * through `unknown` needed, which keeps the static-analyzer quiet.
 */
type RateLimitRow = Record<string, unknown> & { state?: unknown; version?: unknown };

const DEFAULT_MAX_RETRIES = 5;

export class PostgresRateLimitStore implements IRateLimitStore {
  constructor(private readonly db: DatabaseInstance) {}

  async get<TState>(scope: string, key: string): Promise<RateLimitEntry<TState> | null> {
    // Drizzle's raw-SQL return type is RowList<Record<string, unknown>[]>,
    // which is structurally assignable to RateLimitRow[] because the row
    // type itself extends Record<string, unknown>. No cast needed.
    const rows: RateLimitRow[] = await withSystemContext(this.db, (tx) =>
      tx.execute(sql`
        SELECT state, version
        FROM rate_limit_state
        WHERE scope = ${scope} AND key = ${key}
        LIMIT 1
      `),
    );
    const row = rows.at(0);
    return row ? { state: row.state as TState, version: Number(row.version) } : null;
  }

  async update<TState, TResult = void>(
    scope: string,
    key: string,
    compute: (prev: TState | null) => RateLimitUpdate<TState, TResult>,
    options: RateLimitUpdateOptions = {},
  ): Promise<RateLimitUpdate<TState, TResult>> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const written = await withSystemContext(this.db, async (tx) => {
        const rows = await tx.execute(sql`
          SELECT state, version
          FROM rate_limit_state
          WHERE scope = ${scope} AND key = ${key}
          LIMIT 1
        `) as RateLimitRow[];
        const current = rows.at(0);
        const next = compute((current?.state ?? null) as TState | null);
        // Raw `tx.execute(sql`...`)` over postgres-js does not serialize a JS
        // Date param — the expires_at writes below pass an ISO string cast to
        // timestamptz instead.
        const expiresAt = options.expiresAt === undefined ? null : new Date(options.expiresAt);

        if (next.state === null) {
          if (!current) return next;
          const deleted = await tx.execute(sql`
            DELETE FROM rate_limit_state
            WHERE scope = ${scope} AND key = ${key} AND version = ${current.version}
            RETURNING version
          `) as unknown[];
          return deleted.length > 0 ? next : null;
        }

        if (!current) {
          // ON CONFLICT DO NOTHING suppresses both the insert AND the
          // RETURNING row when a concurrent writer beat us to this key.
          // The success signal is `inserted.length > 0`, NOT the value
          // of `RETURNING version`. When we hit a conflict, inserted is
          // empty and we return null so the outer CAS loop retries with
          // the now-committed state. Do not "fix" this to
          // `DO UPDATE SET version = version RETURNING version` —
          // that would break the CAS contract by silently overwriting
          // the winner's compute() result with ours.
          const inserted = await tx.execute(sql`
            INSERT INTO rate_limit_state (scope, key, state, expires_at)
            VALUES (${scope}, ${key}, ${JSON.stringify(next.state)}::jsonb, ${expiresAt ? expiresAt.toISOString() : null}::timestamptz)
            ON CONFLICT (scope, key) DO NOTHING
            RETURNING version
          `) as unknown[];
          return inserted.length > 0 ? next : null;
        }

        const updated = await tx.execute(sql`
          UPDATE rate_limit_state
          SET state = ${JSON.stringify(next.state)}::jsonb,
              version = version + 1,
              expires_at = ${expiresAt ? expiresAt.toISOString() : null}::timestamptz,
              updated_at = NOW()
          WHERE scope = ${scope} AND key = ${key} AND version = ${current.version}
          RETURNING version
        `) as unknown[];
        return updated.length > 0 ? next : null;
      });
      if (written) return written;
    }

    throw new Error(`Rate limit CAS failed after ${maxRetries} attempts for scope=${scope}`);
  }

  async reset(scope: string, key: string): Promise<void> {
    await withSystemContext(this.db, (tx) =>
      tx.execute(sql`
        DELETE FROM rate_limit_state
        WHERE scope = ${scope} AND key = ${key}
      `),
    );
  }

  async sweep(): Promise<void> {
    await withSystemContext(this.db, (tx) =>
      tx.execute(sql`
        DELETE FROM rate_limit_state
        WHERE expires_at IS NOT NULL AND expires_at < NOW()
      `),
    );
  }
}
