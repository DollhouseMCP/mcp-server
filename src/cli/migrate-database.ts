#!/usr/bin/env node
/** Run the existing Drizzle SQL journal with an explicitly supplied admin URL. */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { requireAdminDatabaseUrl } from './adminDatabase.js';
import { migrationTlsOptions } from './migrationTls.js';

export async function migrateDatabase(source: NodeJS.ProcessEnv = process.env): Promise<void> {
  const adminUrl = requireAdminDatabaseUrl(source);
  const tls = migrationTlsOptions(adminUrl, source.DOLLHOUSE_DATABASE_SSL);
  const { url, ...ssl } = tls;
  const client = postgres(url, {
    max: 1,
    ...ssl,
    connect_timeout: 10,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
  });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL('../../src/database/migrations/', import.meta.url)),
      migrationsSchema: 'drizzle',
      migrationsTable: '__drizzle_migrations',
    });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await migrateDatabase();
  } catch {
    // Driver errors can contain the connection URL; never print those details.
    process.stderr.write('Database migration failed. Check the administrator connection and migration state.\n');
    process.exitCode = 1;
  }
}
