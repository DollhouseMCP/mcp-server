#!/usr/bin/env ts-node

/**
 * Export Portfolio from Database
 *
 * Reads elements from the PostgreSQL database and writes them as
 * YAML/Markdown files to a target directory. The raw_content column
 * stores the original file content, so the export is lossless.
 *
 * This is a CLI-only operator tool. It is NOT exposed via MCP-AQL.
 *
 * Usage:
 *   npx tsx scripts/export-portfolio-from-database.ts --user dibble
 *   npx tsx scripts/export-portfolio-from-database.ts --user dibble --dry-run
 *   npx tsx scripts/export-portfolio-from-database.ts --user dibble --output-dir /tmp/export
 *   npx tsx scripts/export-portfolio-from-database.ts --user dibble --type skills
 *   npx tsx scripts/export-portfolio-from-database.ts --user dibble --type skills --type personas
 *   npx tsx scripts/export-portfolio-from-database.ts --user dibble --name "code-reviewer"
 *
 * Required:
 *   --user <username>  The database user whose elements to export.
 *                      Must match the 'sub' claim of the JWT token used to connect.
 *
 * Required environment:
 *   DOLLHOUSE_DATABASE_URL       — app role connection (RLS enforced)
 *   DOLLHOUSE_DATABASE_ADMIN_URL — admin role connection (for user bootstrap)
 *
 * Options:
 *   --dry-run          Show what would be exported without writing files
 *   --output-dir <dir> Target directory (default: platform portfolio dir)
 *   --type <type>      Filter by element type (repeatable: --type skills --type personas)
 *   --name <name>      Filter by element name (repeatable: --name foo --name bar)
 *   --overwrite        Overwrite existing files (default: skip)
 *   --verbose          Show per-element details
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { eq, and, inArray } from 'drizzle-orm';
import { createDatabaseConnection } from '../src/database/connection.js';
import { UserIdentityService } from '../src/services/UserIdentityService.js';
import { withUserRead } from '../src/database/rls.js';
import { elements } from '../src/database/schema/elements.js';
import { ElementType } from '../src/portfolio/types.js';

// ── CLI argument parsing ───────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const overwrite = args.includes('--overwrite');

function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function getArgValues(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      values.push(args[i + 1]);
      i++;
    }
  }
  return values;
}

const ALL_TYPES = Object.values(ElementType) as string[];

// ── Helpers ────────────────────────────────────────────────────────

function resolveDefaultOutputDir(): string {
  const envDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
  if (envDir) return path.resolve(envDir);

  const homeDir = process.env.DOLLHOUSE_HOME_DIR || os.homedir();
  return path.join(homeDir, '.dollhouse', 'portfolio');
}

function fileExtension(elementType: string): string {
  return elementType === 'memories' ? '.yaml' : '.md';
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ── Extracted steps ────────────────────────────────────────────────

interface ParsedArgs {
  outputDir: string;
  typeFilters: string[];
  nameFilters: string[];
  targetTypes: string[];
  username: string;
}

function parseAndValidateArgs(): ParsedArgs {
  const outputDir = getArgValue('--output-dir') || resolveDefaultOutputDir();
  const typeFilters = getArgValues('--type');
  const nameFilters = getArgValues('--name');

  for (const t of typeFilters) {
    if (!ALL_TYPES.includes(t)) {
      console.error(`Error: Unknown element type "${t}".`);
      console.error(`Valid types: ${ALL_TYPES.join(', ')}`);
      process.exit(1);
    }
  }

  const targetTypes = typeFilters.length > 0 ? typeFilters : ALL_TYPES;

  const username = getArgValue('--user');
  if (!username) {
    console.error('Error: --user <username> is required.');
    console.error('This must match the "sub" claim of the JWT token used to connect.');
    console.error('Example: npm run db:export -- --user dibble');
    process.exit(1);
  }

  const dbUrl = process.env.DOLLHOUSE_DATABASE_URL;
  if (!dbUrl) {
    console.error('Error: DOLLHOUSE_DATABASE_URL is not set.');
    process.exit(1);
  }

  return { outputDir, typeFilters, nameFilters, targetTypes, username: username! };
}

interface DatabaseConnection {
  db: ReturnType<typeof import('../src/database/connection.js').createDatabaseConnection>['db'];
  userId: string;
  close: () => Promise<void>;
}

async function connectDatabase(username: string): Promise<DatabaseConnection> {
  const dbUrl = process.env.DOLLHOUSE_DATABASE_URL!;
  const adminUrl = process.env.DOLLHOUSE_DATABASE_ADMIN_URL;
  const ssl = (process.env.DOLLHOUSE_DATABASE_SSL as 'disable' | 'prefer' | 'require') || 'prefer';
  const connection = createDatabaseConnection({ connectionUrl: dbUrl, poolSize: 5, ssl });
  const db = connection.db;

  const identityService = new UserIdentityService({
    db,
    adminConnectionUrl: adminUrl,
    appConnectionUrl: dbUrl,
    ssl,
  });
  const userId = await identityService.resolveOrCreateUser(username);
  console.log(`Connected. Exporting as user '${username}' (${userId})\n`);

  return { db, userId, close: () => connection.close() };
}

type ElementRow = { name: string; elementType: string; rawContent: string };

async function queryElements(
  conn: DatabaseConnection,
  targetTypes: string[],
  nameFilters: string[],
): Promise<ElementRow[]> {
  return withUserRead(conn.db, conn.userId, async (tx) => {
    const conditions = [
      eq(elements.userId, conn.userId),
      inArray(elements.elementType, targetTypes),
    ];
    if (nameFilters.length > 0) {
      conditions.push(inArray(elements.name, nameFilters));
    }
    return tx
      .select({
        name: elements.name,
        elementType: elements.elementType,
        rawContent: elements.rawContent,
      })
      .from(elements)
      .where(and(...conditions));
  });
}

async function exportElements(
  rows: ElementRow[],
  outputDir: string,
): Promise<{ exported: number; skipped: number; failed: number }> {
  let exported = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const ext = fileExtension(row.elementType);
    const typeDir = path.join(outputDir, row.elementType);
    const filePath = path.join(typeDir, `${row.name}${ext}`);

    try {
      if (!overwrite && await fileExists(filePath)) {
        skipped++;
        if (verbose) console.log(`  [skipped] ${filePath} (already exists, use --overwrite)`);
        continue;
      }

      await fs.mkdir(typeDir, { recursive: true });
      await fs.writeFile(filePath, row.rawContent, 'utf-8');
      exported++;
      if (verbose) console.log(`  [exported] ${filePath}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [FAILED] ${filePath}: ${msg}`);
    }
  }

  return { exported, skipped, failed };
}

function printReport(
  exported: number,
  skipped: number,
  failed: number,
  outputDir: string,
): void {
  console.log(`\n=== Export Complete ===`);
  console.log(`  Exported: ${exported}`);
  if (skipped > 0) console.log(`  Skipped:  ${skipped} (use --overwrite to replace)`);
  if (failed > 0) console.log(`  Failed:   ${failed}`);
  console.log();

  if (failed > 0) {
    console.error('Some elements failed to export. Check the errors above.');
    process.exit(1);
  }

  console.log('Export complete.');
  if (exported > 0) {
    console.log(`Files written to: ${outputDir}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { outputDir, typeFilters, nameFilters, targetTypes, username } = parseAndValidateArgs();

  console.log('=== DollhouseMCP: Export Portfolio from Database ===\n');
  console.log(`Output directory: ${outputDir}`);
  if (typeFilters.length > 0) console.log(`Type filter:      ${typeFilters.join(', ')}`);
  if (nameFilters.length > 0) console.log(`Name filter:      ${nameFilters.join(', ')}`);
  if (overwrite) console.log(`Overwrite:        yes`);
  if (dryRun) console.log(`Mode:             DRY RUN (no files will be written)\n`);
  else console.log(`Mode:             LIVE EXPORT\n`);

  console.log('Connecting to database...');
  const conn = await connectDatabase(username);
  const rows = await queryElements(conn, targetTypes, nameFilters);

  if (rows.length === 0) {
    console.log('No elements found matching the filters. Nothing to export.');
    await conn.close();
    process.exit(0);
  }

  const byType: Record<string, number> = {};
  for (const row of rows) {
    byType[row.elementType] = (byType[row.elementType] || 0) + 1;
  }
  console.log('Elements found:');
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`  Total: ${rows.length}\n`);

  if (dryRun) {
    if (verbose) {
      for (const row of rows) {
        const ext = fileExtension(row.elementType);
        const filePath = path.join(outputDir, row.elementType, `${row.name}${ext}`);
        console.log(`  [dry-run] ${filePath}`);
      }
      console.log();
    }
    console.log('Dry run complete. No files were written.');
    console.log('Run without --dry-run to perform the export.');
    await conn.close();
    process.exit(0);
  }

  const { exported, skipped, failed } = await exportElements(rows, outputDir);
  await conn.close();
  printReport(exported, skipped, failed, outputDir);
}

try {
  await main();
} catch (err) {
  console.error('Fatal error:', err);
  process.exit(1);
}
