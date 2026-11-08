/** Require the explicit administrator connection for hosted maintenance. */
export function requireAdminDatabaseUrl(source: { DOLLHOUSE_DATABASE_ADMIN_URL?: string } | NodeJS.ProcessEnv): string {
  const value = source.DOLLHOUSE_DATABASE_ADMIN_URL?.trim();
  if (!value) throw new Error('DOLLHOUSE_DATABASE_ADMIN_URL is required');
  return value;
}
