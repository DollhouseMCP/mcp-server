/** Preserve explicit URL TLS policy and refuse ambiguous certificate settings. */
export function migrationTlsOptions(adminUrl: string, explicitMode?: string): { ssl?: false | 'prefer' | 'require' } {
  let url: URL;
  try {
    url = new URL(adminUrl);
  } catch {
    throw new Error('Invalid administrator database URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Invalid administrator database URL');
  }
  const params = url.searchParams;
  if (params.has('sslcert') || params.has('sslkey') || params.has('ssl') ||
      params.getAll('sslmode').length > 1 || params.getAll('sslrootcert').length > 1) {
    throw new Error('Unsupported or ambiguous database TLS settings');
  }
  const rootCert = params.get('sslrootcert');
  if (params.has('sslrootcert') && rootCert !== 'system') throw new Error('Unsupported or ambiguous database TLS settings');
  const urlMode = params.get('sslmode');
  const validModes = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];
  if (params.has('sslmode') && (!urlMode || !validModes.includes(urlMode))) throw new Error('Unsupported or ambiguous database TLS settings');
  if (explicitMode !== undefined && !['disable', 'prefer', 'require'].includes(explicitMode)) {
    throw new Error('Invalid DOLLHOUSE_DATABASE_SSL');
  }
  if (explicitMode !== undefined && ((urlMode && urlMode !== explicitMode) || rootCert === 'system')) {
    throw new Error('Conflicting database TLS settings');
  }
  // URL settings are consumed by postgres-js; do not override them with a weaker default.
  if (urlMode || rootCert) return {};
  if (explicitMode === undefined) return {};
  return { ssl: explicitMode === 'disable' ? false : explicitMode as 'prefer' | 'require' };
}
