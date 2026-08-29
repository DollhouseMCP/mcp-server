import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

const migrationSql = readFileSync(fileURLToPath(new URL(
  '../../../src/database/migrations/0052_integration_credential_cleanup_pending.sql',
  import.meta.url,
)), 'utf8');

describe('integration credential cleanup-pending migration', () => {
  it('adds encrypted durable cleanup state with lease fencing', () => {
    expect(migrationSql).toContain("'connected', 'cleanup_pending', 'cleanup_failed', 'revoked', 'error'");
    expect(migrationSql).toContain('"cleanup_attempt_count" INTEGER NOT NULL DEFAULT 0');
    expect(migrationSql).toContain('"cleanup_next_attempt_at" TIMESTAMPTZ');
    expect(migrationSql).toContain('"cleanup_lease_id" UUID');
    expect(migrationSql).toContain('"cleanup_lease_expires_at" TIMESTAMPTZ');
    expect(migrationSql).toContain('DROP CONSTRAINT IF EXISTS "user_integrations_error_reason_check"');
    expect(migrationSql).toContain('"status" = \'cleanup_pending\' AND "error_reason" = \'revocation_failed\'');
    expect(migrationSql).toContain('"status" = \'cleanup_failed\' AND "error_reason" = \'revocation_failed\'');
    expect(migrationSql).toMatch(/"status" NOT IN \('cleanup_pending', 'cleanup_failed'\)[\s\S]*"access_token_ciphertext" IS NOT NULL[\s\S]*"refresh_token_ciphertext" IS NOT NULL/);
    expect(migrationSql).toMatch(/"status" = 'cleanup_failed'[\s\S]*"cleanup_next_attempt_at" IS NULL[\s\S]*"cleanup_lease_id" IS NULL[\s\S]*"cleanup_lease_expires_at" IS NULL/);
    expect(migrationSql).toContain('idx_user_integrations_cleanup_provider_unique');
  });

  it('blocks descriptor and account deletion while a revocable handle remains', () => {
    expect(migrationSql).toContain('integration descriptor still owns revocable credentials');
    expect(migrationSql).toContain('protect_pending_integration_credentials_from_delete');
    expect(migrationSql).toContain('user integration still owns revocable credentials');
    expect(migrationSql.match(/ERRCODE = '55006'/g)).toHaveLength(2);
    expect(migrationSql).toContain('"status" <> \'cleanup_failed\'');
    expect(migrationSql).not.toMatch(/SET\s+"access_token_ciphertext"\s*=\s*NULL[\s\S]*deleted_descriptor/i);
  });
});
