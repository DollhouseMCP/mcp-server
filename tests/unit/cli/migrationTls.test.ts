import { migrationTlsOptions } from '../../../src/cli/migrationTls.js';

describe('migration TLS settings', () => {
  const base = 'postgres://fixture:private-marker@database.test/fixture';
  it.each(['require', 'verify-full', 'verify-ca'])('keeps explicit URL sslmode %s', (mode) => {
    expect(migrationTlsOptions(`${base}?sslmode=${mode}`)).toEqual({ url: `${base}?sslmode=${mode}` });
  });
  it('uses the configured mode only when the URL has no TLS selection', () => {
    expect(migrationTlsOptions(base, 'disable')).toEqual({ url: base, ssl: false });
    expect(migrationTlsOptions(base, 'require')).toEqual({ url: base, ssl: 'require' });
    expect(migrationTlsOptions(base)).toEqual({ url: base });
  });
  it('refuses conflicting, duplicated and unsupported certificate settings without exposing the URL', () => {
    for (const [url, mode] of [
      [`${base}?sslmode=require`, 'disable'],
      [`${base}?sslmode=disable`, 'require'],
      [`${base}?sslmode=verify-full`, 'require'],
      [`${base}?sslmode=require&sslmode=disable`, undefined],
      [`${base}?sslrootcert=/private/root.crt`, undefined],
      [`${base}?sslrootcert=system`, 'require'],
      [`${base}?sslmode=`, undefined],
      [base, ''],
      [`${base}?sslcert=/private/client.crt`, undefined],
      [`${base}?sslkey=/private/client.key`, undefined],
    ]) {
      expect(() => migrationTlsOptions(url as string, mode)).toThrow();
      try { migrationTlsOptions(url as string, mode); } catch (error) {
        expect(String(error)).not.toContain('private-marker');
      }
    }
  });
  it('preserves a system root certificate request', () => {
    expect(migrationTlsOptions(`${base}?sslrootcert=system`)).toEqual({ url: base, ssl: 'verify-full' });
  });
});
