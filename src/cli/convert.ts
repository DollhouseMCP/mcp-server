#!/usr/bin/env node

/**
 * CLI command for converting between Anthropic Skills and DollhouseMCP Skills
 *
 * Usage:
 *   dollhouse convert to-anthropic <input> [options]
 *   dollhouse convert from-anthropic <input> [options]
 *
 * Options:
 *   -o, --output <dir>      Output directory
 *   -v, --verbose           Show detailed conversion steps
 *   -r, --report            Generate conversion report
 *   --dry-run               Preview conversion without executing
 *   --no-backup             Don't create backup files
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import {
    DollhouseToAnthropicConverter,
    AnthropicToDollhouseConverter,
    type AnthropicSkillStructure
} from '../converters/index.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

const program = new Command();

interface ConvertOptions {
    output?: string;
    verbose: boolean;
    report: boolean;
    dryRun: boolean;
    backup: boolean;
}

interface ConversionReport {
    timestamp: string;
    direction: 'to-anthropic' | 'from-anthropic';
    input: string;
    output: string;
    filesCreated: string[];
    operationsPerformed: string[];
    success: boolean;
    error?: string;
}

program
    .name('convert')
    .description('Convert between Anthropic Skills and DollhouseMCP Skills formats')
    .command('to-anthropic <input>')
    .description('Convert DollhouseMCP skill to Anthropic Skills format')
    .option('-o, --output <dir>', 'Output directory', './anthropic-skills')
    .option('-v, --verbose', 'Show detailed conversion steps', false)
    .option('-r, --report', 'Generate conversion report', false)
    .option('--dry-run', 'Preview conversion without executing', false)
    .action(async (input: string, options: ConvertOptions) => {
        await convertToAnthropic(input, options);
    });

program
    .command('from-anthropic <input>')
    .description('Convert Anthropic Skills to DollhouseMCP skill format')
    .option('-o, --output <dir>', 'Output directory', './dollhouse-skills')
    .option('-v, --verbose', 'Show detailed conversion steps', false)
    .option('-r, --report', 'Generate conversion report', false)
    .option('--dry-run', 'Preview conversion without executing', false)
    .action(async (input: string, options: ConvertOptions) => {
        await convertFromAnthropic(input, options);
    });

/**
 * Convert DollhouseMCP skill to Anthropic format
 */
async function convertToAnthropic(input: string, options: ConvertOptions): Promise<void> {
    try {
        logOperation('to-anthropic', input, options);

        // Read input file
        if (!fs.existsSync(input)) {
            console.error(chalk.red(`Input file not found: ${input}`));
            process.exit(1);
        }

        const inputContent = fs.readFileSync(input, 'utf-8');
        const skillName = path.basename(input, path.extname(input));

        if (options.verbose) {
            console.log(chalk.blue('\nReading DollhouseMCP skill...'));
            console.log(chalk.gray(`  Input: ${input}`));
            console.log(chalk.gray(`  Size: ${inputContent.length} bytes`));
        }

        // Convert
        const converter = new DollhouseToAnthropicConverter();
        const operationsLog: string[] = [];

        if (options.verbose) {
            console.log(chalk.blue('\nConverting to Anthropic Skills format...'));
        }

        const structure = await converter.convertSkill(inputContent);
        logConversionSteps(structure, operationsLog, options.verbose);

        // Determine output directory
        const outputDir = path.join(options.output || './anthropic-skills', skillName);

        if (options.dryRun) {
            console.log(chalk.yellow('\n[DRY RUN] Would create:'));
            console.log(chalk.gray(`  Output directory: ${outputDir}`));
            console.log(chalk.gray(`  Files: ${countFiles(structure)} files`));
            listFilesToCreate(structure, outputDir);
            process.exit(0);
        }

        // Write output
        if (options.verbose) {
            console.log(chalk.blue(`\nWriting Anthropic skill to: ${outputDir}`));
        }

        await converter.writeToDirectory(structure, outputDir);
        const filesCreated = getCreatedFiles(structure, outputDir);

        // Generate report
        if (options.report) {
            const report = generateReport({
                timestamp: new Date().toISOString(),
                direction: 'to-anthropic',
                input,
                output: outputDir,
                filesCreated,
                operationsPerformed: operationsLog,
                success: true
            });

            const reportPath = path.join(outputDir, '.conversion-report.md');
            fs.writeFileSync(reportPath, report);

            if (options.verbose) {
                console.log(chalk.gray(`\nConversion report: ${reportPath}`));
            }
        }

        // Success
        console.log(chalk.green('\n✓ Conversion complete'));
        console.log(chalk.gray(`  Created ${filesCreated.length} file(s) in: ${outputDir}`));

        process.exit(0);
    } catch (error) {
        console.error(chalk.red('\n✗ Conversion failed:'), error);
        process.exit(1);
    }
}

/**
 * Convert Anthropic skill to DollhouseMCP format
 */
async function convertFromAnthropic(input: string, options: ConvertOptions): Promise<void> {
    try {
        logOperation('from-anthropic', input, options);

        // Verify input directory
        if (!fs.existsSync(input)) {
            console.error(chalk.red(`Input directory not found: ${input}`));
            process.exit(1);
        }

        if (!fs.statSync(input).isDirectory()) {
            console.error(chalk.red(`Input must be a directory: ${input}`));
            process.exit(1);
        }

        const skillName = path.basename(input);

        if (options.verbose) {
            console.log(chalk.blue('\nReading Anthropic skill...'));
            console.log(chalk.gray(`  Input: ${input}`));
            listAnthropicStructure(input);
        }

        // Convert
        const converter = new AnthropicToDollhouseConverter();
        const operationsLog: string[] = [];

        if (options.verbose) {
            console.log(chalk.blue('\nConverting to DollhouseMCP Skills format...'));
        }

        const dollhouseSkill = await converter.convertSkill(input);
        logReverseConversionSteps(input, operationsLog, options.verbose);

        // Determine output file
        const outputDir = options.output || './dollhouse-skills';
        const outputFile = path.join(outputDir, `${skillName}.md`);

        if (options.dryRun) {
            console.log(chalk.yellow('\n[DRY RUN] Would create:'));
            console.log(chalk.gray(`  Output file: ${outputFile}`));
            console.log(chalk.gray(`  Size: ${dollhouseSkill.length} bytes`));
            process.exit(0);
        }

        // Write output
        if (options.verbose) {
            console.log(chalk.blue(`\nWriting DollhouseMCP skill to: ${outputFile}`));
        }

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        await converter.writeToFile(dollhouseSkill, outputFile);

        // Generate report
        if (options.report) {
            const report = generateReport({
                timestamp: new Date().toISOString(),
                direction: 'from-anthropic',
                input,
                output: outputFile,
                filesCreated: [outputFile],
                operationsPerformed: operationsLog,
                success: true
            });

            const reportPath = path.join(outputDir, `${skillName}-conversion-report.md`);
            fs.writeFileSync(reportPath, report);

            if (options.verbose) {
                console.log(chalk.gray(`\nConversion report: ${reportPath}`));
            }
        }

        // Success
        console.log(chalk.green('\n✓ Conversion complete'));
        console.log(chalk.gray(`  Created: ${outputFile}`));

        process.exit(0);
    } catch (error) {
        console.error(chalk.red('\n✗ Conversion failed:'), error);
        process.exit(1);
    }
}

/**
 * Log conversion operation for security audit
 */
function logOperation(direction: string, input: string, options: ConvertOptions): void {
    SecurityMonitor.logSecurityEvent({
        type: 'FILE_COPIED',
        severity: 'LOW',
        source: 'convert CLI',
        details: `Conversion ${direction}: ${input} (dry-run: ${options.dryRun})`
    });
}

/**
 * Log conversion steps during to-anthropic conversion
 */
function logConversionSteps(
    structure: AnthropicSkillStructure,
    operationsLog: string[],
    verbose: boolean
): void {
    // Log SKILL.md
    operationsLog.push('Created SKILL.md with simplified metadata');
    if (verbose) {
        console.log(chalk.gray('  ✓ Created SKILL.md'));
    }

    // Log scripts
    if (structure['scripts/']) {
        const count = Object.keys(structure['scripts/']).length;
        operationsLog.push(`Extracted ${count} script(s) to scripts/`);
        if (verbose) {
            console.log(chalk.gray(`  ✓ Extracted ${count} script(s)`));
            for (const filename of Object.keys(structure['scripts/'])) {
                console.log(chalk.gray(`    - scripts/${filename}`));
            }
        }
    }

    // Log reference docs
    if (structure['reference/']) {
        const count = Object.keys(structure['reference/']).length;
        operationsLog.push(`Extracted ${count} reference document(s) to reference/`);
        if (verbose) {
            console.log(chalk.gray(`  ✓ Extracted ${count} reference document(s)`));
            for (const filename of Object.keys(structure['reference/'])) {
                console.log(chalk.gray(`    - reference/${filename}`));
            }
        }
    }

    // Log examples
    if (structure['examples/']) {
        const count = Object.keys(structure['examples/']).length;
        operationsLog.push(`Extracted ${count} example(s) to examples/`);
        if (verbose) {
            console.log(chalk.gray(`  ✓ Extracted ${count} example(s)`));
        }
    }

    // Log themes
    if (structure['themes/']) {
        const count = Object.keys(structure['themes/']).length;
        operationsLog.push(`Extracted ${count} template(s) to themes/`);
        if (verbose) {
            console.log(chalk.gray(`  ✓ Extracted ${count} template(s)`));
        }
    }
}

/**
 * Log conversion steps during from-anthropic conversion
 */
function logReverseConversionSteps(
    inputDir: string,
    operationsLog: string[],
    verbose: boolean
): void {
    operationsLog.push('Read SKILL.md metadata');
    operationsLog.push('Enriched metadata with DollhouseMCP fields');

    if (fs.existsSync(path.join(inputDir, 'scripts'))) {
        const count = fs.readdirSync(path.join(inputDir, 'scripts')).length;
        operationsLog.push(`Combined ${count} script(s) as code blocks`);
        if (verbose) {
            console.log(chalk.gray(`  ✓ Combined ${count} script(s)`));
        }
    }

    if (fs.existsSync(path.join(inputDir, 'reference'))) {
        const count = fs.readdirSync(path.join(inputDir, 'reference')).length;
        operationsLog.push(`Combined ${count} reference document(s)`);
        if (verbose) {
            console.log(chalk.gray(`  ✓ Combined ${count} reference document(s)`));
        }
    }

    if (fs.existsSync(path.join(inputDir, 'examples'))) {
        const count = fs.readdirSync(path.join(inputDir, 'examples')).length;
        operationsLog.push(`Combined ${count} example(s)`);
        if (verbose) {
            console.log(chalk.gray(`  ✓ Combined ${count} example(s)`));
        }
    }

    if (fs.existsSync(path.join(inputDir, 'themes'))) {
        const count = fs.readdirSync(path.join(inputDir, 'themes')).length;
        operationsLog.push(`Combined ${count} template(s)`);
        if (verbose) {
            console.log(chalk.gray(`  ✓ Combined ${count} template(s)`));
        }
    }
}

/**
 * List Anthropic skill directory structure
 */
function listAnthropicStructure(inputDir: string): void {
    const subdirs = ['scripts', 'reference', 'examples', 'themes'];
    for (const subdir of subdirs) {
        const dirPath = path.join(inputDir, subdir);
        if (fs.existsSync(dirPath)) {
            const files = fs.readdirSync(dirPath);
            console.log(chalk.gray(`  ${subdir}/: ${files.length} file(s)`));
        }
    }
}

/**
 * Count total files in Anthropic structure
 */
function countFiles(structure: AnthropicSkillStructure): number {
    let count = 1; // SKILL.md

    if (structure['scripts/']) count += Object.keys(structure['scripts/']).length;
    if (structure['reference/']) count += Object.keys(structure['reference/']).length;
    if (structure['examples/']) count += Object.keys(structure['examples/']).length;
    if (structure['themes/']) count += Object.keys(structure['themes/']).length;
    if (structure['LICENSE.txt']) count += 1;

    return count;
}

/**
 * List files that would be created (dry-run mode)
 */
function listFilesToCreate(structure: AnthropicSkillStructure, outputDir: string): void {
    console.log(chalk.gray('  Files:'));
    console.log(chalk.gray(`    - SKILL.md`));

    if (structure['scripts/']) {
        for (const filename of Object.keys(structure['scripts/'])) {
            console.log(chalk.gray(`    - scripts/${filename}`));
        }
    }

    if (structure['reference/']) {
        for (const filename of Object.keys(structure['reference/'])) {
            console.log(chalk.gray(`    - reference/${filename}`));
        }
    }

    if (structure['examples/']) {
        for (const filename of Object.keys(structure['examples/'])) {
            console.log(chalk.gray(`    - examples/${filename}`));
        }
    }

    if (structure['themes/']) {
        for (const filename of Object.keys(structure['themes/'])) {
            console.log(chalk.gray(`    - themes/${filename}`));
        }
    }

    if (structure['LICENSE.txt']) {
        console.log(chalk.gray(`    - LICENSE.txt`));
    }
}

/**
 * Get list of created files
 */
function getCreatedFiles(structure: AnthropicSkillStructure, outputDir: string): string[] {
    const files: string[] = [path.join(outputDir, 'SKILL.md')];

    if (structure['scripts/']) {
        for (const filename of Object.keys(structure['scripts/'])) {
            files.push(path.join(outputDir, 'scripts', filename));
        }
    }

    if (structure['reference/']) {
        for (const filename of Object.keys(structure['reference/'])) {
            files.push(path.join(outputDir, 'reference', filename));
        }
    }

    if (structure['examples/']) {
        for (const filename of Object.keys(structure['examples/'])) {
            files.push(path.join(outputDir, 'examples', filename));
        }
    }

    if (structure['themes/']) {
        for (const filename of Object.keys(structure['themes/'])) {
            files.push(path.join(outputDir, 'themes', filename));
        }
    }

    if (structure['LICENSE.txt']) {
        files.push(path.join(outputDir, 'LICENSE.txt'));
    }

    return files;
}

/**
 * Generate conversion report
 */
function generateReport(data: ConversionReport): string {
    const lines: string[] = [];

    lines.push('# Skill Conversion Report');
    lines.push('');
    lines.push(`**Timestamp**: ${data.timestamp}`);
    lines.push(`**Direction**: ${data.direction}`);
    lines.push(`**Status**: ${data.success ? '✓ Success' : '✗ Failed'}`);
    lines.push('');

    lines.push('## Input/Output');
    lines.push('');
    lines.push(`**Input**: \`${data.input}\``);
    lines.push(`**Output**: \`${data.output}\``);
    lines.push('');

    if (data.filesCreated.length > 0) {
        lines.push('## Files Created');
        lines.push('');
        for (const file of data.filesCreated) {
            lines.push(`- \`${file}\``);
        }
        lines.push('');
    }

    lines.push('## Operations Performed');
    lines.push('');
    for (const operation of data.operationsPerformed) {
        lines.push(`- ${operation}`);
    }
    lines.push('');

    if (data.error) {
        lines.push('## Error');
        lines.push('');
        lines.push('```');
        lines.push(data.error);
        lines.push('```');
        lines.push('');
    }

    lines.push('---');
    lines.push('');
    lines.push('*Generated by DollhouseMCP Converter*');

    return lines.join('\n');
}

// Parse command line arguments
program.parse(process.argv);
