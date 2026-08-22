import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/database/migrations/0050_integration_descriptor_seed_revision.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8').replaceAll('\r\n', '\n');

describe('integration descriptor seed revision migration', () => {
  it('adds a nullable positive revision restricted to curated descriptors', () => {
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS "curated_seed_revision" INTEGER');
    expect(migrationSql).toContain('"ownership" = \'curated\'');
    expect(migrationSql).toContain('"curated_seed_revision" > 0');
    expect(migrationSql).not.toMatch(/UPDATE\s+"integration_provider_descriptors"/i);
  });
});
