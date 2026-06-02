import postgres, { type Sql } from 'postgres';

import { getConfig } from './config.js';

let sql: Sql | undefined;

/**
 * A shared postgres-js client against the isolated e2e database, connected with
 * elevated (admin) credentials so the harness can seed/forge directly. This is
 * deliberately the same driver the app uses, so seeded rows round-trip exactly.
 */
export function db(): Sql {
  if (!sql) {
    sql = postgres(getConfig().databaseAdminUrl, { ssl: false, max: 4, onnotice: () => {} });
  }
  return sql;
}

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = undefined;
  }
}
