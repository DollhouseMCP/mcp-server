import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(
  testDir,
  '../../../src/database/migrations/0045_normalize_allowlist_identities.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8');

describe('allowlist identity normalization migration', () => {
  it('normalizes canonical encodings without compatibility folding', () => {
    expect(migrationSql).toContain('normalize(btrim("value"), NFC)');
    expect(migrationSql).toContain('normalize(btrim("display_value"), NFC)');
    expect(migrationSql).not.toMatch(/NFK[CD]/);
    expect(migrationSql).not.toContain('unaccent');
  });

  it('rebuilds console lookup keys from preserved display identities', () => {
    expect(migrationSql).toContain('SET\n  "normalized_value" = CASE');
    expect(migrationSql).toContain("WHEN \"kind\" IN ('email', 'github_username') THEN translate(");
  });

  it('fails closed on embedded and active-console canonical collisions', () => {
    expect(migrationSql.match(/HAVING count\(\*\) > 1/g)).toHaveLength(2);
    expect(migrationSql).toContain('auth_allowlist contains identities that collide');
    expect(migrationSql).toContain('account_allowlist_entries contains active identities that collide');
  });
});
