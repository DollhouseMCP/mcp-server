import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(
  testDir,
  '../../../src/database/migrations/0048_bind_integrations_to_descriptors.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8').replaceAll('\r\n', '\n');

describe('integration descriptor binding migration', () => {
  it('binds pending callbacks and credentials to descriptor foreign keys', () => {
    expect(migrationSql).toContain('CONSTRAINT "console_login_transactions_descriptor_fk"');
    expect(migrationSql).toContain('ON DELETE CASCADE');
    expect(migrationSql).toContain('CONSTRAINT "user_integrations_descriptor_fk"');
    expect(migrationSql).toContain('ON DELETE SET NULL');
  });

  it('backfills curated precedence and revokes unowned legacy credentials', () => {
    expect(migrationSql).toContain("ORDER BY CASE WHEN d.\"ownership\" = 'curated' THEN 0 ELSE 1 END");
    expect(migrationSql).toContain('Fail closed for orphaned legacy credentials');
    expect(migrationSql).toContain('"access_token_ciphertext" = NULL');
    expect(migrationSql).toContain('"refresh_token_ciphertext" = NULL');
  });

  it('rejects new unbound configured credentials while preserving coded GitHub', () => {
    expect(migrationSql).toContain('CONSTRAINT "user_integrations_descriptor_binding_check"');
    expect(migrationSql).toContain('"provider" = \'github\'');
    expect(migrationSql).toContain('OR "integration_descriptor_id" IS NOT NULL');
    expect(migrationSql).toContain('OR "revoked_at" IS NOT NULL');
  });

  it('revokes credentials before descriptor deletion releases the foreign key', () => {
    const trigger = migrationSql.indexOf('CREATE TRIGGER "integration_descriptor_revoke_credentials"');
    const clearAccess = migrationSql.lastIndexOf('"access_token_ciphertext" = NULL');
    const clearRefresh = migrationSql.lastIndexOf('"refresh_token_ciphertext" = NULL');
    expect(trigger).toBeGreaterThan(0);
    expect(clearAccess).toBeGreaterThan(0);
    expect(clearRefresh).toBeGreaterThan(0);
    expect(migrationSql).toContain('BEFORE DELETE ON "integration_provider_descriptors"');
    expect(migrationSql).toContain('WHERE "integration_descriptor_id" = OLD."id"');
  });
});
