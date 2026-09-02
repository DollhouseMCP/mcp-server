import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

const migrationSql = readFileSync(fileURLToPath(new URL(
  '../../../src/database/migrations/0053_integration_cleanup_descriptor_fingerprint.sql',
  import.meta.url,
)), 'utf8');

describe('integration cleanup descriptor-fingerprint migration', () => {
  it('pins a bounded lowercase routing digest on durable cleanup work', () => {
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS "cleanup_descriptor_fingerprint" TEXT');
    expect(migrationSql).toContain('user_integrations_cleanup_descriptor_fingerprint_check');
    expect(migrationSql).toContain("'^[a-f0-9]{64}$'");
    expect(migrationSql).toContain('VALIDATE CONSTRAINT');
  });
});
