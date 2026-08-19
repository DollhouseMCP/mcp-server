import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(
  testDir,
  '../../../src/database/migrations/0047_bind_oauth_flows_to_descriptor_routing.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8').replaceAll('\r\n', '\n');

describe('integration descriptor routing migration', () => {
  it('expires unversioned pending descriptor flows before enforcing the fingerprint', () => {
    const addColumn = migrationSql.indexOf('ADD COLUMN IF NOT EXISTS "integration_descriptor_fingerprint"');
    const expireFlows = migrationSql.indexOf('DELETE FROM "console_login_transactions"');
    const constraint = migrationSql.indexOf('CONSTRAINT "console_login_transactions_descriptor_fingerprint_check"');

    expect(addColumn).toBeGreaterThan(0);
    expect(expireFlows).toBeGreaterThan(addColumn);
    expect(constraint).toBeGreaterThan(expireFlows);
    expect(migrationSql).toContain('WHERE "integration_descriptor_id" IS NOT NULL');
    expect(migrationSql).toContain("'^[a-f0-9]{64}$'");
  });
});
