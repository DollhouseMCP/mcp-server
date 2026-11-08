import { requireAdminDatabaseUrl } from '../../../src/cli/adminDatabase.js';
import { resolveCliAuthStoragePostgresUrl } from '../../../src/cli/cliAuthStorage.js';

describe('hosted maintenance administrator connection', () => {
  it.each([undefined, '', '   '])('refuses a missing or blank admin URL even with an app URL present', (value) => {
    const env = { DOLLHOUSE_DATABASE_ADMIN_URL: value, DOLLHOUSE_DATABASE_URL: 'postgres://app@fixture/db' };
    expect(() => requireAdminDatabaseUrl(env)).toThrow('DOLLHOUSE_DATABASE_ADMIN_URL is required');
  });

  it('uses the explicit administrator URL rather than the app connection', () => {
    const env = { DOLLHOUSE_DATABASE_ADMIN_URL: '  postgres://admin@fixture/db  ', DOLLHOUSE_DATABASE_URL: 'postgres://app@fixture/db' };
    expect(requireAdminDatabaseUrl(env)).toBe('postgres://admin@fixture/db');
    expect(resolveCliAuthStoragePostgresUrl(env)).toBe('postgres://admin@fixture/db');
  });

  it('preserves the nonhosted app URL fallback when the hosted guard is not used', () => {
    expect(resolveCliAuthStoragePostgresUrl({ DOLLHOUSE_DATABASE_URL: 'postgres://app@fixture/db' })).toBe('postgres://app@fixture/db');
  });
});
