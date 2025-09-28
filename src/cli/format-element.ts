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
      const formatter = new ElementFormatter({
        backup: options.backup,
        inPlace: options.inPlace,
        validate: options.validate,
        outputDir: options.outputDir
      });

      let results: FormatterResult[] = [];

      if (options.all) {
        // Format all elements
        console.log(chalk.blue('Formatting all portfolio elements...'));
        const portfolioManager = PortfolioManager.getInstance();

        for (const elementType of Object.values(ElementType)) {
          console.log(chalk.gray(`\nFormatting ${elementType}...`));
          const elementDir = portfolioManager.getElementDir(elementType);
          const parentDir = path.dirname(elementDir);
          const typeResults = await formatter.formatElementType(elementType, parentDir);
          results.push(...typeResults);
        }

      } else if (options.type) {
        // Format specific element type
        const elementType = options.type as ElementType;
        if (!Object.values(ElementType).includes(elementType)) {
          console.error(chalk.red(`Invalid element type: ${options.type}`));
          console.log('Valid types:', Object.values(ElementType).join(', '));
          process.exit(1);
        }

        console.log(chalk.blue(`Formatting all ${elementType} elements...`));
        const portfolioManager = PortfolioManager.getInstance();
        const elementDir = portfolioManager.getElementDir(elementType);
        const parentDir = path.dirname(elementDir);
        results = await formatter.formatElementType(elementType, parentDir);

      } else if (files.length > 0) {
        // Format specific files
        console.log(chalk.blue(`Formatting ${files.length} file(s)...`));

        if (options.dryRun) {
          // Dry run - just analyze
          for (const file of files) {
            console.log(chalk.gray(`Would format: ${file}`));
          }
          return;
        }

        results = await formatter.formatFiles(files);

      } else {
        // No input specified
        console.error(chalk.red('No files specified. Use --help for usage.'));
        process.exit(1);
      }

      // Display results
      displayResults(results, options.dryRun);

      // Exit with appropriate code
      const hasErrors = results.some(r => !r.success);
      process.exit(hasErrors ? 1 : 0);

    } catch (error) {
      console.error(chalk.red('Failed to format elements:'), error);
      process.exit(1);
    }
  });

/**
 * Display formatting results
 */
function displayResults(results: FormatterResult[], dryRun: boolean): void {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log('\n' + chalk.bold('Formatting Results:'));
  console.log(chalk.green(`✓ ${successful.length} file(s) formatted successfully`));

  if (failed.length > 0) {
    console.log(chalk.red(`✗ ${failed.length} file(s) failed`));
  }

  // Show details for each result
  if (results.length <= 10 || failed.length > 0) {
    console.log('\n' + chalk.bold('Details:'));

    for (const result of results) {
      const icon = result.success ? chalk.green('✓') : chalk.red('✗');
      const fileName = path.basename(result.filePath);

      console.log(`\n${icon} ${chalk.cyan(fileName)}`);

      if (result.issues.length > 0) {
        console.log(chalk.yellow('  Issues found:'));
        for (const issue of result.issues) {
          console.log(chalk.yellow(`    - ${issue}`));
        }
      }

      if (result.fixed.length > 0) {
        console.log(chalk.green('  Fixed:'));
        for (const fix of result.fixed) {
          console.log(chalk.green(`    - ${fix}`));
        }
      }

      if (result.error) {
        console.log(chalk.red(`  Error: ${result.error}`));
      }

      if (result.backupPath) {
        console.log(chalk.gray(`  Backup: ${result.backupPath}`));
      }
    }
  }

  // Summary stats
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