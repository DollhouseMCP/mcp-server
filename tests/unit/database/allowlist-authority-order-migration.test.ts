import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountAllowlistAuthorityOrderSequence } from '../../../src/database/schema/webConsole.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(
  testDir,
  '../../../src/database/migrations/0048_allowlist_authority_order.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8').replaceAll('\r\n', '\n');

describe('allowlist authority ordering migration', () => {
  it('declares the database-issued sequence in the Drizzle schema', () => {
    expect(accountAllowlistAuthorityOrderSequence.seqName)
      .toBe('account_allowlist_authority_order_seq');
  });

  it('backfills history before requiring database-issued authority order', () => {
    const addColumn = migrationSql.indexOf('ADD COLUMN IF NOT EXISTS "authority_order"');
    const backfill = migrationSql.indexOf('row_number() OVER');
    const defaultValue = migrationSql.indexOf("SET DEFAULT nextval('account_allowlist_authority_order_seq')");
    const notNull = migrationSql.indexOf('ALTER COLUMN "authority_order" SET NOT NULL');

    expect(addColumn).toBeGreaterThan(0);
    expect(backfill).toBeGreaterThan(addColumn);
    expect(defaultValue).toBeGreaterThan(backfill);
    expect(notNull).toBeGreaterThan(defaultValue);
    expect(migrationSql).toContain('GREATEST("created_at", COALESCE("revoked_at", "created_at"))');
    expect(migrationSql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_allowlist_entries_authority_order"');
  });
});
