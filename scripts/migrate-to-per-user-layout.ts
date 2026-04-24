#!/usr/bin/env ts-node

/**
 * Migrate Portfolio to Per-User Layout
 *
 * Restructures a flat single-user portfolio (~/.dollhouse/portfolio/*)
 * into the per-user multi-user layout (~/.dollhouse/users/<userId>/portfolio/*).
 *
 * This is a CLI-only operator tool. It is NOT exposed via MCP-AQL.
 *
 * Usage:
 *   npx tsx scripts/migrate-to-per-user-layout.ts status
 *   npx tsx scripts/migrate-to-per-user-layout.ts preview
 *   npx tsx scripts/migrate-to-per-user-layout.ts execute
 *   npx tsx scripts/migrate-to-per-user-layout.ts execute --user-id alice
 *
 * Modes:
 *   status   — Detect the current layout (flat, per-user, or new-install)
 *   preview  — Show what would be moved without making changes
 *   execute  — Perform the migration (idempotent, safe to re-run)
 *
 * Options:
 *   --user-id <id>   Target user ID for migration (default: "local-user")
 *   --home-dir <dir> Override home directory detection
 */

import * as path from 'node:path';
import os from 'node:os';
import { FlatToPerUserMigration } from '../src/storage/migrations/flat-to-per-user/FlatToPerUserMigration.js';
import { validateUserId } from '../src/paths/validateUserId.js';

// ── CLI argument parsing ───────────────────────────────────────────

const args = process.argv.slice(2);
const mode = args.find(a => !a.startsWith('--'));

function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

// ── Extracted steps ────────────────────────────────────────────────

interface ParsedArgs {
  userId: string;
  legacyRoot: string;
}

function parseArgs(): ParsedArgs {
  if (!mode || !['status', 'preview', 'execute'].includes(mode)) {
    console.log('Usage: npx tsx scripts/migrate-to-per-user-layout.ts <status|preview|execute> [options]');
    console.log();
    console.log('Modes:');
    console.log('  status   Detect the current layout');
    console.log('  preview  Show what would be moved (dry run)');
    console.log('  execute  Perform the migration');
    console.log();
    console.log('Options:');
    console.log('  --user-id <id>   Target user ID (default: "local-user")');
    console.log('  --home-dir <dir> Override home directory');
    process.exit(1);
  }

  const homeDir = getArgValue('--home-dir') || process.env.DOLLHOUSE_HOME_DIR || os.homedir();
  const legacyRoot = path.join(homeDir, '.dollhouse');
  const rawUserId = getArgValue('--user-id') || 'local-user';

  let userId: string;
  try {
    userId = validateUserId(rawUserId);
  } catch (err) {
    console.error(`Invalid user ID "${rawUserId}": ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  return { userId: userId!, legacyRoot };
}

async function runStatus(migration: FlatToPerUserMigration): Promise<void> {
  const result = await migration.status();
  console.log(`Current layout: ${result.layout}`);
  if (result.layout === 'flat') {
    console.log('\nThis portfolio uses the flat single-user layout.');
    console.log('Run with "preview" to see what would be moved, or "execute" to migrate.');
  } else if (result.layout === 'per-user') {
    console.log('\nThis portfolio already uses the per-user layout. No migration needed.');
  } else {
    console.log('\nNo legacy portfolio found at this path. Nothing to migrate.');
  }
}

async function runPreview(migration: FlatToPerUserMigration): Promise<void> {
  const status = await migration.status();
  if (status.layout !== 'flat') {
    console.log(`Layout is "${status.layout}" — nothing to migrate.`);
    return;
  }

  const preview = await migration.preview();
  console.log(`Directories to create (${preview.dirsToCreate.length}):`);
  for (const dir of preview.dirsToCreate) {
    console.log(`  [create] ${dir}`);
  }
  console.log();
  console.log(`Items to move (${preview.moves.length}):`);
  for (const move of preview.moves) {
    console.log(`  ${move.from}`);
    console.log(`    -> ${move.to}`);
  }
  console.log();
  console.log(`Marker file: ${preview.markerFile}`);
  console.log('\nRun with "execute" to perform this migration.');
}

async function runExecute(migration: FlatToPerUserMigration): Promise<void> {
  const status = await migration.status();
  if (status.layout !== 'flat') {
    console.log(`Layout is "${status.layout}" — nothing to migrate.`);
    return;
  }

  console.log('Executing migration...\n');
  const result = await migration.execute();

  if (result.success) {
    console.log(`Migration complete. ${result.movedCount} item(s) moved.`);
  } else {
    console.error(`Migration failed. ${result.movedCount} item(s) moved before failure.`);
    for (const err of result.errors) {
      console.error(`  Error: ${err}`);
    }
    process.exit(1);
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { userId, legacyRoot } = parseArgs();

  console.log('=== DollhouseMCP: Portfolio Layout Migration ===\n');
  console.log(`Legacy root: ${legacyRoot}`);
  console.log(`User ID:     ${userId}`);
  console.log(`Mode:        ${mode}\n`);

  const migration = new FlatToPerUserMigration(legacyRoot, userId);

  switch (mode) {
    case 'status':
      await runStatus(migration);
      break;
    case 'preview':
      await runPreview(migration);
      break;
    case 'execute':
      await runExecute(migration);
      break;
  }
}

try {
  await main();
} catch (err) {
  console.error('Fatal error:', err);
  process.exit(1);
}
