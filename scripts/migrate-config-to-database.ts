#!/usr/bin/env node
/**
 * migrate-config-to-database
 *
 * Operator CLI for the legacy `~/.dollhouse/config.yml` + JWKS keyfile
 * + cookie-secret keyfile → DB-backed stores migration. Mirrors the
 * shape of `scripts/migrate-to-per-user-layout.ts`.
 *
 * Usage:
 *   npx tsx scripts/migrate-config-to-database.ts status
 *   npx tsx scripts/migrate-config-to-database.ts preview
 *   npx tsx scripts/migrate-config-to-database.ts execute
 *
 * Status: prints whether the marker file is present (and when it was written).
 * Preview: parses the legacy state, prints what would be migrated, no writes.
 * Execute: actually does the migration. Idempotent — safe to re-run.
 *
 * Required env when DB-backed stores are wanted:
 *   DOLLHOUSE_STORAGE_BACKEND=database
 *   DOLLHOUSE_DATABASE_URL=postgres://...
 *   DOLLHOUSE_DATABASE_ADMIN_URL=postgres://...
 *
 * Without these, the stores are filesystem-backed and the migration is
 * effectively a no-op (legacy filesystem → filesystem-backed stores at
 * the same locations).
 *
 * Exit codes:
 *   0 — success (incl. already-migrated and no-legacy-state)
 *   1 — migration failed (legacy state present but unreadable / write error)
 *   2 — usage error
 */

import { env } from '../src/config/env.js';
import { logger } from '../src/utils/logger.js';
import { createOperatorConfigStore } from '../src/storage/operatorConfig/createOperatorConfigStore.js';
import { createUserConfigStore } from '../src/storage/userConfig/createUserConfigStore.js';
import { createSigningKeyStore } from '../src/storage/signingKeys/createSigningKeyStore.js';
import { runConfigToDatabaseMigration, readMarker } from '../src/storage/migration/configToDatabase.js';
import { bootstrapDatabase } from '../src/database/bootstrap.js';

type Subcommand = 'status' | 'preview' | 'execute';

function parseArgs(): { sub: Subcommand } {
  const sub = process.argv[2] as Subcommand | undefined;
  if (sub !== 'status' && sub !== 'preview' && sub !== 'execute') {
    process.stderr.write(
      'Usage: npx tsx scripts/migrate-config-to-database.ts <status | preview | execute>\n',
    );
    process.exit(2);
  }
  return { sub };
}

async function main(): Promise<void> {
  const { sub } = parseArgs();

  if (sub === 'status') {
    const marker = await readMarker();
    if (marker) {
      const date = new Date(marker.migratedAt).toISOString();
      process.stdout.write(`Migrated: ${date} (marker version ${marker.version})\n`);
    } else {
      process.stdout.write('Not migrated. Run `execute` to migrate.\n');
    }
    return;
  }

  // preview + execute both need stores + userId
  let userId: string;
  if (env.DOLLHOUSE_STORAGE_BACKEND === 'database') {
    if (!env.DOLLHOUSE_DATABASE_URL) {
      process.stderr.write('DOLLHOUSE_STORAGE_BACKEND=database requires DOLLHOUSE_DATABASE_URL.\n');
      process.exit(1);
    }
    process.stdout.write('Bootstrapping database to resolve OS-user UUID...\n');
    const bootstrap = await bootstrapDatabase({
      connectionUrl: env.DOLLHOUSE_DATABASE_URL,
      adminConnectionUrl: env.DOLLHOUSE_DATABASE_ADMIN_URL ?? env.DOLLHOUSE_DATABASE_URL,
      ssl: env.DOLLHOUSE_DATABASE_SSL,
      poolSize: env.DOLLHOUSE_DATABASE_POOL_SIZE,
    });
    userId = bootstrap.userId;
  } else {
    // Filesystem-mode "migration" — no DB user; use the bootstrapped OS
    // username as the userId for the per-user filesystem layout (the
    // sentinel UUID since FilesystemUserConfigStore writes one file per
    // userId under <state-dir>/users/<uuid>/config.json).
    const { DEFAULT_SYSTEM_USER_ID } = await import('../src/config/ConfigManager.js');
    userId = DEFAULT_SYSTEM_USER_ID;
    process.stdout.write(
      `Filesystem mode — using sentinel userId for per-user file layout: ${userId}\n`,
    );
  }

  const database = env.DOLLHOUSE_STORAGE_BACKEND === 'database' && env.DOLLHOUSE_DATABASE_URL
    ? (await import('../src/database/connection.js')).createDatabaseConnection({
      connectionUrl: env.DOLLHOUSE_DATABASE_URL,
      ssl: env.DOLLHOUSE_DATABASE_SSL,
      poolSize: env.DOLLHOUSE_DATABASE_POOL_SIZE,
    }).db
    : undefined;

  const [operatorStore, userStore, signingKeyStore] = await Promise.all([
    createOperatorConfigStore({ database }),
    createUserConfigStore({ database }),
    createSigningKeyStore({ database }),
  ]);

  process.stdout.write(`Running migration in ${sub === 'preview' ? 'PREVIEW (no writes)' : 'EXECUTE'} mode...\n`);
  try {
    const result = await runConfigToDatabaseMigration({
      operatorStore, userStore, signingKeyStore, userId,
      dryRun: sub === 'preview',
    });
    printResult(result);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

function printResult(r: Awaited<ReturnType<typeof runConfigToDatabaseMigration>>): void {
  process.stdout.write(`\nStatus: ${r.status}\n`);
  process.stdout.write(`  config.yml exists:        ${r.plan.configYamlExists}\n`);
  process.stdout.write(`  JWKS keyfile exists:      ${r.plan.jwksKeyExists}\n`);
  process.stdout.write(`  cookie secret exists:     ${r.plan.cookieSecretExists}\n`);
  if (r.plan.operatorSectionsToWrite.length > 0) {
    process.stdout.write(`  operator sections:        ${r.plan.operatorSectionsToWrite.join(', ')}\n`);
  }
  if (r.plan.userSectionsToWrite.length > 0) {
    process.stdout.write(`  user sections:            ${r.plan.userSectionsToWrite.join(', ')}\n`);
  }
  process.stdout.write(`  userId for per-user data: ${r.plan.userId}\n`);
  if (r.status === 'migrated') {
    process.stdout.write(`  marker written at:        ${r.markerPath}\n`);
  } else if (r.status === 'preview') {
    process.stdout.write(`  marker WOULD be written:  ${r.markerPath}\n`);
  }
}

main().catch((err) => { // NOSONAR — top-level await breaks the Jest CJS transform; .catch() is required here
  logger.error('migrate-config-to-database failed', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.stderr.write(`Unhandled error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
