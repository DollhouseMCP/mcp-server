import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/database/migrations/0051_integration_concurrency_fences.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8').replaceAll('\r\n', '\n');

describe('integration concurrency fences migration', () => {
  it('adds paired durable refresh lease state and monotonic generations', () => {
    expect(migrationSql).toContain('"credential_generation" INTEGER NOT NULL DEFAULT 0');
    expect(migrationSql).toContain('"refresh_fence" INTEGER NOT NULL DEFAULT 0');
    expect(migrationSql).toContain('"refresh_lease_id" UUID');
    expect(migrationSql).toContain('"refresh_lease_expires_at" TIMESTAMPTZ');
    expect(migrationSql).toContain(
      '("refresh_lease_id" IS NULL AND "refresh_lease_expires_at" IS NULL)',
    );
  });

  it('prevents stale curated replicas from overwriting protected fields', () => {
    expect(migrationSql).toContain('NEW.curated_seed_revision < OLD.curated_seed_revision');
    expect(migrationSql).toContain('curated descriptor protected fields require a newer seed revision');
    expect(migrationSql).toContain('NEW.client_secret_revision');
    expect(migrationSql).toContain('NEW.oauth');
    expect(migrationSql).not.toContain('NEW.client_secret_ciphertext');
    expect(migrationSql).not.toContain('NEW.credential_key_version');
  });
});
