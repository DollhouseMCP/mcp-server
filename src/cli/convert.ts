#!/usr/bin/env node

/**
 * CLI command for converting between Anthropic Skills and DollhouseMCP Skills
 *
 * Usage:
 *   dollhouse convert to-anthropic <input> [options]
 *   dollhouse convert from-anthropic <input> [options]
 *
 * Input formats:
 *   to-anthropic:   DollhouseMCP skill file (.md)
 *   from-anthropic: Anthropic skill directory or ZIP file
 *
 * Options:
 *   -o, --output <dir>      Output directory
 *                           Default for from-anthropic: ~/.dollhouse/portfolio/skills
 *                           Default for to-anthropic: ./anthropic-skills
 *   -v, --verbose           Show detailed conversion steps
 *   -r, --report            Generate conversion report
 *   --dry-run               Preview conversion without executing
 *
 * Examples:
 *   # Convert downloaded ZIP file from Claude.ai
 *   dollhouse convert from-anthropic ~/Downloads/my-skill.zip
 *
 *   # Convert Anthropic skill directory
 *   dollhouse convert from-anthropic ~/Downloads/my-skill-folder
 *
 *   # Export DollhouseMCP skill to share
 *   dollhouse convert to-anthropic ~/.dollhouse/portfolio/skills/my-skill.md -o ./exported
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Command } from 'commander';
import chalk from 'chalk';
import extract from 'extract-zip';
import {
    DollhouseToAnthropicConverter,
    AnthropicToDollhouseConverter,
    type AnthropicSkillStructure
} from '../converters/index.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

const program = new Command();

/**
 * Get the default DollhouseMCP portfolio skills directory
 */
function getDefaultSkillsDirectory(): string {
    return path.join(process.env.HOME || '', '.dollhouse', 'portfolio', 'skills');
}

/**
 * Extract a ZIP file to a temporary directory
 * @returns Path to extracted directory
 */
async function extractZipFile(zipPath: string, verbose: boolean): Promise<string> {
    const tempDir = path.join(os.tmpdir(), `dollhouse-extract-${Date.now()}`);

    if (verbose) {
        console.log(chalk.blue('\nExtracting ZIP file...'));
        console.log(chalk.gray(`  ZIP: ${zipPath}`));
        console.log(chalk.gray(`  Temp dir: ${tempDir}`));
    }

    await extract(zipPath, { dir: tempDir });

    // Find the skill directory (should be the only top-level directory)
    const contents = fs.readdirSync(tempDir);
    const directories = contents.filter(item =>
        fs.statSync(path.join(tempDir, item)).isDirectory()
    );

    if (directories.length === 1) {
        // Return the skill directory path
        return path.join(tempDir, directories[0]);
    } else if (contents.length > 0) {
        // If multiple items or no directory, return temp dir itself
        return tempDir;
    } else {
        throw new Error('ZIP file appears to be empty');
    }
}

/**
 * Check if a file is a ZIP file based on extension
 */
function isZipFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.zip';
}

/**
 * Prepare input for conversion (handles both directories and ZIP files)
 * @returns {actualInput, tempDir} - actualInput is the directory to convert, tempDir is the temp dir to cleanup (or null)
 */
async function prepareConversionInput(
    input: string,
    verbose: boolean
): Promise<{ actualInput: string; tempDir: string | null }> {
    // Verify input exists
    if (!fs.existsSync(input)) {
        console.error(chalk.red(`Input not found: ${input}`));
        process.exit(1);
    }

    // Handle ZIP files
    if (isZipFile(input)) {
        const actualInput = await extractZipFile(input, verbose);
        const tempDir = path.dirname(actualInput);
        return { actualInput, tempDir };
    }

    // Handle directories
    if (!fs.statSync(input).isDirectory()) {
        console.error(chalk.red(`Input must be a directory or ZIP file: ${input}`));
        process.exit(1);
    }

    return { actualInput: input, tempDir: null };
}

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
    .description('Convert Anthropic Skills to DollhouseMCP skill format (input can be a directory or ZIP file)')
    .option('-o, --output <dir>', 'Output directory', getDefaultSkillsDirectory())
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
            listFilesToCreate(structure);
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
    let tempDir: string | null = null;

    try {
        logOperation('from-anthropic', input, options);

        // Prepare input (handles both directories and ZIP files)
        const { actualInput, tempDir: extractedTempDir } = await prepareConversionInput(input, options.verbose);
        tempDir = extractedTempDir;

        const skillName = path.basename(actualInput);

        if (options.verbose) {
            console.log(chalk.blue('\nReading Anthropic skill...'));
            console.log(chalk.gray(`  Input: ${actualInput}`));
            listAnthropicStructure(actualInput);
        }

        // Convert
        const converter = new AnthropicToDollhouseConverter();
        const operationsLog: string[] = [];

        if (options.verbose) {
            console.log(chalk.blue('\nConverting to DollhouseMCP Skills format...'));
        }

        const dollhouseSkill = await converter.convertSkill(actualInput);
        logReverseConversionSteps(actualInput, operationsLog, options.verbose);

        // Determine output file
        const outputDir = options.output || getDefaultSkillsDirectory();
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
    } finally {
        // Cleanup temp directory if ZIP was extracted
        if (tempDir && fs.existsSync(tempDir)) {
            if (options.verbose) {
                console.log(chalk.gray(`\nCleaning up temporary files...`));
            }
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
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
 * Helper to log directory operations with optional file listing
 */
function logDirectoryOperation(
    structure: AnthropicSkillStructure,
    options: {
        dirKey: keyof AnthropicSkillStructure;
        dirName: string;
        action: string;
        itemType: string;
        operationsLog: string[];
        verbose: boolean;
        listFiles?: boolean;
    }
): void {
    const { dirKey, dirName, action, itemType, operationsLog, verbose, listFiles = false } = options;

    if (structure[dirKey]) {
        const items = structure[dirKey] as Record<string, string>;
        const count = Object.keys(items).length;
        operationsLog.push(`${action} ${count} ${itemType}(s) to ${dirName}/`);

        if (verbose) {
            console.log(chalk.gray(`  ✓ ${action} ${count} ${itemType}(s)`));
            if (listFiles) {
                for (const filename of Object.keys(items)) {
                    console.log(chalk.gray(`    - ${dirName}/${filename}`));
                }
            }
        }
    }
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

    // Log directory operations
    logDirectoryOperation(structure, {
        dirKey: 'scripts/',
        dirName: 'scripts',
        action: 'Extracted',
        itemType: 'script',
        operationsLog,
        verbose,
        listFiles: true
    });
    logDirectoryOperation(structure, {
        dirKey: 'reference/',
        dirName: 'reference',
        action: 'Extracted',
        itemType: 'reference document',
        operationsLog,
        verbose,
        listFiles: true
    });
    logDirectoryOperation(structure, {
        dirKey: 'examples/',
        dirName: 'examples',
        action: 'Extracted',
        itemType: 'example',
        operationsLog,
        verbose
    });
    logDirectoryOperation(structure, {
        dirKey: 'themes/',
        dirName: 'themes',
        action: 'Extracted',
        itemType: 'template',
        operationsLog,
        verbose
    });

    // Log metadata preservation
    if (structure['metadata/']) {
        operationsLog.push('Preserved full DollhouseMCP metadata to metadata/dollhouse.yaml');
        if (verbose) {
            console.log(chalk.gray('  ✓ Preserved metadata for perfect roundtrip'));
        }
    }
}

/**
 * Helper to log directory operations for reverse conversion (from-anthropic)
 */
function logReverseDirectoryOperation(
    inputDir: string,
    dirName: string,
    itemType: string,
    operationsLog: string[],
    verbose: boolean
): void {
    const dirPath = path.join(inputDir, dirName);
    if (fs.existsSync(dirPath)) {
        const count = fs.readdirSync(dirPath).length;
        operationsLog.push(`Combined ${count} ${itemType}(s)${itemType === 'script' ? ' as code blocks' : ''}`);
        if (verbose) {
            console.log(chalk.gray(`  ✓ Combined ${count} ${itemType}(s)`));
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
    operationsLog.push('Read SKILL.md metadata', 'Enriched metadata with DollhouseMCP fields');

    // Log directory operations using helper
    logReverseDirectoryOperation(inputDir, 'scripts', 'script', operationsLog, verbose);
    logReverseDirectoryOperation(inputDir, 'reference', 'reference document', operationsLog, verbose);
    logReverseDirectoryOperation(inputDir, 'examples', 'example', operationsLog, verbose);
    logReverseDirectoryOperation(inputDir, 'themes', 'template', operationsLog, verbose);

    // Handle metadata restoration
    if (fs.existsSync(path.join(inputDir, 'metadata'))) {
        operationsLog.push('Restored original DollhouseMCP metadata from metadata/dollhouse.yaml');
        if (verbose) {
            console.log(chalk.gray('  ✓ Restored original metadata (perfect roundtrip)'));
        }
    }
}

/**
 * List Anthropic skill directory structure
 */
function listAnthropicStructure(inputDir: string): void {
    const subdirs = ['scripts', 'reference', 'examples', 'themes', 'metadata'];
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
 * Iterate through all files in an Anthropic structure
 * Executes a callback for each file found
 */
function iterateStructureFiles(
    structure: AnthropicSkillStructure,
    callback: (dirName: string | null, filename: string) => void
): void {
    // Always include SKILL.md
    callback(null, 'SKILL.md');

    // Iterate through directories
    const directories = ['scripts/', 'reference/', 'examples/', 'themes/', 'metadata/'] as const;
    for (const dir of directories) {
        const dirContent = structure[dir];
        if (dirContent) {
            for (const filename of Object.keys(dirContent)) {
                callback(dir.slice(0, -1), filename); // Remove trailing slash
            }
        }
    }

    // Check for LICENSE.txt
    if (structure['LICENSE.txt']) {
        callback(null, 'LICENSE.txt');
    }
}

/**
 * List files that would be created (dry-run mode)
 */
function listFilesToCreate(structure: AnthropicSkillStructure): void {
    console.log(chalk.gray('  Files:'));
    iterateStructureFiles(structure, (dirName, filename) => {
        const filePath = dirName ? `${dirName}/${filename}` : filename;
        console.log(chalk.gray(`    - ${filePath}`));
    });
}

/**
 * Get list of created files
 */
function getCreatedFiles(structure: AnthropicSkillStructure, outputDir: string): string[] {
    const files: string[] = [];
    iterateStructureFiles(structure, (dirName, filename) => {
        const filePath = dirName
            ? path.join(outputDir, dirName, filename)
            : path.join(outputDir, filename);
        files.push(filePath);
    });
    return files;
}

/**
 * Generate conversion report
 */
function generateReport(data: ConversionReport): string {
    const lines: string[] = [
        '# Skill Conversion Report',
        '',
        `**Timestamp**: ${data.timestamp}`,
        `**Direction**: ${data.direction}`,
        `**Status**: ${data.success ? '✓ Success' : '✗ Failed'}`,
        '',
        '## Input/Output',
        '',
        `**Input**: \`${data.input}\``,
        `**Output**: \`${data.output}\``,
        ''
    ];

    if (data.filesCreated.length > 0) {
        lines.push('## Files Created', '', ...data.filesCreated.map(file => `- \`${file}\``), '');
    }

    lines.push('## Operations Performed', '', ...data.operationsPerformed.map(operation => `- ${operation}`), '');

    if (data.error) {
        lines.push('## Error', '', '```', data.error, '```', '');
    }

    lines.push('---', '', '*Generated by DollhouseMCP Converter*');

    return lines.join('\n');
}

// Parse command line arguments
program.parse(process.argv);
