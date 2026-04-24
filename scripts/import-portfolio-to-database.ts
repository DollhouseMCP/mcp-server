#!/usr/bin/env ts-node

/**
 * Import Portfolio to Database
 *
 * Reads element files from the filesystem portfolio and writes them into
 * the PostgreSQL database. Safe to re-run — uses upserts so existing
 * elements are updated, not duplicated.
 *
 * This is a CLI-only operator tool. It is NOT exposed via MCP-AQL.
 *
 * Usage:
 *   npx tsx scripts/import-portfolio-to-database.ts --user dibble
 *   npx tsx scripts/import-portfolio-to-database.ts --user dibble --dry-run
 *   npx tsx scripts/import-portfolio-to-database.ts --user dibble --portfolio-dir /path/to/portfolio
 *
 * Required:
 *   --user <username>  The database user to import elements under.
 *                      Must match the 'sub' claim of the JWT token you use to connect.
 *
 * Required environment:
 *   DOLLHOUSE_DATABASE_URL      — app role connection (RLS enforced)
 *   DOLLHOUSE_DATABASE_ADMIN_URL — admin role connection (for user bootstrap)
 *
 * Optional:
 *   --dry-run          Show what would be imported without writing
 *   --portfolio-dir    Override portfolio directory (default: platform default)
 *   --verbose          Show per-element details
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { createDatabaseConnection } from '../src/database/connection.js';
import { UserIdentityService } from '../src/services/UserIdentityService.js';
import { DatabaseStorageLayer } from '../src/storage/DatabaseStorageLayer.js';
import { DatabaseMemoryStorageLayer } from '../src/storage/DatabaseMemoryStorageLayer.js';
import { FrontmatterParser } from '../src/storage/FrontmatterParser.js';
import { MemoryMetadataExtractor } from '../src/storage/MemoryMetadataExtractor.js';
import { ElementType } from '../src/portfolio/types.js';
import type { ElementWriteMetadata } from '../src/storage/IStorageLayer.js';

// ── CLI argument parsing ───────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

// ── Helpers ────────────────────────────────────────────────────────

function resolvePortfolioDir(): string {
  const explicit = getArgValue('--portfolio-dir');
  if (explicit) return path.resolve(explicit);

  const envDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
  if (envDir) return path.resolve(envDir);

  const homeDir = process.env.DOLLHOUSE_HOME_DIR || os.homedir();
  const legacyRoot = path.join(homeDir, '.dollhouse', 'portfolio');
  return legacyRoot;
}

async function listElementFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.yaml') || e.name.endsWith('.yml')))
      .map(e => e.name);
  } catch {
    return [];
  }
}

function fileNameToElementName(filename: string): string {
  return filename.replace(/\.(md|yaml|yml)$/, '');
}

function extractWriteMetadata(content: string, elementType: string, fileName: string): ElementWriteMetadata {
  if (elementType === 'memories') {
    const meta = MemoryMetadataExtractor.extractMetadata(content, fileName);
    return {
      author: (meta.author as string) ?? '',
      version: (meta.version as string) ?? '',
      description: (meta.description as string) ?? '',
      tags: (meta.tags as string[]) ?? [],
    };
  }
  const fm = FrontmatterParser.extractMetadata(content);
  return {
    author: fm.author ?? '',
    version: fm.version ?? '',
    description: fm.description ?? '',
    tags: fm.tags ?? [],
  };
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const portfolioDir = resolvePortfolioDir();

  console.log('=== DollhouseMCP: Import Portfolio to Database ===\n');
  console.log(`Portfolio directory: ${portfolioDir}`);
  if (dryRun) console.log('Mode: DRY RUN (no changes will be made)\n');
  else console.log('Mode: LIVE IMPORT\n');

  // Verify portfolio directory exists
  try {
    await fs.access(portfolioDir);
  } catch {
    console.error(`Error: Portfolio directory not found: ${portfolioDir}`);
    console.error('Use --portfolio-dir to specify the correct path.');
    process.exit(1);
  }

  // Scan for elements
  const plan: Array<{ type: string; name: string; file: string; dir: string }> = [];
  for (const elementType of Object.values(ElementType)) {
    const typeDir = path.join(portfolioDir, elementType);
    const files = await listElementFiles(typeDir);
    for (const file of files) {
      plan.push({
        type: elementType,
        name: fileNameToElementName(file),
        file,
        dir: typeDir,
      });
    }
  }

  if (plan.length === 0) {
    console.log('No element files found in portfolio directory. Nothing to import.');
    process.exit(0);
  }

  // Summary
  const byType: Record<string, number> = {};
  for (const item of plan) {
    byType[item.type] = (byType[item.type] || 0) + 1;
  }
  console.log('Elements found:');
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`  Total: ${plan.length}\n`);

  if (dryRun) {
    if (verbose) {
      for (const item of plan) {
        console.log(`  [dry-run] ${item.type}/${item.name} (${item.file})`);
      }
      console.log();
    }
    console.log('Dry run complete. No changes were made.');
    console.log('Run without --dry-run to perform the import.');
    process.exit(0);
  }

  // Require --user
  const username = getArgValue('--user');
  if (!username) {
    console.error('Error: --user <username> is required.');
    console.error('This must match the "sub" claim of the JWT token you use to connect.');
    console.error('Example: npm run db:import -- --user dibble');
    process.exit(1);
  }

  // Verify database configuration
  const dbUrl = process.env.DOLLHOUSE_DATABASE_URL;
  if (!dbUrl) {
    console.error('Error: DOLLHOUSE_DATABASE_URL is not set.');
    console.error('Set it to your PostgreSQL app-role connection URL.');
    process.exit(1);
  }

  // Connect to database and resolve user
  console.log('Connecting to database...');
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
  const userIdResolver = () => userId;
  console.log(`Connected. Importing as user '${username}' (${userId})\n`);

  // Create storage layers
  const storageLayers = new Map<string, DatabaseStorageLayer | DatabaseMemoryStorageLayer>();
  for (const elementType of Object.values(ElementType)) {
    if (elementType === ElementType.MEMORY) {
      storageLayers.set(elementType, new DatabaseMemoryStorageLayer(db, userIdResolver));
    } else {
      storageLayers.set(elementType, new DatabaseStorageLayer(db, userIdResolver, elementType));
    }
  }

  // Import
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of plan) {
    const filePath = path.join(item.dir, item.file);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const layer = storageLayers.get(item.type)!;
      const metadata = extractWriteMetadata(content, item.type, item.file);
      await layer.writeContent(item.type, item.name, content, metadata);
      imported++;
      if (verbose) console.log(`  [imported] ${item.type}/${item.name}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [FAILED] ${item.type}/${item.name}: ${msg}`);
    }
  }

  // Close connection
  await connection.close();

  // Report
  console.log(`\n=== Import Complete ===`);
  console.log(`  Imported: ${imported}`);
  if (skipped > 0) console.log(`  Skipped:  ${skipped}`);
  if (failed > 0) console.log(`  Failed:   ${failed}`);
  console.log();

  if (failed > 0) {
    console.error('Some elements failed to import. Check the errors above.');
    process.exit(1);
  }

  console.log('All elements imported successfully.');
  console.log('Your filesystem files are unchanged — you can switch back to file mode at any time.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
