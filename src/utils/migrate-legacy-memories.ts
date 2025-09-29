#!/usr/bin/env node
/**
 * Migration utility for legacy .md memory files
 *
 * FIX (#1206): Migrates old-format memory files to current YAML format
 *
 * Legacy formats found:
 * 1. YAML frontmatter + markdown content (.md files in root)
 * 2. Pure YAML with wrong extension (.md should be .yaml)
 *
 * Target format:
 * - Pure YAML files
 * - In date-organized folders (YYYY-MM-DD/)
 * - .yaml extension only
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface MigrationResult {
  file: string;
  status: 'success' | 'skipped' | 'error';
  reason?: string;
  newPath?: string;
}

/**
 * Find all legacy .md files in memories directory
 */
async function findLegacyFiles(memoriesDir: string): Promise<string[]> {
  const files = await fs.readdir(memoriesDir);
  return files.filter(f => f.endsWith('.md') && !f.startsWith('.'));
}

/**
 * Parse legacy file and extract date
 */
async function parseLegacyFile(filePath: string): Promise<{
  content: any;
  createdDate: string;
  isYamlOnly: boolean;
}> {
  const content = await fs.readFile(filePath, 'utf-8');

  // Check if pure YAML or frontmatter
  const isYamlOnly = !content.startsWith('---\n') ||
    (content.startsWith('---\n') && content.indexOf('\n---\n') === content.lastIndexOf('\n---\n'));

  let parsed: any;
  if (isYamlOnly) {
    // Pure YAML file
    parsed = SecureYamlParser.parse(`---\n${content}\n---\n`, {
      validateContent: false,
      validateFields: false  // Legacy files may have non-standard formats
    });
  } else {
    // Frontmatter + markdown
    parsed = SecureYamlParser.parse(content, {
      validateContent: false,
      validateFields: false  // Legacy files may have non-standard formats
    });
  }

  // Normalize version format (1.0 → 1.0.0)
  if (parsed.data?.version && typeof parsed.data.version === 'number') {
    parsed.data.version = `${parsed.data.version}.0`;
  }
  if (parsed.data?.metadata?.version && typeof parsed.data.metadata.version === 'number') {
    parsed.data.metadata.version = `${parsed.data.metadata.version}.0`;
  }

  // Extract creation date from metadata
  const created = parsed.data?.metadata?.created ||
                  parsed.data?.created ||
                  new Date().toISOString();

  const createdDate = created.split('T')[0]; // YYYY-MM-DD

  return {
    content: parsed.data,
    createdDate,
    isYamlOnly
  };
}

/**
 * Migrate a single legacy file
 */
async function migrateLegacyFile(
  memoriesDir: string,
  filename: string,
  dryRun: boolean = true
): Promise<MigrationResult> {
  try {
    const oldPath = path.join(memoriesDir, filename);
    const { content, createdDate, isYamlOnly } = await parseLegacyFile(oldPath);

    // Generate new filename (remove .md, add .yaml)
    const baseName = path.basename(filename, '.md');
    const newFilename = `${baseName}.yaml`;

    // Create date folder path
    const dateFolder = path.join(memoriesDir, createdDate);
    const newPath = path.join(dateFolder, newFilename);

    // Check if target already exists
    try {
      await fs.access(newPath);
      return {
        file: filename,
        status: 'skipped',
        reason: 'Target file already exists',
        newPath
      };
    } catch {
      // Target doesn't exist, proceed
    }

    if (!dryRun) {
      // Create date folder if needed
      await fs.mkdir(dateFolder, { recursive: true });

      // Write new YAML file
      const yamlContent = Object.entries(content)
        .map(([key, value]) => {
          const yamlValue = typeof value === 'string'
            ? value
            : JSON.stringify(value, null, 2).split('\n').map((line, i) => i === 0 ? line : `  ${line}`).join('\n');
          return `${key}: ${yamlValue}`;
        })
        .join('\n');

      await fs.writeFile(newPath, yamlContent, 'utf-8');

      // Archive old file (don't delete, move to .archive/)
      const archiveDir = path.join(memoriesDir, '.archive');
      await fs.mkdir(archiveDir, { recursive: true });
      const archivePath = path.join(archiveDir, filename);
      await fs.rename(oldPath, archivePath);
    }

    return {
      file: filename,
      status: 'success',
      reason: isYamlOnly ? 'Migrated pure YAML' : 'Migrated frontmatter+markdown',
      newPath
    };
  } catch (error) {
    return {
      file: filename,
      status: 'error',
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Main migration function
 */
async function migrateAll(memoriesDir: string, dryRun: boolean = true) {
  console.log(`\n🔄 Legacy Memory Migration Tool`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will modify files)'}`);
  console.log(`Directory: ${memoriesDir}\n`);

  const legacyFiles = await findLegacyFiles(memoriesDir);

  if (legacyFiles.length === 0) {
    console.log('✅ No legacy .md files found');
    return;
  }

  console.log(`Found ${legacyFiles.length} legacy files:\n`);

  const results: MigrationResult[] = [];

  for (const file of legacyFiles) {
    const result = await migrateLegacyFile(memoriesDir, file, dryRun);
    results.push(result);

    // FIX (SonarCloud S3358): Extract nested ternary to if-else
    let icon: string;
    if (result.status === 'success') {
      icon = '✅';
    } else if (result.status === 'skipped') {
      icon = '⏭️';
    } else {
      icon = '❌';
    }

    console.log(`${icon} ${file}`);
    if (result.reason) console.log(`   ${result.reason}`);
    if (result.newPath) console.log(`   → ${result.newPath}`);
    console.log();
  }

  // Summary
  const success = results.filter(r => r.status === 'success').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors = results.filter(r => r.status === 'error').length;

  console.log('\n📊 Summary:');
  console.log(`   Success: ${success}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Errors: ${errors}`);

  if (dryRun && success > 0) {
    console.log('\n💡 Run with --live to apply changes');
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  // FIX (DMCP-SEC-004): Normalize user input to prevent Unicode normalization attacks
  const userProvidedDir = process.argv[2];
  let memoriesDir: string;

  if (userProvidedDir) {
    const validation = UnicodeValidator.normalize(userProvidedDir);
    if (!validation.isValid) {
      console.error(`❌ Invalid path: ${validation.detectedIssues?.join(', ')}`);
      process.exit(1);
    }
    memoriesDir = validation.normalizedContent;
  } else {
    // FIX (SonarCloud): Use os.homedir() instead of process.env.HOME for reliability
    memoriesDir = path.join(os.homedir(), '.dollhouse/portfolio/memories');
  }

  const dryRun = !process.argv.includes('--live');

  // FIX (SonarCloud S7785): Use top-level await instead of promise chain
  try {
    await migrateAll(memoriesDir, dryRun);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

export { migrateAll, migrateLegacyFile, findLegacyFiles };