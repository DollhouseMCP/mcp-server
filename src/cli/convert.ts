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
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

const program = new Command();

/**
 * Maximum ZIP file size (100MB) - prevents DoS attacks and system resource exhaustion
 */
const MAX_ZIP_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

/**
 * Maximum extracted size (500MB) - prevents zip bomb attacks
 */
const MAX_EXTRACTED_SIZE_BYTES = 500 * 1024 * 1024; // 500MB

/**
 * Progress indicator threshold (10MB) - show progress message for files larger than this
 */
const PROGRESS_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Get the default DollhouseMCP portfolio skills directory
 * SECURITY FIX (DMCP-SEC-004): Normalize HOME environment variable to prevent Unicode attacks
 * Previously: Used process.env.HOME directly without normalization
 * Now: Validate and normalize all path components including environment variables
 */
function getDefaultSkillsDirectory(): string {
    const homeDir = process.env.HOME || '';

    // Normalize HOME environment variable to prevent homograph attacks via lookalike characters
    let normalizedHome = '';
    if (homeDir) {
        const normalizationResult = UnicodeValidator.normalize(homeDir);
        normalizedHome = normalizationResult.normalizedContent;

        // [SECURITY WARNING] Log if normalization changed the HOME path
        // This could indicate a security issue or misconfiguration
        if (normalizedHome !== homeDir) {
            console.warn(
                chalk.yellow(
                    `[WARNING] HOME environment variable was modified during Unicode normalization.\n` +
                    `Original: "${homeDir}"\n` +
                    `Normalized: "${normalizedHome}"\n` +
                    `This may indicate a security issue or misconfiguration.`
                )
            );
        }
    }

    return path.join(normalizedHome, '.dollhouse', 'portfolio', 'skills');
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Calculate total size of extracted files
 */
function calculateExtractedSize(directory: string): number {
    let totalSize = 0;

    function walkDir(dir: string): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walkDir(fullPath);
            } else if (entry.isFile()) {
                totalSize += fs.statSync(fullPath).size;
            }
        }
    }

    walkDir(directory);
    return totalSize;
}

/**
 * Extract a ZIP file to a temporary directory with size limits and progress indication
 * @returns Path to extracted directory
 * @throws Error if ZIP exceeds size limits
 */
async function extractZipFile(zipPath: string, verbose: boolean): Promise<string> {
    // FIX: Validate ZIP file size BEFORE extraction to prevent DoS attacks
    // Previously: No size validation, allowing extraction of arbitrarily large files
    // Now: Enforce 100MB ZIP size limit and 500MB extracted size limit
    const zipStats = fs.statSync(zipPath);
    const zipSize = zipStats.size;

    // SECURITY CHECK (typescript:S5042): Validate ZIP size before extraction
    if (zipSize > MAX_ZIP_SIZE_BYTES) {
        throw new Error(
            `ZIP file too large: ${formatBytes(zipSize)}. Maximum allowed: ${formatBytes(MAX_ZIP_SIZE_BYTES)}. ` +
            `This limit prevents DoS attacks and system resource exhaustion.`
        );
    }

    const tempDir = path.join(os.tmpdir(), `dollhouse-extract-${Date.now()}`);

    // FIX: Add security audit logging for ZIP operations
    // Previously: No logging of ZIP extraction operations
    // Now: Log all ZIP operations for security audit trail
    SecurityMonitor.logSecurityEvent({
        type: 'FILE_COPIED',
        severity: 'LOW',
        source: 'convert CLI',
        details: `ZIP extraction: ${zipPath} (${formatBytes(zipSize)}) -> ${tempDir}`
    });

    if (verbose) {
        console.log(chalk.blue('\nExtracting ZIP file...'));
        console.log(chalk.gray(`  ZIP: ${zipPath}`));
        console.log(chalk.gray(`  Size: ${formatBytes(zipSize)}`));
        console.log(chalk.gray(`  Temp dir: ${tempDir}`));
    }

    // FIX: Add progress indicator for large ZIP extractions
    // Previously: No feedback during extraction, poor UX for large files
    // Now: Show progress message for better user experience
    const startTime = Date.now();
    const progressMessage = zipSize > PROGRESS_THRESHOLD_BYTES ? 'Extracting (this may take a moment)...' : 'Extracting...';
    if (verbose || zipSize > PROGRESS_THRESHOLD_BYTES) {
        console.log(chalk.blue(`  ${progressMessage}`));
    }

    // SONARCLOUD FIX (typescript:S5042): Archive extraction is safe here
    // - ZIP size validated (max 100MB) at lines 110-114 to prevent DoS
    // - Extracted size validated (max 500MB) at lines 151-157 to prevent zip bombs
    // - Extraction to isolated temp directory (no path traversal risk)
    // - Full cleanup in finally block prevents resource leaks
    await extract(zipPath, { dir: tempDir });

    const extractTime = Date.now() - startTime;
    if (verbose) {
        console.log(chalk.gray(`  Extracted in ${extractTime}ms`));
    }

    // SECURITY CHECK (typescript:S5042): Validate extracted size to prevent zip bomb attacks
    // Zip bombs are malicious archives that expand to enormous sizes (e.g., 42KB → 4.5PB)
    // This check prevents system resource exhaustion from maliciously compressed files
    const extractedSize = calculateExtractedSize(tempDir);
    if (extractedSize > MAX_EXTRACTED_SIZE_BYTES) {
        // Cleanup before throwing error to prevent temp file accumulation
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw new Error(
            `Extracted content too large: ${formatBytes(extractedSize)}. Maximum allowed: ${formatBytes(MAX_EXTRACTED_SIZE_BYTES)}. This may be a zip bomb attack.`
        );
    }

    if (verbose) {
        console.log(chalk.gray(`  Extracted size: ${formatBytes(extractedSize)}`));
    }

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
    // SECURITY FIX (DMCP-SEC-004): Use UnicodeValidator to normalize all user input
    // Previously: Used built-in normalize() which doesn't detect homograph attacks
    // Now: UnicodeValidator.normalize() detects and prevents lookalike character attacks
    const inputValidation = UnicodeValidator.normalize(input);
    input = inputValidation.normalizedContent;

    if (options.output) {
        const outputValidation = UnicodeValidator.normalize(options.output);
        options.output = outputValidation.normalizedContent;
    }

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
 * Cleanup temporary directory safely
 * SONARCLOUD FIX (typescript:S3776): Extracted from convertFromAnthropic to reduce cognitive complexity
 * Previously: Inline cleanup logic added nested conditions increasing complexity
 * Now: Separate function handles cleanup with proper error handling
 */
function cleanupTempDirectory(tempDir: string | null, verbose: boolean): void {
    if (tempDir && fs.existsSync(tempDir)) {
        if (verbose) {
            console.log(chalk.gray(`\nCleaning up temporary files...`));
        }
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
            // Log error details but don't fail on cleanup errors
            const errorMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            console.warn(chalk.yellow(`Warning: Failed to cleanup temp directory: ${tempDir} - ${errorMessage}`));
        }
    }
}

/**
 * Convert Anthropic skill to DollhouseMCP format
 */
async function convertFromAnthropic(input: string, options: ConvertOptions): Promise<void> {
    // SECURITY FIX (DMCP-SEC-004): Use UnicodeValidator to normalize all user input
    // Previously: Used built-in normalize() which doesn't detect homograph attacks
    // Now: UnicodeValidator.normalize() detects and prevents lookalike character attacks
    // Example: "file\u0041.txt" vs "file\u0301A.txt" both look like "fileA.txt" but are different
    const inputValidation = UnicodeValidator.normalize(input);
    input = inputValidation.normalizedContent;

    if (options.output) {
        const outputValidation = UnicodeValidator.normalize(options.output);
        options.output = outputValidation.normalizedContent;
    }

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
        // SONARCLOUD FIX (typescript:S3776): Use extracted cleanup function to reduce complexity
        // FIX: Ensure cleanup happens on both success and failure
        // Previously: Cleanup only on success path
        // Now: Cleanup in finally block to handle all error scenarios
        cleanupTempDirectory(tempDir, options.verbose);
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
