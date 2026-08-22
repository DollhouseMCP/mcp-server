import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

const migrationSql = readFileSync(fileURLToPath(new URL(
  '../../../src/database/migrations/0057_integration_credential_cleanup_pending.sql',
  import.meta.url,
)), 'utf8');

describe('integration credential cleanup migration', () => {
  it('adds a locally unusable durable cleanup state with authorization freshness', () => {
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS "authorization_started_at" TIMESTAMPTZ');
    expect(migrationSql).toContain("'connected', 'cleanup_pending', 'revoked', 'error'");
    expect(migrationSql).toContain('"status" = \'cleanup_pending\' AND "error_reason" = \'revocation_failed\'');
    expect(migrationSql).toContain('"access_token_ciphertext" IS NOT NULL');
    expect(migrationSql).toContain('"refresh_token_ciphertext" IS NOT NULL');
    expect(migrationSql).toContain('"authorization_started_at" IS NOT NULL');
    expect(migrationSql).toContain('SET "connected_at" = COALESCE("last_sync_at", statement_timestamp())');
    expect(migrationSql).toContain('CREATE OR REPLACE FUNCTION "dollhouse_valid_integration_scopes"(JSONB)');
    expect(migrationSql).toContain('FROM jsonb_array_elements($1) AS scope(value)');
    expect(migrationSql).toContain('remediate them before applying migration 0057');
    expect(migrationSql).not.toMatch(/ADD CONSTRAINT "user_integrations_shape_check"[\s\S]*?NOT EXISTS\s*\(\s*SELECT/);
    expect(migrationSql).toContain(') IS TRUE);');
    expect(migrationSql).toContain("ERRCODE = '55006'");
    expect(migrationSql).toContain('integration descriptor still owns revocable credentials');
  });
});
