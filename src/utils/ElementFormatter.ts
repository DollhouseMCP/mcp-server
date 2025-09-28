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

export interface ElementFormatterOptions {
  /** Whether to create backup files before formatting */
  backup?: boolean;
  /** Whether to fix files in place or create new files */
  inPlace?: boolean;
  /** Whether to validate YAML after formatting */
  validate?: boolean;
  /** Custom output directory for formatted files */
  outputDir?: string;
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
  private options: Required<ElementFormatterOptions>;

  constructor(options: ElementFormatterOptions = {}) {
    this.options = {
      backup: options.backup ?? true,
      inPlace: options.inPlace ?? false,
      validate: options.validate ?? true,
      outputDir: options.outputDir ?? ''
    };
  }

  /**
   * Format a single element file
   */
  async formatFile(filePath: string): Promise<FormatterResult> {
    const result: FormatterResult = {
      success: false,
      filePath,
      issues: [],
      fixed: []
    };

    try {
      // Read the file
      const content = await fs.readFile(filePath, 'utf-8');

      // Detect element type from path
      const elementType = this.detectElementType(filePath);

      // Format based on type
      let formatted: string;
      if (elementType === ElementType.MEMORY) {
        formatted = await this.formatMemory(content, result);
      } else {
        formatted = await this.formatStandardElement(content, result);
      }

      // Validate if requested
      if (this.options.validate) {
        try {
          yaml.load(formatted);
          result.fixed.push('YAML validation passed');
        } catch (error) {
          result.issues.push(`YAML validation failed: ${error}`);
          result.success = false;
          return result;
        }
      }

      // Create backup if requested
      if (this.options.backup && this.options.inPlace) {
        const backupPath = filePath + '.backup';
        await fs.copyFile(filePath, backupPath);
        result.backupPath = backupPath;
        result.fixed.push(`Created backup at ${backupPath}`);
      }

      // Write formatted content
      const outputPath = this.getOutputPath(filePath);
      await fs.writeFile(outputPath, formatted, 'utf-8');

      result.success = true;
      result.fixed.push(`Formatted file written to ${outputPath}`);

    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      logger.error('Failed to format file', { filePath, error: result.error });
    }

    return result;
  }

  /**
   * Format multiple files
   */
  async formatFiles(filePaths: string[]): Promise<FormatterResult[]> {
    const results: FormatterResult[] = [];

    for (const filePath of filePaths) {
      const result = await this.formatFile(filePath);
      results.push(result);
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
      const dateFolders = entries.filter(e =>
        e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)
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
   */
  private async formatMemory(content: string, result: FormatterResult): Promise<string> {
    try {
      // Parse existing YAML
      const data = yaml.load(content) as any;

      // Check for malformed structure
      if (data.entries && Array.isArray(data.entries)) {
        for (const entry of data.entries) {
          if (typeof entry.content === 'string') {
            // Check if metadata is embedded in content
            if (entry.content.includes('---\n') || entry.content.includes('---\\n')) {
              result.issues.push('Found embedded metadata in content');

              // Extract metadata from content
              const extracted = this.extractEmbeddedMetadata(entry.content);
              if (extracted.metadata) {
                // Merge extracted metadata to top level
                Object.assign(data, extracted.metadata);
                // Clean the content
                entry.content = this.unescapeNewlines(extracted.content);
                result.fixed.push('Extracted embedded metadata to top level');
                result.fixed.push('Unescaped newlines in content');
              }
            } else {
              // Just unescape newlines
              const original = entry.content;
              entry.content = this.unescapeNewlines(entry.content);
              if (original !== entry.content) {
                result.fixed.push('Unescaped newlines in content');
              }
            }
          }
        }
      }

      // Ensure proper structure
      if (!data.name && data.entries?.[0]?.id) {
        data.name = data.entries[0].id;
        result.fixed.push('Added name field from entry ID');
      }

      // Format as clean YAML
      const formatted = yaml.dump(data, {
        lineWidth: 120,
        noRefs: true,
        sortKeys: false,
        quotingType: '"',
        forceQuotes: false
      });

      return formatted;

    } catch (error) {
      result.issues.push(`Failed to parse YAML: ${error}`);
      // Return original content if we can't parse it
      return content;
    }
  }

  /**
   * Format a standard element (markdown with frontmatter)
   */
  private async formatStandardElement(content: string, result: FormatterResult): Promise<string> {
    try {
      // Split frontmatter and content
      const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

      if (!match) {
        result.issues.push('No frontmatter found');
        return content;
      }

      const [, frontmatterStr, body] = match;

      // Parse frontmatter
      const frontmatter = yaml.load(frontmatterStr) as any;

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
    // Handle both actual newlines and escaped newlines
    const unescaped = content.replace(/\\n/g, '\n');

    // Use indexOf for linear-time parsing instead of regex to prevent ReDoS
    const startMarker = '---';
    const endMarker = '\n---\n';

    // Check if content starts with frontmatter marker
    if (!unescaped.startsWith(startMarker)) {
      return { metadata: null, content };
    }

    // Find the starting position after first marker
    const startPos = startMarker.length;

    // Look for the end marker
    const endPos = unescaped.indexOf(endMarker, startPos);

    if (endPos === -1) {
      // No closing marker found
      return { metadata: null, content };
    }

    // Extract metadata and content sections
    const metadataStr = unescaped.slice(startPos, endPos).trim();
    const cleanContent = unescaped.slice(endPos + endMarker.length).trim();

    try {
      const metadata = yaml.load(metadataStr);
      return { metadata, content: cleanContent };
    } catch {
      // If YAML parsing fails, return as-is
      return { metadata: null, content };
    }
  }

  /**
   * Unescape newline characters
   */
  private unescapeNewlines(text: string): string {
    return text
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
  }

  /**
   * Detect element type from file path
   */
  private detectElementType(filePath: string): ElementType {
    const normalizedPath = filePath.replace(/\\/g, '/');

    for (const [, value] of Object.entries(ElementType)) {
      if (normalizedPath.includes(`/${value}/`)) {
        return value as ElementType;
      }
    }

    // Default based on file extension
    return filePath.endsWith('.yaml') ? ElementType.MEMORY : ElementType.PERSONA;
  }

  /**
   * Get output path for formatted file
   */
  private getOutputPath(filePath: string): string {
    if (this.options.inPlace) {
      return filePath;
    }

    if (this.options.outputDir) {
      const filename = path.basename(filePath);
      return path.join(this.options.outputDir, filename);
    }

    // Default: add .formatted before extension
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    return path.join(dir, `${base}.formatted${ext}`);
  }
}