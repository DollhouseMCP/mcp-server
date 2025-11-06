/**
 * Install AI customization elements from collection with source priority support
 * Supports all element types: personas, skills, templates, agents, memories, ensembles
 *
 * FEATURE (Issue #1447): Added source priority support - checks local → GitHub → collection
 * in priority order during installation to prevent duplicate installations.
 *
 * SECURITY FIX (2025-08-12): Fixed critical vulnerability where content was written to disk
 * BEFORE validation was complete. This could allow malicious content to persist on the
 * filesystem even when validation failed. The fix implements:
 *
 * 1. VALIDATE-BEFORE-WRITE PATTERN: All content validation (ContentValidator.sanitizePersonaContent,
 *    SecureYamlParser.safeMatter, metadata validation, etc.) is now performed BEFORE any disk operations.
 *
 * 2. ATOMIC FILE OPERATIONS: Uses temporary file + atomic rename to prevent partial file corruption
 *    and ensure complete cleanup on any failure during the write process.
 *
 * 3. GUARANTEED CLEANUP: If any part of the write operation fails, temporary files are automatically
 *    cleaned up, preventing orphaned malicious content on the filesystem.
 *
 * The vulnerability existed in installContent() where fs.writeFile() was called after validation
 * but before final success confirmation, creating a window where malicious content could persist.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { GitHubClient } from './GitHubClient.js';
import { IElementMetadata } from '../types/elements/IElement.js';
import { validatePath, validateFilename, validateContentSize } from '../security/InputValidator.js';
import { SECURITY_LIMITS } from '../security/constants.js';
import { ContentValidator } from '../security/contentValidator.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { SecurityError } from '../errors/SecurityError.js';
import { PortfolioManager, ElementType } from '../portfolio/PortfolioManager.js';
import {
  getSourcePriorityConfig,
  SourcePriorityConfig,
  ElementSource,
  getSourceDisplayName
} from '../config/sourcePriority.js';
import { UnifiedIndexManager } from '../portfolio/UnifiedIndexManager.js';

/**
 * Result of an element installation operation
 */
export interface InstallResult {
  /** Whether the installation succeeded */
  success: boolean;

  /** User-friendly message describing the result */
  message: string;

  /** Element metadata (if installation succeeded) */
  metadata?: IElementMetadata;

  /** Element type */
  elementType?: ElementType;

  /** Filename of the installed element */
  filename?: string;

  /** Source from which the element was installed */
  source?: ElementSource;

  /** Whether the element already existed and was skipped */
  alreadyExists?: boolean;
}

/**
 * Options for element installation
 */
export interface InstallOptions {
  /** Preferred source to install from (overrides priority order) */
  preferredSource?: ElementSource;

  /** Force overwrite even if element exists locally */
  force?: boolean;

  /** Enable fallback to next source if current source fails */
  fallbackOnError?: boolean;
}

export class ElementInstaller {
  private githubClient: GitHubClient;
  private portfolioManager: PortfolioManager;
  private baseUrl = 'https://api.github.com/repos/DollhouseMCP/collection/contents';

  // Source priority support (Issue #1447)
  private readonly sourcePriorityConfig: SourcePriorityConfig;
  private readonly unifiedIndexManager: UnifiedIndexManager;

  constructor(githubClient: GitHubClient) {
    this.githubClient = githubClient;
    this.portfolioManager = PortfolioManager.getInstance();
    this.sourcePriorityConfig = getSourcePriorityConfig();
    this.unifiedIndexManager = UnifiedIndexManager.getInstance();
  }

  /**
   * Install element with source priority support (Issue #1447)
   *
   * Checks sources in priority order (local → GitHub → collection by default):
   * 1. Checks if element already exists locally (prevents duplicate installation)
   * 2. If not local, attempts GitHub portfolio (if specified)
   * 3. Falls back to collection (existing behavior)
   *
   * @param elementName - Name of the element to install
   * @param elementType - Type of element (persona, skill, etc.)
   * @param collectionPath - Path in collection (for collection source)
   * @param options - Installation options
   * @returns InstallResult with success status and details
   *
   * @example
   * // Install from best available source (checks local → GitHub → collection)
   * const result = await installer.installElement('creative-writer', ElementType.PERSONA,
   *   'library/personas/writing/creative-writer.md');
   *
   * @example
   * // Force install from collection even if exists locally
   * const result = await installer.installElement('creative-writer', ElementType.PERSONA,
   *   'library/personas/writing/creative-writer.md', { force: true });
   *
   * @example
   * // Install from specific source
   * const result = await installer.installElement('creative-writer', ElementType.PERSONA,
   *   'library/personas/writing/creative-writer.md',
   *   { preferredSource: ElementSource.COLLECTION });
   */
  async installElement(
    elementName: string,
    elementType: ElementType,
    collectionPath: string,
    options: InstallOptions = {}
  ): Promise<InstallResult> {
    const {
      preferredSource,
      force = false,
      fallbackOnError = this.sourcePriorityConfig.fallbackOnError
    } = options;

    // Step 1: Check if element already exists locally (unless force = true)
    if (!force) {
      const localExists = await this.checkLocalElement(elementName, elementType);
      if (localExists) {
        return {
          success: false,
          message: `Element "${elementName}" already exists in Local Portfolio. Use force=true to overwrite.`,
          alreadyExists: true,
          source: ElementSource.LOCAL
        };
      }
    }

    // Step 2: Determine source priority order
    let sourcePriority: ElementSource[];
    if (preferredSource) {
      // Preferred source first, then remaining sources in default order
      sourcePriority = [
        preferredSource,
        ...this.sourcePriorityConfig.priority.filter(s => s !== preferredSource)
      ];
    } else {
      sourcePriority = this.sourcePriorityConfig.priority;
    }

    // Step 3: Try sources in priority order
    const errors: Array<{ source: ElementSource; error: Error }> = [];

    for (const source of sourcePriority) {
      try {
        const result = await this.installFromSource(
          source,
          elementName,
          elementType,
          collectionPath
        );

        if (result.success) {
          result.source = source;
          result.message = `${result.message}\n\nSource: ${getSourceDisplayName(source)}`;
          return result;
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push({ source, error: err });

        if (!fallbackOnError) {
          // Don't try other sources, fail immediately
          throw new Error(
            `Installation from ${getSourceDisplayName(source)} failed: ${err.message}`
          );
        }
      }
    }

    // All sources failed
    const errorSummary = errors
      .map(({ source, error }) => `${getSourceDisplayName(source)}: ${error.message}`)
      .join('\n');

    throw new Error(
      `Failed to install element from all sources:\n${errorSummary}`
    );
  }

  /**
   * Install element from a specific source
   *
   * @param source - Source to install from
   * @param elementName - Name of element
   * @param elementType - Type of element
   * @param collectionPath - Path in collection (for collection source)
   * @returns InstallResult
   * @private
   */
  private async installFromSource(
    source: ElementSource,
    elementName: string,
    elementType: ElementType,
    collectionPath: string
  ): Promise<InstallResult> {
    switch (source) {
      case ElementSource.LOCAL:
        // Local check already done in installElement, skip
        return {
          success: false,
          message: 'Element not found in local portfolio'
        };

      case ElementSource.GITHUB:
        return await this.installFromGitHub(elementName, elementType);

      case ElementSource.COLLECTION:
        return await this.installFromCollection(collectionPath);

      default:
        throw new Error(`Unknown source: ${source}`);
    }
  }

  /**
   * Check if element exists locally
   *
   * @param elementName - Name of element to check
   * @param elementType - Type of element
   * @returns true if element exists locally
   * @private
   */
  private async checkLocalElement(elementName: string, elementType: ElementType): Promise<boolean> {
    try {
      // Use UnifiedIndexManager to search local portfolio
      const results = await this.unifiedIndexManager.search({
        query: elementName,
        includeLocal: true,
        includeGitHub: false,
        includeCollection: false,
        elementType
      });

      // Check if any result matches the element name exactly
      return results.some(
        result =>
          result.source === 'local' &&
          result.entry.name.toLowerCase() === elementName.toLowerCase()
      );
    } catch (error) {
      // If index check fails, fall back to filesystem check
      const elementDir = this.portfolioManager.getElementDir(elementType);
      const files = await fs.readdir(elementDir).catch(() => []);

      // Check if any file matches the element name
      return files.some(file => {
        const nameWithoutExt = file.replace(/\.(md|yaml|yml)$/, '');
        return nameWithoutExt.toLowerCase() === elementName.toLowerCase();
      });
    }
  }

  /**
   * Install element from GitHub portfolio (Issue #1447)
   *
   * Fetches element from user's GitHub dollhouse-portfolio repository.
   *
   * @param elementName - Name of element to install
   * @param elementType - Type of element
   * @returns InstallResult
   * @private
   */
  private async installFromGitHub(
    elementName: string,
    elementType: ElementType
  ): Promise<InstallResult> {
    try {
      // Search GitHub portfolio for the element
      const results = await this.unifiedIndexManager.search({
        query: elementName,
        includeLocal: false,
        includeGitHub: true,
        includeCollection: false,
        elementType
      });

      // Find exact match
      const match = results.find(
        result =>
          result.source === 'github' &&
          result.entry.name.toLowerCase() === elementName.toLowerCase()
      );

      if (!match || !match.entry.githubDownloadUrl) {
        return {
          success: false,
          message: `Element "${elementName}" not found in GitHub portfolio`
        };
      }

      // Fetch content from GitHub
      const response = await fetch(match.entry.githubDownloadUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch from GitHub: ${response.statusText}`);
      }

      const content = await response.text();

      // SECURITY: Validate content size
      validateContentSize(content, SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES);

      // SECURITY: Sanitize content
      const sanitizedContent = ContentValidator.sanitizePersonaContent(content);

      // SECURITY: Parse and validate YAML
      let parsed;
      try {
        parsed = SecureYamlParser.safeMatter(sanitizedContent);
      } catch (error) {
        if (error instanceof SecurityError) {
          throw new Error(`Security threat in content: ${error.message}`);
        }
        throw error;
      }

      const metadata = parsed.data as IElementMetadata;

      // SECURITY: Validate metadata
      const metadataValidation = ContentValidator.validateMetadata(metadata);
      if (!metadataValidation.isValid) {
        throw new Error(
          `Security validation failed: ${metadataValidation.detectedPatterns?.join(', ')}`
        );
      }

      // SECURITY: Validate required fields
      if (!metadata.name || !metadata.description) {
        throw new Error('Invalid content: missing required name or description');
      }

      // Generate filename
      const filename = validateFilename(`${elementName}.md`);
      const elementDir = this.portfolioManager.getElementDir(elementType);
      const localPath = path.join(elementDir, filename);

      // SECURITY: Atomic write
      await this.atomicWriteFile(localPath, sanitizedContent);

      return {
        success: true,
        message: 'Element installed successfully from GitHub portfolio',
        metadata,
        filename,
        elementType
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        message: `Failed to install from GitHub: ${err.message}`
      };
    }
  }

  /**
   * Install element from collection (refactored from installContent)
   *
   * @param collectionPath - Path in collection
   * @returns InstallResult
   * @private
   */
  private async installFromCollection(collectionPath: string): Promise<InstallResult> {
    // SECURITY: Validate and sanitize the input path first
    const sanitizedPath = validatePath(collectionPath);

    // SECURITY: Detect element type from path structure and validate format
    // Expected format: library/[element-type]/[category]/[element].md
    const pathParts = sanitizedPath.split('/');
    if (pathParts.length < 3 || pathParts[0] !== 'library') {
      throw new Error('Invalid collection path format. Expected: library/[element-type]/[category]/[element].md');
    }

    const elementTypeStr = pathParts[1];
    const elementType = this.getElementTypeFromString(elementTypeStr);

    // SECURITY: Ensure the path ends with .md to prevent arbitrary file types
    if (!sanitizedPath.endsWith('.md')) {
      throw new Error('Invalid file type. Only .md files are allowed.');
    }

    // STEP 1: FETCH CONTENT INTO MEMORY (NO DISK OPERATIONS YET)
    const url = `${this.baseUrl}/${sanitizedPath}`;
    const data = await this.githubClient.fetchFromGitHub(url);

    if (data.type !== 'file') {
      throw new Error('Path does not point to a file');
    }

    // SECURITY: Check file size before downloading to prevent DoS attacks
    if (data.size > SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES) {
      throw new Error(`File too large (${data.size} bytes, max ${SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES} bytes)`);
    }

    // Decode Base64 content into memory only
    const content = Buffer.from(data.content, 'base64').toString('utf-8');

    // STEP 2: PERFORM ALL VALIDATION BEFORE ANY DISK OPERATIONS
    // This is the critical security fix - validate everything in memory first

    // SECURITY: Validate content size after decoding
    validateContentSize(content, SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES);

    // SECURITY: Sanitize content for security threats (XSS, injection, etc.)
    const sanitizedContent = ContentValidator.sanitizePersonaContent(content);

    // SECURITY: Use secure YAML parser to prevent YAML bombs and injection
    let parsed;
    try {
      parsed = SecureYamlParser.safeMatter(sanitizedContent);
    } catch (error) {
      if (error instanceof SecurityError) {
        throw new Error(`Security threat in content: ${error.message}`);
      }
      throw error;
    }

    const metadata = parsed.data as IElementMetadata;

    // SECURITY: Additional metadata validation for injection attacks
    const metadataValidation = ContentValidator.validateMetadata(metadata);
    if (!metadataValidation.isValid) {
      throw new Error(`Security validation failed: ${metadataValidation.detectedPatterns?.join(', ')}`);
    }

    // SECURITY: Validate required metadata fields
    if (!metadata.name || !metadata.description) {
      throw new Error('Invalid content: missing required name or description');
    }

    // SECURITY: Generate and validate local filename to prevent path traversal
    const originalFilename = sanitizedPath.split('/').pop() || 'downloaded-element.md';
    const filename = validateFilename(originalFilename);

    // Get appropriate directory for element type
    const elementDir = this.portfolioManager.getElementDir(elementType);
    const localPath = path.join(elementDir, filename);

    // SECURITY: Check if file already exists before any write operations
    try {
      await fs.access(localPath);
      return {
        success: false,
        message: `AI customization element already exists: ${filename}\n\nThe element has already been installed.`,
        alreadyExists: true
      };
    } catch {
      // File doesn't exist, proceed with installation
    }

    // STEP 3: ALL VALIDATION COMPLETE - NOW PERFORM ATOMIC WRITE OPERATION
    // SECURITY FIX: Use atomic write to prevent partial file corruption and
    // ensure cleanup on any failure during the write process
    await this.atomicWriteFile(localPath, sanitizedContent);

    return {
      success: true,
      message: `AI customization element installed successfully!`,
      metadata,
      filename,
      elementType
    };
  }

  /**
   * Install AI customization element from the collection (backward compatible)
   *
   * DEPRECATED: Use installElement() for source priority support
   *
   * Automatically detects element type from path structure
   *
   * SECURITY FIX: Implements validate-before-write pattern with atomic operations
   * to prevent malicious content persistence on validation failure.
   */
  async installContent(inputPath: string): Promise<{
    success: boolean;
    message: string;
    metadata?: IElementMetadata;
    elementType?: ElementType;
    filename?: string;
  }> {
    return await this.installFromCollection(inputPath);
  }

  /**
   * Atomic file write operation with guaranteed cleanup on failure
   *
   * SECURITY FIX: This method ensures that file writes are atomic and any
   * failures during the write process will not leave partial or corrupted
   * files on the filesystem. Uses temporary file + rename for atomicity.
   *
   * @param destination - Final destination path for the file
   * @param content - Content to write to the file
   * @throws Error if write operation fails (with guaranteed cleanup)
   */
  private async atomicWriteFile(destination: string, content: string): Promise<void> {
    // Generate unique temporary file name to avoid collisions
    const tempFile = `${destination}.tmp.${Date.now()}.${Math.random().toString(36).substring(2)}`;

    try {
      // SECURITY: Write to temporary file first
      // If this fails, no files are left on disk
      await fs.writeFile(tempFile, content, 'utf-8');

      // SECURITY: Atomic rename operation
      // On most filesystems, rename is atomic - the file appears with complete content
      // or doesn't appear at all. This prevents partial file corruption.
      await fs.rename(tempFile, destination);

    } catch (error) {
      // SECURITY: Guaranteed cleanup of temporary file on ANY failure
      // This ensures no temporary files are left behind even if the
      // rename operation fails after successful write
      try {
        await fs.unlink(tempFile);
      } catch (cleanupError) {
        // Ignore cleanup errors - the file may not exist if writeFile failed
        // The original error is more important to propagate
      }

      // Re-throw the original error to maintain error handling semantics
      throw error;
    }
  }

  /**
   * Get ElementType from string
   */
  private getElementTypeFromString(typeStr: string): ElementType {
    const typeMap: Record<string, ElementType> = {
      'personas': ElementType.PERSONA,
      'skills': ElementType.SKILL,
      'templates': ElementType.TEMPLATE,
      'agents': ElementType.AGENT
    };

    const elementType = typeMap[typeStr];
    if (!elementType) {
      throw new Error(`Unknown element type: ${typeStr}. Valid types: ${Object.keys(typeMap).join(', ')}`);
    }

    return elementType;
  }

  /**
   * Format installation success message
   */
  formatInstallSuccess(metadata: IElementMetadata, filename: string, elementType: ElementType): string {
    const typeEmojis: Record<ElementType, string> = {
      [ElementType.PERSONA]: '🎭',
      [ElementType.SKILL]: '🎯',
      [ElementType.TEMPLATE]: '📄',
      [ElementType.AGENT]: '🤖',
      [ElementType.MEMORY]: '🧠',
      [ElementType.ENSEMBLE]: '🎼'
    };

    const emoji = typeEmojis[elementType] || '📦';
    const typeName = elementType.charAt(0).toUpperCase() + elementType.slice(1);

    return `✅ **AI Customization Element Installed Successfully!**\n\n` +
      `${emoji} **${metadata.name}** ${metadata.author ? `by ${metadata.author}` : ''}\n` +
      `📁 Type: ${typeName}\n` +
      `📄 Saved as: ${filename}\n\n` +
      `🚀 **Ready to use!**`;
  }
}
