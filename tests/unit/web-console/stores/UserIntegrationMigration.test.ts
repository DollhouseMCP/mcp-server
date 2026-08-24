import { readFileSync } from 'node:fs';

import { describe, expect, it } from '@jest/globals';

const migrationSql = readFileSync(
  new URL('../../../../src/database/migrations/0042_web_console_integration_token_refresh.sql', import.meta.url),
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
