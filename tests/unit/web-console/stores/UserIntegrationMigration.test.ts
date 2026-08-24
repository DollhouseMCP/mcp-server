import { readFileSync } from 'node:fs';

import { describe, expect, it } from '@jest/globals';

const migrationSql = readFileSync(
  new URL('../../../../src/database/migrations/0042_web_console_integration_token_refresh.sql', import.meta.url),
  'utf8',
);
const accountLabelMigrationSql = readFileSync(
  new URL(
    '../../../../src/database/migrations/0044_integration_oauth_account_label_compatibility.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('user integration token refresh migration', () => {
  it('retires the legacy error constraint before accepting refresh failures in the consolidated shape', () => {
    const legacyConstraintDrop = migrationSql.indexOf(
      'DROP CONSTRAINT IF EXISTS "user_integrations_error_reason_check"',
    );
    const replacementShape = migrationSql.indexOf(
      'ADD CONSTRAINT "user_integrations_shape_check"',
    );
    const refreshFailureReason = migrationSql.indexOf("'token_refresh_failed'", replacementShape);

    expect(legacyConstraintDrop).toBeGreaterThanOrEqual(0);
    expect(replacementShape).toBeGreaterThan(legacyConstraintDrop);
    expect(refreshFailureReason).toBeGreaterThan(replacementShape);
  });
});

describe('legacy OAuth account-label migration', () => {
  it('removes credential-bearing selectors while preserving the account-label object', () => {
    expect(accountLabelMigrationSql).toContain("descriptor.oauth #- '{accountLabel,field}'");
    expect(accountLabelMigrationSql).toContain("descriptor.oauth #- '{accountLabel,tokenResponseField}'");
    for (const canonicalField of [
      'access_token',
      'api_key',
      'assertion',
      'authorization_code',
      'client_secret',
      'code',
      'credential',
      'credentials',
      'device_code',
      'id_token',
      'password',
      'refresh_token',
      'secret',
      'token',
      'user_code',
    ]) {
      expect(accountLabelMigrationSql).toContain(`('${canonicalField}')`);
    }
    expect(accountLabelMigrationSql).toContain('candidate.unsafe_field OR candidate.unsafe_token_response_field');
  });
});
