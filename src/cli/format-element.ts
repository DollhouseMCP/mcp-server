#!/usr/bin/env node

/**
 * CLI command for formatting/cleaning DollhouseMCP elements
 *
 * Usage:
 *   npx dollhouse format-element <file>
 *   npx dollhouse format-element --type memories
 *   npx dollhouse format-element --all
 *
 * Options:
 *   --in-place    Format files in place (default: create .formatted files)
 *   --no-backup   Don't create backup files when using --in-place
 *   --output-dir  Directory to write formatted files
 *   --type        Element type to format (personas, skills, etc.)
 *   --all         Format all elements in portfolio
 */

import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { ElementFormatter, FormatterResult } from '../utils/ElementFormatter.js';
import { ElementType } from '../portfolio/types.js';
import { PortfolioManager } from '../portfolio/PortfolioManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

const program = new Command();

program
  .name('format-element')
  .description('Format and clean malformed DollhouseMCP elements')
  .argument('[files...]', 'Element files to format')
  .option('-i, --in-place', 'Format files in place', false)
  .option('-b, --backup', 'Create backup files when using --in-place', true)
  .option('-o, --output-dir <dir>', 'Directory for formatted files')
  .option('-t, --type <type>', 'Format all elements of this type')
  .option('-a, --all', 'Format all elements in portfolio', false)
  .option('-v, --validate', 'Validate YAML after formatting', true)
  .option('--dry-run', 'Show what would be formatted without changes', false)
  .action(async (files: string[], options) => {
    try {
      logCliOperation(files, options);
      const formatter = createFormatter(options);
      const results = await processFormatOperation(files, options, formatter);
      displayResults(results, options.dryRun);
      exitWithCode(results);
    } catch (error) {
      console.error(chalk.red('Failed to format elements:'), error);
      process.exit(1);
    }
  });

/**
 * Log CLI operation for audit
 */
function logCliOperation(files: string[], options: any): void {
  SecurityMonitor.logSecurityEvent({
    type: 'FILE_COPIED',
    severity: 'LOW',
    source: 'format-element CLI',
    details: `Starting format operation: ${options.all ? 'all elements' : files.length + ' files'}`
  });
}

/**
 * Create formatter with options
 */
function createFormatter(options: any): ElementFormatter {
  return new ElementFormatter({
    backup: options.backup,
    inPlace: options.inPlace,
    validate: options.validate,
    outputDir: options.outputDir
  });
}

/**
 * Process format operation based on options
 */
async function processFormatOperation(
  files: string[],
  options: any,
  formatter: ElementFormatter
): Promise<FormatterResult[]> {
  if (options.all) {
    return formatAllElements(formatter);
  } else if (options.type) {
    return formatElementType(options.type, formatter);
  } else if (files.length > 0) {
    return formatSpecificFiles(files, options, formatter);
  } else {
    console.error(chalk.red('No files specified. Use --help for usage.'));
    process.exit(1);
  }
}

/**
 * Format all elements in portfolio
 */
async function formatAllElements(formatter: ElementFormatter): Promise<FormatterResult[]> {
  console.log(chalk.blue('Formatting all portfolio elements...'));
  const portfolioManager = PortfolioManager.getInstance();
  const results: FormatterResult[] = [];

  for (const elementType of Object.values(ElementType)) {
    console.log(chalk.gray(`\nFormatting ${elementType}...`));
    const elementDir = portfolioManager.getElementDir(elementType);
    const parentDir = path.dirname(elementDir);
    const typeResults = await formatter.formatElementType(elementType, parentDir);
    results.push(...typeResults);
  }

  return results;
}

/**
 * Format specific element type
 */
async function formatElementType(
  type: string,
  formatter: ElementFormatter
): Promise<FormatterResult[]> {
  const elementType = type as ElementType;
  if (!Object.values(ElementType).includes(elementType)) {
    console.error(chalk.red(`Invalid element type: ${type}`));
    console.log('Valid types:', Object.values(ElementType).join(', '));
    process.exit(1);
  }

  console.log(chalk.blue(`Formatting all ${elementType} elements...`));
  const portfolioManager = PortfolioManager.getInstance();
  const elementDir = portfolioManager.getElementDir(elementType);
  const parentDir = path.dirname(elementDir);
  return formatter.formatElementType(elementType, parentDir);
}

/**
 * Format specific files
 */
async function formatSpecificFiles(
  files: string[],
  options: any,
  formatter: ElementFormatter
): Promise<FormatterResult[]> {
  console.log(chalk.blue(`Formatting ${files.length} file(s)...`));

  if (options.dryRun) {
    for (const file of files) {
      console.log(chalk.gray(`Would format: ${file}`));
    }
    return [];
  }

  return formatter.formatFiles(files);
}

/**
 * Exit with appropriate code based on results
 * Exit codes:
 * 0 - All successful
 * 1 - Total failure (all files failed)
 * 2 - Partial failure (some files failed)
 */
function exitWithCode(results: FormatterResult[]): void {
  const failed = results.filter(r => !r.success).length;
  const total = results.length;

  if (failed === 0) {
    process.exit(0);  // All successful
  } else if (failed === total) {
    process.exit(1);  // Total failure
  } else {
    process.exit(2);  // Partial failure
  }
}

/**
 * Display formatting results
 * Refactored to reduce cognitive complexity
 */
function displayResults(results: FormatterResult[], dryRun: boolean): void {
  const { successful, failed } = categorizeResults(results);

  displayResultsSummary(successful, failed);
  displayResultsDetails(results, failed.length);
  displayStatsSummary(results, dryRun);
}

/**
 * Categorize results into successful and failed
 */
function categorizeResults(results: FormatterResult[]): { successful: FormatterResult[]; failed: FormatterResult[] } {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  return { successful, failed };
}

/**
 * Display results summary
 */
function displayResultsSummary(successful: FormatterResult[], failed: FormatterResult[]): void {
  console.log('\n' + chalk.bold('Formatting Results:'));
  console.log(chalk.green(`✓ ${successful.length} file(s) formatted successfully`));

  if (failed.length > 0) {
    console.log(chalk.red(`✗ ${failed.length} file(s) failed`));
  }
}

/**
 * Display detailed results
 */
function displayResultsDetails(results: FormatterResult[], failedCount: number): void {
  if (results.length > 10 && failedCount === 0) {
    return; // Skip details for large successful batches
  }

  console.log('\n' + chalk.bold('Details:'));
  for (const result of results) {
    displaySingleResult(result);
  }
}

/**
 * Display a single result
 */
function displaySingleResult(result: FormatterResult): void {
  const icon = result.success ? chalk.green('✓') : chalk.red('✗');
  const fileName = path.basename(result.filePath);

  console.log(`\n${icon} ${chalk.cyan(fileName)}`);

  displayResultIssues(result);
  displayResultFixes(result);
  displayResultError(result);
  displayResultBackup(result);
}

/**
 * Display result issues
 */
function displayResultIssues(result: FormatterResult): void {
  if (result.issues.length === 0) return;

  console.log(chalk.yellow('  Issues found:'));
  for (const issue of result.issues) {
    console.log(chalk.yellow(`    - ${issue}`));
  }
}

/**
 * Display result fixes
 */
function displayResultFixes(result: FormatterResult): void {
  if (result.fixed.length === 0) return;

  console.log(chalk.green('  Fixed:'));
  for (const fix of result.fixed) {
    console.log(chalk.green(`    - ${fix}`));
  }
}

/**
 * Display result error
 */
function displayResultError(result: FormatterResult): void {
  if (result.error) {
    console.log(chalk.red(`  Error: ${result.error}`));
  }
}

/**
 * Display result backup path
 */
function displayResultBackup(result: FormatterResult): void {
  if (result.backupPath) {
    console.log(chalk.gray(`  Backup: ${result.backupPath}`));
  }
}

/**
 * Display statistics summary
 */
function displayStatsSummary(results: FormatterResult[], dryRun: boolean): void {
  console.log('\n' + chalk.bold('Summary:'));
  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);
  const totalFixes = results.reduce((sum, r) => sum + r.fixed.length, 0);

  console.log(`  Total issues found: ${totalIssues}`);
  console.log(`  Total fixes applied: ${totalFixes}`);

  if (dryRun) {
    console.log(chalk.yellow('\n(Dry run - no changes were made)'));
  }
}

// Parse command line arguments
program.parse(process.argv);