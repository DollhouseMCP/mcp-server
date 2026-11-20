import { MaintenanceConfigError } from './adminDatabase.js';

/** Preserve explicit URL TLS policy and refuse ambiguous certificate settings. */
export function migrationTlsOptions(adminUrl: string, explicitMode?: string): { url: string; ssl?: false | 'prefer' | 'require' | 'verify-full' } {
  let url: URL;
  try {
    url = new URL(adminUrl);
  } catch {
    throw new MaintenanceConfigError('Invalid administrator database URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new MaintenanceConfigError('Invalid administrator database URL');
  }
  const params = url.searchParams;
  if (params.has('sslcert') || params.has('sslkey') || params.has('ssl') ||
      params.getAll('sslmode').length > 1 || params.getAll('sslrootcert').length > 1) {
    throw new MaintenanceConfigError('Unsupported or ambiguous database TLS settings');
  }
  const rootCert = params.get('sslrootcert');
  if (params.has('sslrootcert') && rootCert !== 'system') throw new MaintenanceConfigError('Unsupported or ambiguous database TLS settings');
  const urlMode = params.get('sslmode');
  const validModes = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];
  if (params.has('sslmode') && (!urlMode || !validModes.includes(urlMode))) throw new MaintenanceConfigError('Unsupported or ambiguous database TLS settings');
  if (explicitMode !== undefined && !['disable', 'prefer', 'require'].includes(explicitMode)) {
    throw new MaintenanceConfigError('Invalid DOLLHOUSE_DATABASE_SSL');
  }
  if (explicitMode !== undefined && ((urlMode && urlMode !== explicitMode) || rootCert === 'system')) {
    throw new MaintenanceConfigError('Conflicting database TLS settings');
  }
  // postgres-js otherwise sends sslrootcert to PostgreSQL as a startup parameter.
  if (rootCert === 'system') {
    params.delete('sslrootcert');
    return { url: url.toString(), ssl: 'verify-full' };
  }
  if (urlMode || explicitMode === undefined) return { url: adminUrl };
  return { url: adminUrl, ssl: explicitMode === 'disable' ? false : explicitMode as 'prefer' | 'require' };
}
