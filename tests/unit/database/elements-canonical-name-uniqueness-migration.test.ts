import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/database/migrations',
);
const migrationSql = fs.readFileSync(
  path.join(migrationsDir, '0055_elements_canonical_name_uniqueness.sql'),
  'utf8',
).replaceAll('\r\n', '\n');
const journal = JSON.parse(fs.readFileSync(
  path.join(migrationsDir, 'meta/_journal.json'),
  'utf8',
)) as { entries: Array<{ idx: number; tag: string }> };

describe('elements canonical-name uniqueness migration', () => {
  it('preserves legacy collisions while rejecting new canonical duplicates', () => {
    expect(migrationSql).toContain('CREATE INDEX IF NOT EXISTS "idx_elements_user_type_canonical_name"');
    expect(migrationSql).not.toContain('CREATE UNIQUE INDEX');
    expect(migrationSql).toContain('"user_id"');
    expect(migrationSql).toContain('"element_type"');
    expect(migrationSql).toContain('lower(btrim("name"))');
    expect(migrationSql).toContain("'[[:space:]_]+', '-', 'g'");
    expect(migrationSql).toContain("'-+', '-', 'g'");
    expect(migrationSql).toContain("trim(both '-' from");
    expect(migrationSql).toContain('CREATE OR REPLACE FUNCTION "enforce_elements_canonical_name_uniqueness"');
    expect(migrationSql).toContain('SET search_path = pg_catalog');
    expect(migrationSql).toContain('SET search_path = pg_catalog, public');
    expect(migrationSql).toContain('FROM public."elements" AS existing');
    expect(migrationSql).toContain('pg_advisory_xact_lock');
    expect(migrationSql).toContain('RAISE unique_violation');
    expect(migrationSql).toContain("CONSTRAINT = 'idx_elements_user_type_canonical_name'");
    expect(migrationSql).toContain('BEFORE INSERT OR UPDATE OF "user_id", "element_type", "name"');
  });

  it('allows CAS edits that preserve a legacy row canonical identity', () => {
    expect(migrationSql).toContain("IF TG_OP = 'UPDATE'");
    expect(migrationSql).toContain('OLD."user_id" = NEW."user_id"');
    expect(migrationSql).toContain('OLD."element_type" = NEW."element_type"');
    expect(migrationSql).toContain(
      'public."dollhouse_element_canonical_name"(OLD."name") = canonical_name',
    );
    expect(migrationSql.indexOf("IF TG_OP = 'UPDATE'"))
      .toBeLessThan(migrationSql.indexOf('pg_advisory_xact_lock'));
  });

  it('lets the exact-name unique index arbitrate ordinary upserts', () => {
    expect(migrationSql).toContain("IF TG_OP = 'INSERT' AND EXISTS");
    expect(migrationSql).toContain('exact_existing."name" = NEW."name"');
    expect(migrationSql.indexOf('pg_advisory_xact_lock'))
      .toBeLessThan(migrationSql.indexOf("IF TG_OP = 'INSERT' AND EXISTS"));
    expect(migrationSql.indexOf("IF TG_OP = 'INSERT' AND EXISTS"))
      .toBeLessThan(migrationSql.indexOf('RAISE unique_violation'));
  });

  it('is registered as migration 55', () => {
    expect(journal.entries).toContainEqual(expect.objectContaining({
      idx: 55,
      tag: '0055_elements_canonical_name_uniqueness',
    }));
  });
});
