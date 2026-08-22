import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import { integrationCuratedProviderState } from '../../../src/database/schema/index.js';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/database/migrations/0052_curated_provider_deployment_state.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8').replaceAll('\r\n', '\n');

describe('curated provider deployment state migration', () => {
  it('exports schema columns matching the durable store contract', () => {
    expect(integrationCuratedProviderState.provider).toBeDefined();
    expect(integrationCuratedProviderState.seedRevision).toBeDefined();
    expect(integrationCuratedProviderState.enabled).toBeDefined();
    expect(integrationCuratedProviderState.updatedAt).toBeDefined();
  });

  it('creates a positive versioned durable state table with forced RLS', () => {
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS "integration_curated_provider_state"');
    expect(migrationSql).toContain('"provider" TEXT PRIMARY KEY');
    expect(migrationSql).toContain('"seed_revision" INTEGER NOT NULL');
    expect(migrationSql).toContain('"enabled" BOOLEAN NOT NULL');
    expect(migrationSql).toContain('CHECK ("seed_revision" > 0)');
    expect(migrationSql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migrationSql).toContain('FORCE ROW LEVEL SECURITY');
  });

  it('backfills versioned curated descriptors as enabled without overwriting newer state', () => {
    expect(migrationSql).toContain('FROM "integration_provider_descriptors"');
    expect(migrationSql).toContain('WHERE "ownership" = \'curated\'');
    expect(migrationSql).toContain('AND "curated_seed_revision" IS NOT NULL');
    expect(migrationSql).toContain('ON CONFLICT ("provider") DO NOTHING');
    expect(migrationSql).not.toMatch(/DELETE\s+FROM\s+"integration_provider_descriptors"/i);
    expect(migrationSql).not.toMatch(/DELETE\s+FROM\s+"user_integrations"/i);
  });
});
