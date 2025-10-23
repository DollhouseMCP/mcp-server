/**
 * Element Formatter/Cleaner Tool
 *
 * Fixes common issues with malformed DollhouseMCP elements:
 * - Escaped newlines (\n instead of actual line breaks)
 * - Malformed metadata (embedded in content instead of top-level)
 * - Broken YAML structure
 * - Makes elements human-readable and editable
 *
 * FIXES IMPLEMENTED (Issue #1190):
 * 1. CRITICAL: Unescapes newline characters for readability
 * 2. HIGH: Extracts embedded metadata to proper YAML structure
 * 3. ENHANCEMENT: Formats YAML for consistency and readability
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { logger } from '../utils/logger.js';
import { ElementType } from '../portfolio/types.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

// Security: Maximum file size for processing (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Note: Direct auditLog removed - using SecurityMonitor directly for all audit logging

export interface ElementFormatterOptions {
  /** Whether to create backup files before formatting */
  backup?: boolean;
  /** Whether to fix files in place or create new files */
  inPlace?: boolean;
  /** Whether to validate YAML after formatting */
  validate?: boolean;
  /** Custom output directory for formatted files */
  outputDir?: string;
  /** Maximum file size to process (bytes) */
  maxFileSize?: number;
}

export interface FormatterResult {
  success: boolean;
  filePath: string;
  issues: string[];
  fixed: string[];
  error?: string;
  backupPath?: string;
}

export class ElementFormatter {
  private readonly options: Required<ElementFormatterOptions>;

  constructor(options: ElementFormatterOptions = {}) {
    this.options = {
      backup: options.backup ?? true,
      inPlace: options.inPlace ?? false,
      validate: options.validate ?? true,
      outputDir: options.outputDir ?? '',
      maxFileSize: options.maxFileSize ?? MAX_FILE_SIZE
    };
  }

  // Note: validateYamlContent removed - SecureYamlParser handles all validation internally

  /**
   * Normalize Unicode in user input
   *
   * FIX: MEDIUM PRIORITY - Normalizes Unicode to prevent homograph attacks
   */
  private normalizeUnicode(input: string): string {
    // Use NFC (Canonical Decomposition, followed by Canonical Composition)
    return input.normalize('NFC');
  }

  /**
   * Format a single element file
   * Refactored to reduce cognitive complexity by extracting methods
   */
  async formatFile(filePath: string): Promise<FormatterResult> {
    // FIX: MEDIUM - Normalize Unicode in file path
    filePath = this.normalizeUnicode(filePath);
    const result: FormatterResult = {
      success: false,
      filePath,
      issues: [],
      fixed: []
    };

    try {
      // Check file size
      const stats = await this.validateFileSize(filePath, result);
      if (stats === null) return result;

      // Read and normalize content
      const content = await this.readAndNormalizeFile(filePath, stats);

      // Format content
      const formatted = await this.formatContent(filePath, content, result);

      // Validate if needed
      if (!await this.validateFormattedContent(formatted, filePath, result)) {
        return result;
      }

      // Create backup if requested
      await this.createBackupIfNeeded(filePath, result);

      // Write formatted content
      await this.writeFormattedFile(filePath, formatted, result);

      result.success = true;
      result.fixed.push(`Formatted file written to ${this.getOutputPath(filePath)}`);

    } catch (error) {
      this.handleFormatError(error, result, filePath);
    }

    return result;
  }

  /**
   * Validate file size
   */
  private async validateFileSize(filePath: string, result: FormatterResult): Promise<any> {
    const stats = await fs.stat(filePath);
    if (stats.size > this.options.maxFileSize) {
      result.error = `File size (${stats.size} bytes) exceeds maximum allowed (${this.options.maxFileSize} bytes)`;
      result.issues.push('File too large for processing');
      return null;
    }
    return stats;
  }

  /**
   * Read and normalize file content
   */
  private async readAndNormalizeFile(filePath: string, stats: any): Promise<string> {
    let content = await fs.readFile(filePath, 'utf-8');
    content = this.normalizeUnicode(content);

    SecurityMonitor.logSecurityEvent({
      type: 'FILE_COPIED',
      severity: 'LOW',
      source: 'ElementFormatter',
      details: `Processing file: ${filePath} (${stats.size} bytes)`
    });

    return content;
  }

  /**
   * Format content based on element type
   */
  private async formatContent(filePath: string, content: string, result: FormatterResult): Promise<string> {
    const elementType = this.detectElementType(filePath);

    if (elementType === ElementType.MEMORY) {
      return await this.formatMemory(content, filePath, result);
    } else {
      return await this.formatStandardElement(content, result);
    }
  }

  /**
   * Validate formatted content if validation is enabled
   */
  private async validateFormattedContent(formatted: string, filePath: string, result: FormatterResult): Promise<boolean> {
    if (!this.options.validate) return true;

    try {
      const elementType = this.detectElementType(filePath);
      const yamlToValidate = elementType === ElementType.MEMORY
        ? `---\n${formatted}\n---\n`
        : formatted;

      // FIX (Issue #1211): Local files are pre-trusted (same as MemoryManager PR #1207)
      SecureYamlParser.parse(yamlToValidate, {
        validateContent: false,
        validateFields: false
      });

      result.fixed.push('YAML validation passed');
      return true;
    } catch (error) {
      result.issues.push(`YAML validation failed: ${error}`);
      result.success = false;
      SecurityMonitor.logSecurityEvent({
        type: 'YAML_PARSING_WARNING',
        severity: 'MEDIUM',
        source: 'ElementFormatter',
        details: `YAML validation failed for ${filePath}`,
        additionalData: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      return false;
    }
  }

  /**
   * Create backup if requested
   */
  private async createBackupIfNeeded(filePath: string, result: FormatterResult): Promise<void> {
    if (!this.options.backup) return;

    const backupPath = filePath + '.backup';
    await fs.copyFile(filePath, backupPath);
    result.backupPath = backupPath;
    result.fixed.push(`Created backup at ${backupPath}`);

    SecurityMonitor.logSecurityEvent({
      type: 'FILE_COPIED',
      severity: 'LOW',
      source: 'ElementFormatter',
      details: `Backup created: ${backupPath}`,
      additionalData: {
        originalFile: filePath,
        backupFile: backupPath
      }
    });
  }

  /**
   * Write formatted content to file
   */
  private async writeFormattedFile(filePath: string, formatted: string, result: FormatterResult): Promise<void> {
    const outputPath = this.getOutputPath(filePath);
    await fs.writeFile(outputPath, formatted, 'utf-8');

    SecurityMonitor.logSecurityEvent({
      type: 'FILE_COPIED',
      severity: 'LOW',
      source: 'ElementFormatter',
      details: `File formatted successfully: ${outputPath}`,
      additionalData: {
        inputPath: filePath,
        outputPath,
        backup: result.backupPath || 'none'
      }
    });
  }

  /**
   * Handle formatting errors
   */
  private handleFormatError(error: unknown, result: FormatterResult, filePath: string): void {
    if (error instanceof Error) {
      result.error = error.message;

      if (error.message.includes('ENOENT')) {
        result.issues.push('File not found');
      } else if (error.message.includes('EACCES')) {
        result.issues.push('Permission denied');
      } else if (error.message.includes('Path traversal')) {
        result.issues.push('Security: Path traversal attempt blocked');
      }
    } else {
      result.error = String(error);
    }

    logger.error('Failed to format file', {
      filePath,
      error: result.error,
      errorType: error instanceof Error ? error.constructor.name : typeof error
    });
  }

  /**
   * Format multiple files
   *
   * FIX: Added parallel processing with concurrency limit for better performance
   */
  async formatFiles(filePaths: string[], concurrencyLimit = 5): Promise<FormatterResult[]> {
    const results: FormatterResult[] = [];

    // Process files in batches for controlled parallelism
    for (let i = 0; i < filePaths.length; i += concurrencyLimit) {
      const batch = filePaths.slice(i, i + concurrencyLimit);
      const batchResults = await Promise.all(
        batch.map(filePath => this.formatFile(filePath))
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Format all elements of a specific type
   */
  async formatElementType(elementType: ElementType, portfolioDir: string): Promise<FormatterResult[]> {
    const results: FormatterResult[] = [];
    const elementDir = path.join(portfolioDir, elementType);

    try {
      if (elementType === ElementType.MEMORY) {
        // Handle memory-specific structure (date folders)
        results.push(...await this.formatMemoryDirectory(elementDir));
      } else {
        // Handle standard element structure (.md files in root)
        results.push(...await this.formatStandardDirectory(elementDir));
      }
    } catch (error) {
      logger.error(`Failed to format element type: ${elementType}`, { error });
    }

    return results;
  }

  /**
   * Format memory elements in date folder structure
   */
  private async formatMemoryDirectory(memoryDir: string): Promise<FormatterResult[]> {
    const results: FormatterResult[] = [];

    try {
      const entries = await fs.readdir(memoryDir, { withFileTypes: true });

      // Process root .yaml files
      for (const entry of entries) {
        if (!entry.isDirectory() && entry.name.endsWith('.yaml')) {
          const filePath = path.join(memoryDir, entry.name);
          results.push(await this.formatFile(filePath));
        }
      }

      // Process date folders
      // Use RegExp.test() directly as per SonarCloud S6594
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;
      const dateFolders = entries.filter(e =>
        e.isDirectory() && datePattern.test(e.name)
      );

      for (const folder of dateFolders) {
        const folderPath = path.join(memoryDir, folder.name);
        const files = await fs.readdir(folderPath);

        for (const file of files.filter(f => f.endsWith('.yaml'))) {
          const filePath = path.join(folderPath, file);
          results.push(await this.formatFile(filePath));
        }
      }
    } catch (error) {
      logger.error('Failed to format memory directory', { memoryDir, error });
    }

    return results;
  }

  /**
   * Format standard elements (.md files)
   */
  private async formatStandardDirectory(elementDir: string): Promise<FormatterResult[]> {
    const results: FormatterResult[] = [];

    try {
      const files = await fs.readdir(elementDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      for (const file of mdFiles) {
        const filePath = path.join(elementDir, file);
        results.push(await this.formatFile(filePath));
      }
    } catch (error) {
      logger.error('Failed to format standard directory', { elementDir, error });
    }

    return results;
  }

  /**
   * Format a memory YAML file
   * Refactored to reduce cognitive complexity
   */
  private async formatMemory(content: string, filePath: string, result: FormatterResult): Promise<string> {
    try {
      const data = await this.parseMemoryContent(content);

      // Process entries if they exist
      if (data.entries && Array.isArray(data.entries)) {
        await this.processMemoryEntries(data.entries, data, result);
      }

      // Ensure proper structure
      this.ensureMemoryStructure(data, filePath, result);

      // Format as clean YAML
      return this.formatAsYaml(data);

    } catch (error) {
      result.issues.push(`Failed to parse YAML: ${error}`);
      return content; // Return original content if we can't parse it
    }
  }

  /**
   * Parse memory content using SecureYamlParser
   */
  private async parseMemoryContent(content: string): Promise<any> {
    const wrappedContent = `---\n${content}\n---\n`;
    // FIX (Issue #1211): Local files are pre-trusted (same as MemoryManager PR #1207)
    const parsed = SecureYamlParser.parse(wrappedContent, {
      validateContent: false,
      validateFields: false
    });
    return parsed.data;
  }

  /**
   * Process memory entries to fix issues
   */
  private async processMemoryEntries(entries: any[], data: any, result: FormatterResult): Promise<void> {
    for (const entry of entries) {
      if (typeof entry.content !== 'string') continue;

      // Normalize Unicode
      entry.content = this.normalizeUnicode(entry.content);

      // Handle embedded metadata
      if (this.hasEmbeddedMetadata(entry.content)) {
        this.handleEmbeddedMetadata(entry, data, result);
      } else {
        this.unescapeEntryContent(entry, result);
      }
    }
  }

  /**
   * Check if content has embedded metadata
   */
  private hasEmbeddedMetadata(content: string): boolean {
    // Check for both actual newlines and escaped newlines
    // Using String.raw to properly handle escape sequences (SonarCloud compliance)
    const actualNewline = '---\n';
    const escapedNewline = String.raw`---\n`;  // This represents the literal string "---\n"

    return content.includes(actualNewline) ||
           content.includes(escapedNewline);
  }

  /**
   * Handle embedded metadata extraction
   */
  private handleEmbeddedMetadata(entry: any, data: any, result: FormatterResult): void {
    result.issues.push('Found embedded metadata in content');

    // First unescape the content to make it parseable
    const unescapedContent = this.unescapeNewlines(entry.content);

    // Then try to extract metadata from the unescaped content
    const extracted = this.extractEmbeddedMetadata(unescapedContent);

    if (extracted.metadata) {
      // Merge extracted metadata to top level
      Object.assign(data, extracted.metadata);
      // Update entry with clean content
      entry.content = extracted.content;
      result.fixed.push('Extracted embedded metadata to top level', 'Unescaped newlines in content');
    } else {
      // Just unescape if no metadata found
      entry.content = unescapedContent;
      result.fixed.push('Unescaped newlines in content');
    }
  }

  /**
   * Unescape entry content
   */
  private unescapeEntryContent(entry: any, result: FormatterResult): void {
    const original = entry.content;
    entry.content = this.unescapeNewlines(entry.content);
    if (original !== entry.content) {
      result.fixed.push('Unescaped newlines in content');
    }
  }

  /**
   * Ensure memory has proper structure
   * FIX (Issue #1211): Derive name from filename instead of auto-generated entry ID
   */
  private ensureMemoryStructure(data: any, filePath: string, result: FormatterResult): void {
    if (!data.name) {
      // Derive name from filename, removing extension and normalizing
      const filename = path.basename(filePath, path.extname(filePath));
      data.name = filename;
      result.fixed.push(`Added name field from filename: ${filename}`);
    }
  }

  /**
   * Format data as clean YAML
   * FIX: Improved YAML formatting for consistency and special character handling
   */
  private formatAsYaml(data: any): string {
    return yaml.dump(data, {
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
      quotingType: '"',
      forceQuotes: false,
      // Use block scalar style for strings containing newlines
      // This preserves formatting while keeping tabs/returns readable
      styles: {
        '!!str': (str: string) => {
          // Use block scalar for multiline strings
          if (typeof str === 'string' && str.includes('\n')) {
            return 'literal';
          }
          // Use default (quoted) for other strings, including those with tabs/returns
          return 'plain';
        }
      }
    });
  }

  /**
   * Format a standard element (markdown with frontmatter)
   */
  private async formatStandardElement(content: string, result: FormatterResult): Promise<string> {
    try {
      // Split frontmatter and content using RegExp.exec() as per SonarCloud S6594
      const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
      const match = frontmatterRegex.exec(content);

      if (!match) {
        result.issues.push('No frontmatter found');
        return content;
      }

      const [, frontmatterStr, body] = match;

      // FIX: HIGH - Use SecureYamlParser for frontmatter
      // FIX (Issue #1211): Local files are pre-trusted (same as MemoryManager PR #1207)
      const tempDoc = `---\n${frontmatterStr}\n---\n`;
      const parsed = SecureYamlParser.parse(tempDoc, {
        validateContent: false,
        validateFields: false
      });
      const frontmatter = parsed.data as any;

      // Clean frontmatter
      if (frontmatter.content && typeof frontmatter.content === 'string') {
        frontmatter.content = this.unescapeNewlines(frontmatter.content);
        result.fixed.push('Unescaped newlines in frontmatter content');
      }

      // Clean body
      const cleanBody = this.unescapeNewlines(body);
      if (body !== cleanBody) {
        result.fixed.push('Unescaped newlines in body');
      }

      // Reconstruct with clean YAML
      const cleanFrontmatter = yaml.dump(frontmatter, {
        lineWidth: 120,
        noRefs: true,
        sortKeys: false
      });

      return `---\n${cleanFrontmatter}---\n${cleanBody}`;

    } catch (error) {
      result.issues.push(`Failed to parse element: ${error}`);
      return content;
    }
  }

  /**
   * Extract embedded metadata from content string
   *
   * FIX: Security hotspot - Replaced regex vulnerable to catastrophic backtracking
   * with a linear-time string parsing approach to prevent ReDoS attacks
   */
  private extractEmbeddedMetadata(content: string): { metadata: any; content: string } {
    // Content should already be unescaped by the time we get here
    const unescaped = content;

    // Use indexOf for linear-time parsing instead of regex to prevent ReDoS
    const startMarker = '---';
    const endMarker = '\n---\n';

    // Try to find the start marker anywhere in the content
    const trimmed = unescaped.trim();
    const startIdx = trimmed.indexOf(startMarker);

    if (startIdx === -1) {
      return { metadata: null, content };
    }

    // Find the starting position after first marker
    const startPos = startIdx + startMarker.length;

    // Look for the end marker
    const endPos = trimmed.indexOf(endMarker, startPos);

    if (endPos === -1) {
      // Try alternative end marker for edge cases
      const altEndMarker = '---\n';
      const altEndPos = trimmed.indexOf(altEndMarker, startPos + 1);
      if (altEndPos === -1) {
        return { metadata: null, content };
      }
      // Use alternative end position
      const metadataStr = trimmed.slice(startPos, altEndPos).trim();
      const cleanContent = trimmed.slice(altEndPos + altEndMarker.length).trim();

      try {
        // FIX (Issue #1211): Local files are pre-trusted (same as MemoryManager PR #1207)
        const tempDoc = `---\n${metadataStr}\n---\n`;
        const parsed = SecureYamlParser.parse(tempDoc, {
          validateContent: false,
          validateFields: false
        });
        return { metadata: parsed.data, content: cleanContent };
      } catch {
        return { metadata: null, content };
      }
    }

    // Extract metadata and content sections
    const metadataStr = unescaped.slice(startPos, endPos).trim();
    const cleanContent = unescaped.slice(endPos + endMarker.length).trim();

    try {
      // FIX: HIGH - Use SecureYamlParser for metadata extraction
      // FIX (Issue #1211): Local files are pre-trusted (same as MemoryManager PR #1207)
      const tempDoc = `---\n${metadataStr}\n---\n`;
      const parsed = SecureYamlParser.parse(tempDoc, {
        validateContent: false,
        validateFields: false
      });
      const metadata = parsed.data;

      return { metadata, content: cleanContent };
    } catch {
      // If YAML parsing fails, return as-is
      return { metadata: null, content };
    }
  }

  /**
   * Unescape newline characters (public static utility)
   * Using replaceAll as per SonarCloud S7781
   * Using character map to avoid escape sequence issues
   *
   * FIX (Issue #874): Public static method for use in MCP tool outputs
   */
  public static unescapeContent(text: string): string {
    // Map of escape sequences to their actual characters
    // This avoids SonarCloud's String.raw warnings
    const escapeMap: Array<[string, string]> = [
      [String.raw`\n`, '\n'],  // Newline
      [String.raw`\r`, '\r'],  // Carriage return
      [String.raw`\t`, '\t'],  // Tab
      [String.raw`\\`, '\\']   // Backslash (must be last to avoid double-unescaping)
    ];

    let result = text;
    for (const [escaped, actual] of escapeMap) {
      result = result.replaceAll(escaped, actual);
    }
    return result;
  }

  /**
   * Unescape newline characters (private instance method)
   * Using replaceAll as per SonarCloud S7781
   * Using character map to avoid escape sequence issues
   */
  private unescapeNewlines(text: string): string {
    return ElementFormatter.unescapeContent(text);
  }

  /**
   * Detect element type from file path
   * Enhanced with more explicit and robust path matching
   */
  private detectElementType(filePath: string): ElementType {
    // Normalize path separators for cross-platform compatibility
    const normalizedPath = filePath.replaceAll('\\', '/');

    // Map of element type directory names to ElementType enum values
    // More explicit than iterating through enum values
    const elementTypeMap: Record<string, ElementType> = {
      'personas': ElementType.PERSONA,
      'skills': ElementType.SKILL,
      'templates': ElementType.TEMPLATE,
      'agents': ElementType.AGENT,
      'memories': ElementType.MEMORY,
      'ensembles': ElementType.ENSEMBLE
    };

    // Split into path segments for accurate matching
    const segments = normalizedPath.split('/').filter(s => s.length > 0);

    // Find the element type by checking each segment against our explicit map
    for (const segment of segments) {
      const elementType = elementTypeMap[segment.toLowerCase()];
      if (elementType) {
        return elementType;
      }
    }

    // Fallback: Use file extension as a hint
    // .yaml files are typically memories, .md files are standard elements
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      return ElementType.MEMORY;
    }

    // Default to PERSONA for .md files or unknown types
    return ElementType.PERSONA;
  }

  /**
   * Get output path for formatted file
   *
   * FIX: Added path traversal protection to prevent directory escape attacks
   */
  private getOutputPath(filePath: string): string {
    if (this.options.inPlace) {
      return filePath;
    }

    if (this.options.outputDir) {
      // Security: Validate output directory to prevent path traversal
      // FIX: MEDIUM - Normalize Unicode in filename
      const filename = this.normalizeUnicode(path.basename(filePath));
      const safePath = path.resolve(this.options.outputDir, filename);
      const expectedDir = path.resolve(this.options.outputDir);

      // Ensure the resolved path is within the expected directory
      if (!safePath.startsWith(expectedDir)) {
        // FIX: LOW - Use SecurityMonitor for audit logging
        SecurityMonitor.logSecurityEvent({
          type: 'PATH_TRAVERSAL_ATTEMPT',
          severity: 'HIGH',
          source: 'ElementFormatter',
          details: `Path traversal blocked: ${filename}`,
          additionalData: {
            attemptedPath: filename,
            expectedDir,
            resolvedPath: safePath
          }
        });
        throw new Error(`Path traversal attempt detected: ${filename}`);
      }

      return safePath;
    }

    // Default: add .formatted before extension
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    return path.join(dir, `${base}.formatted${ext}`);
  }
}