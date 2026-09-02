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
const migrationCorpus = fs.readdirSync(path.dirname(migrationPath))
  .filter(file => /^\d{4}_.+\.sql$/.test(file))
  .sort()
  .map(file => fs.readFileSync(path.join(path.dirname(migrationPath), file), 'utf8').replaceAll('\r\n', '\n'))
  .join('\n');

function userIntegrationUpdates(sql: string): readonly string[] {
  return [...sql.matchAll(/UPDATE\s+"user_integrations"(?:\s+AS\s+\w+)?[\s\S]*?;/g)]
    .map(match => match[0]);
}

function updateSetClause(statement: string): string {
  return statement.slice(statement.indexOf('SET'), statement.indexOf('WHERE'));
}

function normalizedSql(sql: string): string {
  return sql.replaceAll('"', '').replaceAll(/\s*=\s*/g, ' = ').replaceAll(/\s+/g, ' ').trim().toLowerCase();
}

function migrationStatements(sql: string): readonly string[] {
  return sql.split(';').map(statement => statement.trim()).filter(Boolean);
}

describe('integration descriptor binding migration', () => {
  it('binds pending callbacks and credentials to descriptor foreign keys', () => {
    expect(migrationSql).toContain('CONSTRAINT "console_login_transactions_descriptor_fk"');
    expect(migrationSql).toContain('ON DELETE CASCADE');
    expect(migrationSql).toContain('CONSTRAINT "user_integrations_descriptor_fk"');
    expect(migrationSql).toContain('ON DELETE SET NULL');
  });

  it('backfills curated precedence and preserves unowned legacy credential handles', () => {
    expect(migrationSql).toContain("ORDER BY CASE WHEN d.\"ownership\" = 'curated' THEN 0 ELSE 1 END");
    const orphanTransitions = userIntegrationUpdates(migrationCorpus).filter(statement =>
      /"provider"\s*<>\s*'github'/.test(statement) &&
      /"integration_descriptor_id"\s+IS\s+NULL/.test(statement) &&
      /"status"\s*=\s*'error'/.test(statement) &&
      /"error_reason"\s*=\s*'revocation_failed'/.test(statement));
    expect(orphanTransitions).toHaveLength(1);
    const orphanTransition = orphanTransitions[0];
    const orphanSetClause = updateSetClause(orphanTransition);
    expect(orphanSetClause).toMatch(/"status"\s*=\s*'error'/);
    expect(orphanSetClause).toMatch(/"error_reason"\s*=\s*'revocation_failed'/);
    expect(orphanSetClause).not.toContain('"revoked_at"');
    expect(orphanSetClause).not.toContain('"access_token_ciphertext" = NULL');
    expect(orphanSetClause).not.toContain('"refresh_token_ciphertext" = NULL');

    const strandedMarkerTransitions = migrationStatements(migrationCorpus)
      .map(normalizedSql)
      .filter(statement => statement.includes('update user_integrations'))
      .filter(statement => statement.includes("status = 'error'"))
      .filter(statement => statement.includes("error_reason = 'revocation_failed'"))
      .filter(statement => {
        const update = statement.slice(statement.indexOf('update user_integrations'));
        const setClause = update.slice(update.indexOf(' set '), update.indexOf(' where '));
        const clearsCredential = setClause.includes('access_token_ciphertext = null') ||
          setClause.includes('refresh_token_ciphertext = null');
        const terminalizesMarker = setClause.includes("status = 'cleanup_failed'") ||
          setClause.includes("status = 'revoked'");
        const hidesMarker = setClause.includes('revoked_at =') &&
          !setClause.includes("status = 'cleanup_pending'");
        return clearsCredential || terminalizesMarker || hidesMarker;
      });
    expect(strandedMarkerTransitions).toEqual([]);
  });

  it('rejects new unbound configured credentials while preserving coded GitHub', () => {
    expect(migrationSql).toContain('CONSTRAINT "user_integrations_descriptor_binding_check"');
    expect(migrationSql).toContain('"provider" = \'github\'');
    expect(migrationSql).toContain('OR "integration_descriptor_id" IS NOT NULL');
    expect(migrationSql).toContain('OR "revoked_at" IS NOT NULL');
    expect(migrationSql).toMatch(/OR \(\s*"status" = 'error'\s*AND "error_reason" = 'revocation_failed'\s*AND "revoked_at" IS NULL\s*AND "provider" <> 'github'\s*AND "integration_descriptor_id" IS NULL\s*\)/);
    expect(migrationCorpus).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_integrations_active_provider_unique"[\s\S]*WHERE "revoked_at" IS NULL/);
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
