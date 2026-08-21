import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/database/migrations/0049_integration_descriptor_secret_revision.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8').replaceAll('\r\n', '\n');

describe('integration descriptor secret revision migration', () => {
  it('adds a nullable logical revision without rewriting legacy descriptors', () => {
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS "client_secret_revision" UUID');
    expect(migrationSql).toContain('"client_secret_ciphertext" IS NOT NULL');
    expect(migrationSql).toContain('OR "client_secret_revision" IS NULL');
    expect(migrationSql).not.toMatch(/UPDATE\s+"integration_provider_descriptors"/i);
  });
});
