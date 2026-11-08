/** A message selected exclusively by our local maintenance validators. */
export class MaintenanceConfigError extends Error {}

export function maintenanceErrorMessage(error: unknown): string {
  return error instanceof MaintenanceConfigError
    ? error.message
    : 'Database migration failed. Check the administrator connection and migration state.';
}

/** Require the explicit administrator connection for hosted maintenance. */
export function requireAdminDatabaseUrl(source: { DOLLHOUSE_DATABASE_ADMIN_URL?: string } | NodeJS.ProcessEnv): string {
  const value = source.DOLLHOUSE_DATABASE_ADMIN_URL?.trim();
  if (!value) throw new MaintenanceConfigError('DOLLHOUSE_DATABASE_ADMIN_URL is required');
  return value;
}
