import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(
  testDir,
  '../../../src/database/migrations/0045_normalize_allowlist_identities.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8').replaceAll('\r\n', '\n');

describe('allowlist identity normalization migration', () => {
  it('normalizes canonical encodings without compatibility folding', () => {
    expect(migrationSql).toContain('normalize(btrim("value"), NFC)');
    expect(migrationSql).toContain('normalize(btrim("display_value"), NFC)');
    expect(migrationSql).not.toMatch(/NFK[CD]/);
    expect(migrationSql).not.toContain('unaccent');
  });

  it('captures every legacy active console row before rebuilding lookup keys', () => {
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS "account_allowlist_identity_migration_reviews"');
    expect(migrationSql).toContain('"legacy_normalized_value"');
    expect(migrationSql).toContain('"legacy_display_value"');
    expect(migrationSql).toContain('WHERE "revoked_at" IS NULL\nON CONFLICT ("entry_id") DO NOTHING');
    expect(migrationSql.indexOf('INSERT INTO "account_allowlist_identity_migration_reviews"'))
      .toBeLessThan(migrationSql.indexOf('UPDATE "account_allowlist_entries"'));
  });

  it('rebuilds console lookup keys without confusable folding', () => {
    expect(migrationSql).toContain('SET\n  "normalized_value" = CASE');
    expect(migrationSql).toContain("WHEN \"kind\" IN ('email', 'github_username') THEN translate(");
    expect(migrationSql).toContain('translate(\n            normalize(btrim("display_value"), NFC)');
    expect(migrationSql.match(/'ABCDEFGHIJKLMNOPQRSTUVWXYZ'/g)).toHaveLength(3);
    expect(migrationSql.match(/'abcdefghijklmnopqrstuvwxyz'/g)).toHaveLength(3);
    expect(migrationSql).toContain('PostgreSQL lower() is locale-aware');
  });

  it('warns while legacy console identities still need operator review', () => {
    expect(migrationSql).toContain('WHERE "reviewed_at" IS NULL');
    expect(migrationSql).toContain('require identity review before account-allowlist authority cutover');
  });

  it('fails closed on embedded and active-console canonical collisions', () => {
    expect(migrationSql.match(/HAVING count\(\*\) > 1/g)).toHaveLength(2);
    expect(migrationSql).toContain('auth_allowlist contains identities that collide');
    expect(migrationSql).toContain('account_allowlist_entries contains active identities that collide');
    expect(migrationSql.indexOf('account_allowlist_entries contains active identities that collide'))
      .toBeLessThan(migrationSql.indexOf('UPDATE "account_allowlist_entries"'));
  });

  it('leaves revoked console rows unchanged as audit history', () => {
    const consoleUpdate = migrationSql.slice(migrationSql.indexOf('UPDATE "account_allowlist_entries"'));
    expect(consoleUpdate).toContain('"revoked_at" IS NULL\n  AND (');
  });
});
