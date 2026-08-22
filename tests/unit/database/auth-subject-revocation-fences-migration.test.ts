import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import { authSubjectRevocationFences, users } from '../../../src/database/schema/index.js';
import { hashAuthSubject } from '../../../src/security/authSubjectRevocation.js';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/database/migrations/0054_auth_subject_revocation_fences.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8').replaceAll('\r\n', '\n');

describe('auth subject revocation fences migration', () => {
  it('stores only a deterministic PII-free subject digest', () => {
    expect(hashAuthSubject('github_user-184286')).toMatch(/^[a-f0-9]{64}$/u);
    expect(hashAuthSubject('github_user-184286')).toBe(hashAuthSubject('github_user-184286'));
    expect(authSubjectRevocationFences.subjectHash).toBeDefined();
    expect(migrationSql).toContain('"subject_hash" varchar(64) PRIMARY KEY NOT NULL');
    expect(migrationSql).not.toContain('external_sub');
  });

  it('constrains fences to explicit unlink and account-deletion reasons', () => {
    expect(migrationSql).toContain("'identity_unlinked', 'account_deleted'");
    expect(authSubjectRevocationFences.revokedAt).toBeDefined();
  });

  it('keeps the lower-privilege application role from mutating durable fences', () => {
    expect(migrationSql).toContain('ALTER TABLE "auth_subject_revocation_fences" ENABLE ROW LEVEL SECURITY');
    expect(migrationSql).toContain('ALTER TABLE "auth_subject_revocation_fences" FORCE ROW LEVEL SECURITY');
    expect(migrationSql).not.toContain('CREATE POLICY');
  });

  it('adds a dedicated bearer-token authorization cutoff', () => {
    expect(users.authzChangedAt).toBeDefined();
    expect(migrationSql).toContain('"authz_changed_at" timestamp with time zone NOT NULL DEFAULT NOW()');
  });
});
