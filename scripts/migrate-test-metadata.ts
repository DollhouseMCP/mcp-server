#!/usr/bin/env node

/**
 * Migration Script: Add metadata-based test detection markers
 * 
 * This script migrates all test files to use metadata-based detection
 * by adding `_dollhouseMCPTest: true` and `_testMetadata` fields.
 * 
 * Created for Issue #649: Metadata-Based Test Detection
 * Date: August 20, 2025
 * Agent: Migration Agent (Sonnet 3.5)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Configuration
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const ROLLBACK = process.argv.includes('--rollback');

// Get current file directory for relative paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');

// Paths to search for test files
const TEST_PATHS = [
  'test/fixtures',
  'data',
  'test-elements',
  // Note: test/temp is excluded as these are generated files
];

// File patterns that indicate test files (backup for filename detection)
const TEST_FILE_PATTERNS = [
  /^sample-/i,
  /^test-/i,
  /edge-case/i,
  /invalid-element/i,
  /roundtrip.*test/i,
];

// Categories of test files for metadata
const TEST_SUITES = {
  FIXTURES: 'test-fixtures',
  BUNDLED_DATA: 'bundled-test-data', 
  ROUNDTRIP: 'roundtrip-testing',
  INTEGRATION: 'integration-testing',
  UNIT: 'unit-testing',
};

interface TestMetadata {
  _dollhouseMCPTest: boolean;
  _testMetadata: {
    suite: string;
    purpose: string;
    created: string;
    version: string;
    migrated: string;
    originalPath: string;
  };
}

interface MigrationResult {
  processed: number;
  migrated: number;
  skipped: number;
  errors: string[];
  files: {
    path: string;
    status: 'migrated' | 'skipped' | 'error';
    reason?: string;
  }[];
}

/**
 * Determines the test suite category based on file path
 */
function determineTestSuite(filePath: string): string {
  if (filePath.includes('test/fixtures')) return TEST_SUITES.FIXTURES;
  if (filePath.includes('test-elements')) return TEST_SUITES.ROUNDTRIP;
  if (filePath.includes('data/')) return TEST_SUITES.BUNDLED_DATA;
  if (filePath.includes('test/__tests__')) return TEST_SUITES.INTEGRATION;
  return TEST_SUITES.UNIT;
}

/**
 * Determines the purpose of the test file based on filename and content
 */
function determineTestPurpose(filePath: string, content: string): string {
  const filename = path.basename(filePath, '.md');
  
  // Check filename patterns
  if (filename.includes('sample-')) return 'Test fixture for workflow validation';
  if (filename.includes('edge-case')) return 'Edge case testing for robustness validation';
  if (filename.includes('invalid')) return 'Invalid data testing for error handling';
  if (filename.includes('roundtrip')) return 'End-to-end roundtrip workflow testing';
  
  // Check content patterns
  if (content.includes('test persona') || content.includes('test fixture')) {
    return 'Test persona for automated testing';
  }
  if (content.includes('edge case') || content.includes('unicode') || content.includes('special character')) {
    return 'Edge case validation testing';
  }
  if (content.includes('roundtrip') || content.includes('workflow')) {
    return 'Workflow integration testing';
  }
  
  // Check element type from content
  if (content.includes('type: persona') || content.includes('Type: persona')) {
    return 'Test persona for behavior validation';
  }
  if (content.includes('type: skill') || content.includes('Type: skill')) {
    return 'Test skill for capability validation';
  }
  if (content.includes('type: agent') || content.includes('Type: agent')) {
    return 'Test agent for autonomous behavior validation';
  }
  if (content.includes('type: template') || content.includes('Type: template')) {
    return 'Test template for formatting validation';
  }
  if (content.includes('type: ensemble') || content.includes('Type: ensemble')) {
    return 'Test ensemble for orchestration validation';
  }
  if (content.includes('type: memory') || content.includes('Type: memory')) {
    return 'Test memory for state persistence validation';
  }
  
  return 'General test data for DollhouseMCP system validation';
}

/**
 * Checks if a file already has test metadata
 */
function hasTestMetadata(content: string): boolean {
  return content.includes('_dollhouseMCPTest:') || content.includes('_dollhouseMCPTest =');
}

/**
 * Checks if a file is a test file based on path and content patterns
 */
function isTestFile(filePath: string, content: string): boolean {
  const relativePath = path.relative(ROOT_DIR, filePath);
  
  // Check if it's in a test directory
  if (relativePath.includes('test/') || relativePath.includes('data/')) {
    return true;
  }
  
  // Check filename patterns
  const filename = path.basename(filePath);
  if (TEST_FILE_PATTERNS.some(pattern => pattern.test(filename))) {
    return true;
  }
  
  // Check content patterns
  if (content.includes('test') && (
    content.includes('validation') || 
    content.includes('testing') ||
    content.includes('edge case') ||
    content.includes('fixture')
  )) {
    return true;
  }
  
  return false;
}

/**
 * Extracts existing frontmatter from markdown file
 */
function extractFrontmatter(content: string): { frontmatter: string; body: string } {
  const lines = content.split('\n');
  
  if (lines[0] === '---') {
    const endIndex = lines.findIndex((line, index) => index > 0 && line === '---');
    if (endIndex > 0) {
      const frontmatter = lines.slice(0, endIndex + 1).join('\n');
      const body = lines.slice(endIndex + 1).join('\n');
      return { frontmatter, body };
    }
  }
  
  return { frontmatter: '', body: content };
}

/**
 * Adds test metadata to a markdown file
 */
function addTestMetadata(content: string, filePath: string): string {
  const suite = determineTestSuite(filePath);
  const purpose = determineTestPurpose(filePath, content);
  // CROSS-PLATFORM FIX: Normalize path separators for consistent behavior across Windows/Unix
  // Use forward slashes in metadata for consistency regardless of platform
  const relativePath = path.relative(ROOT_DIR, filePath).replaceAll('\\', '/');
  
  const testMetadata: TestMetadata = {
    _dollhouseMCPTest: true,
    _testMetadata: {
      suite,
      purpose,
      created: new Date().toISOString().split('T')[0], // YYYY-MM-DD format
      version: '1.0.0',
      migrated: new Date().toISOString(),
      originalPath: relativePath,
    }
  };
  
  const { frontmatter, body } = extractFrontmatter(content);
  
  if (frontmatter) {
    // Insert before closing ---
    const lines = frontmatter.split('\n');
    const insertIndex = lines.length - 1; // Before the closing ---
    
    const metadataLines = [
      `_dollhouseMCPTest: true`,
      `_testMetadata:`,
      `  suite: "${testMetadata._testMetadata.suite}"`,
      `  purpose: "${testMetadata._testMetadata.purpose}"`,
      `  created: "${testMetadata._testMetadata.created}"`,
      `  version: "${testMetadata._testMetadata.version}"`,
      `  migrated: "${testMetadata._testMetadata.migrated}"`,
      `  originalPath: "${testMetadata._testMetadata.originalPath}"`,
    ];
    
    lines.splice(insertIndex, 0, ...metadataLines);
    return lines.join('\n') + body;
  } else {
    // Create new frontmatter
    const metadataSection = [
      '---',
      `_dollhouseMCPTest: true`,
      `_testMetadata:`,
      `  suite: "${testMetadata._testMetadata.suite}"`,
      `  purpose: "${testMetadata._testMetadata.purpose}"`,
      `  created: "${testMetadata._testMetadata.created}"`,
      `  version: "${testMetadata._testMetadata.version}"`,
      `  migrated: "${testMetadata._testMetadata.migrated}"`,
      `  originalPath: "${testMetadata._testMetadata.originalPath}"`,
      '---',
      '',
    ].join('\n');
    
    return metadataSection + content;
  }
}

/**
 * Removes test metadata from a markdown file (for rollback)
 */
function removeTestMetadata(content: string): string {
  // Remove _dollhouseMCPTest and _testMetadata lines
  const lines = content.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    return !trimmed.startsWith('_dollhouseMCPTest:') &&
           !trimmed.startsWith('_testMetadata:') &&
           !trimmed.match(/^\s+(suite|purpose|created|version|migrated|originalPath):/);
  });
  
  return filtered.join('\n');
}

/**
 * Recursively finds all markdown files in a directory
 */
async function findMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        // Skip temp directories as they contain generated test files
        if (entry.name === 'temp') continue;
        
        const subFiles = await findMarkdownFiles(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    if (VERBOSE) {
      console.warn(`Warning: Could not read directory ${dir}: ${error}`);
    }
  }
  
  return files;
}

/**
 * Processes a single file for migration or rollback
 */
async function processFile(filePath: string, isRollback: boolean): Promise<{
  status: 'migrated' | 'skipped' | 'error';
  reason?: string;
}> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    
    if (isRollback) {
      if (!hasTestMetadata(content)) {
        return { status: 'skipped', reason: 'No test metadata found' };
      }
      
      const newContent = removeTestMetadata(content);
      
      if (!DRY_RUN) {
        await fs.writeFile(filePath, newContent, 'utf-8');
      }
      
      return { status: 'migrated', reason: 'Metadata removed' };
    } else {
      // Migration mode
      if (hasTestMetadata(content)) {
        return { status: 'skipped', reason: 'Already has test metadata' };
      }
      
      if (!isTestFile(filePath, content)) {
        return { status: 'skipped', reason: 'Not identified as test file' };
      }
      
      const newContent = addTestMetadata(content, filePath);
      
      if (!DRY_RUN) {
        await fs.writeFile(filePath, newContent, 'utf-8');
      }
      
      return { status: 'migrated', reason: 'Test metadata added' };
    }
  } catch (error) {
    return { status: 'error', reason: `Failed to process: ${error}` };
  }
}

/**
 * Main migration function
 */
async function migrate(): Promise<MigrationResult> {
  const result: MigrationResult = {
    processed: 0,
    migrated: 0,
    skipped: 0,
    errors: [],
    files: [],
  };
  
  console.log(`🚀 Starting ${ROLLBACK ? 'rollback' : 'migration'}...`);
  if (DRY_RUN) {
    console.log('📋 DRY RUN MODE - No files will be modified');
  }
  console.log('');
  
  // Find all markdown files in test paths
  for (const testPath of TEST_PATHS) {
    const fullPath = path.join(ROOT_DIR, testPath);
    
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) continue;
    } catch {
      console.warn(`⚠️  Directory not found: ${testPath}`);
      continue;
    }
    
    console.log(`📁 Scanning: ${testPath}`);
    const files = await findMarkdownFiles(fullPath);
    
    for (const file of files) {
      result.processed++;
      const relativePath = path.relative(ROOT_DIR, file);
      
      if (VERBOSE) {
        console.log(`   Processing: ${relativePath}`);
      }
      
      const fileResult = await processFile(file, ROLLBACK);
      result.files.push({
        path: relativePath,
        status: fileResult.status,
        reason: fileResult.reason,
      });
      
      if (fileResult.status === 'migrated') {
        result.migrated++;
        console.log(`   ✅ ${relativePath} - ${fileResult.reason}`);
      } else if (fileResult.status === 'skipped') {
        result.skipped++;
        if (VERBOSE) {
          console.log(`   ⏭️  ${relativePath} - ${fileResult.reason}`);
        }
      } else if (fileResult.status === 'error') {
        result.errors.push(`${relativePath}: ${fileResult.reason}`);
        console.log(`   ❌ ${relativePath} - ${fileResult.reason}`);
      }
    }
  }
  
  return result;
}

/**
 * Generates a detailed migration report
 */
function generateReport(result: MigrationResult): void {
  console.log('\n' + '='.repeat(60));
  console.log(`📊 ${ROLLBACK ? 'ROLLBACK' : 'MIGRATION'} REPORT`);
  console.log('='.repeat(60));
  
  console.log(`📈 Summary:`);
  console.log(`   Files processed: ${result.processed}`);
  console.log(`   Files ${ROLLBACK ? 'rolled back' : 'migrated'}: ${result.migrated}`);
  console.log(`   Files skipped: ${result.skipped}`);
  console.log(`   Errors: ${result.errors.length}`);
  console.log('');
  
  if (result.errors.length > 0) {
    console.log(`❌ Errors:`);
    result.errors.forEach(error => console.log(`   ${error}`));
    console.log('');
  }
  
  // Group files by status for detailed breakdown
  const byStatus = result.files.reduce((acc, file) => {
    if (!acc[file.status]) acc[file.status] = [];
    acc[file.status].push(file);
    return acc;
  }, {} as Record<string, typeof result.files>);
  
  if (byStatus.migrated && byStatus.migrated.length > 0) {
    console.log(`✅ ${ROLLBACK ? 'Rolled back' : 'Migrated'} files (${byStatus.migrated.length}):`);
    byStatus.migrated.forEach(file => {
      console.log(`   ${file.path} - ${file.reason}`);
    });
    console.log('');
  }
  
  if (VERBOSE && byStatus.skipped && byStatus.skipped.length > 0) {
    console.log(`⏭️  Skipped files (${byStatus.skipped.length}):`);
    byStatus.skipped.forEach(file => {
      console.log(`   ${file.path} - ${file.reason}`);
    });
    console.log('');
  }
  
  // Report completion
  if (result.errors.length === 0) {
    console.log(`🎉 ${ROLLBACK ? 'Rollback' : 'Migration'} completed successfully!`);
  } else {
    console.log(`⚠️  ${ROLLBACK ? 'Rollback' : 'Migration'} completed with ${result.errors.length} errors.`);
  }
  
  if (DRY_RUN) {
    console.log(`\n💡 This was a dry run. Run without --dry-run to apply changes.`);
  }
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  try {
    // Show help if requested
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      console.log(`
🔧 DollhouseMCP Test Metadata Migration Script

Usage: node migrate-test-metadata.ts [options]

Options:
  --dry-run     Preview changes without modifying files
  --verbose     Show detailed output for all operations
  --rollback    Remove test metadata instead of adding it
  --help, -h    Show this help message

Examples:
  node migrate-test-metadata.ts --dry-run          # Preview migration
  node migrate-test-metadata.ts                    # Run migration
  node migrate-test-metadata.ts --rollback         # Remove metadata
  node migrate-test-metadata.ts --verbose          # Detailed output

This script adds _dollhouseMCPTest and _testMetadata fields to all test files
to enable metadata-based test detection instead of filename patterns.
      `);
      return;
    }
    
    const result = await migrate();
    generateReport(result);
    
    // Exit with error code if there were errors
    if (result.errors.length > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(`💥 Fatal error: ${error}`);
    process.exit(1);
  }
}

// Run the script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { migrate, addTestMetadata, removeTestMetadata, isTestFile };