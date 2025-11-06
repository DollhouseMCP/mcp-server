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
   *
   * REFACTORED: Reduced cognitive complexity by extracting helper methods
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
    const localCheckResult = await this.checkLocalElementIfNeeded(elementName, elementType, force);
    if (localCheckResult) {
      return localCheckResult;
    }

    // Step 2: Determine source priority order
    const sourcePriority = this.determineSourcePriority(preferredSource);

    // Step 3: Try sources in priority order
    return await this.trySourcesInOrder(
      sourcePriority,
      elementName,
      elementType,
      collectionPath,
      fallbackOnError
    );
  }

  /**
   * Check local element existence if force is not enabled
   * Extracted from installElement() to reduce cognitive complexity
   *
   * @param elementName - Name of element to check
   * @param elementType - Type of element
   * @param force - Whether to skip the check
   * @returns InstallResult if element exists, null otherwise
   * @private
   */
  private async checkLocalElementIfNeeded(
    elementName: string,
    elementType: ElementType,
    force: boolean
  ): Promise<InstallResult | null> {
    if (force) {
      return null;
    }

    const localExists = await this.checkLocalElement(elementName, elementType);
    if (localExists) {
      return {
        success: false,
        message: `Element "${elementName}" already exists in local portfolio. Use force=true to overwrite.`,
        alreadyExists: true,
        source: ElementSource.LOCAL
      };
    }

    return null;
  }

  /**
   * Determine source priority order based on preferred source
   * Extracted from installElement() to reduce cognitive complexity
   *
   * @param preferredSource - Optional preferred source to prioritize
   * @returns Array of sources in priority order
   * @private
   */
  private determineSourcePriority(preferredSource?: ElementSource): ElementSource[] {
    if (preferredSource) {
      // Preferred source first, then remaining sources in default order
      return [
        preferredSource,
        ...this.sourcePriorityConfig.priority.filter(s => s !== preferredSource)
      ];
    }
    return this.sourcePriorityConfig.priority;
  }

  /**
   * Try installing from sources in priority order
   * Extracted from installElement() to reduce cognitive complexity
   *
   * @param sourcePriority - Sources to try in order
   * @param elementName - Name of element
   * @param elementType - Type of element
   * @param collectionPath - Collection path
   * @param fallbackOnError - Whether to continue on errors
   * @returns InstallResult
   * @throws Error if all sources fail
   * @private
   */
  private async trySourcesInOrder(
    sourcePriority: ElementSource[],
    elementName: string,
    elementType: ElementType,
    collectionPath: string,
    fallbackOnError: boolean
  ): Promise<InstallResult> {
    const errors: Array<{ source: ElementSource; error: Error }> = [];

    for (const source of sourcePriority) {
      const installResult = await this.tryInstallFromSource(
        source,
        elementName,
        elementType,
        collectionPath,
        fallbackOnError
      );

      if (installResult.success) {
        installResult.source = source;
        installResult.message = `${installResult.message}\n\nSource: ${getSourceDisplayName(source)}`;
        return installResult;
      }

      if (installResult.error) {
        errors.push(installResult.error);
      }
    }

    // All sources failed
    throw this.createAllSourcesFailedError(errors);
  }

  /**
   * Try installing from a single source with error handling
   * Extracted from trySourcesInOrder() to reduce cognitive complexity
   *
   * @param source - Source to try
   * @param elementName - Name of element
   * @param elementType - Type of element
   * @param collectionPath - Collection path
   * @param fallbackOnError - Whether to continue on errors
   * @returns Object with success flag and optional error
   * @private
   */
  private async tryInstallFromSource(
    source: ElementSource,
    elementName: string,
    elementType: ElementType,
    collectionPath: string,
    fallbackOnError: boolean
  ): Promise<InstallResult & { error?: { source: ElementSource; error: Error } }> {
    try {
      const installResult = await this.installFromSource(
        source,
        elementName,
        elementType,
        collectionPath
      );
      return installResult;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      if (!fallbackOnError) {
        // Don't try other sources, fail immediately
        throw new Error(
          `Installation from ${getSourceDisplayName(source)} failed: ${err.message}`
        );
      }

      return {
        success: false,
        message: `Failed from ${getSourceDisplayName(source)}`,
        error: { source, error: err }
      };
    }
  }

  /**
   * Create comprehensive error for when all sources fail
   * Extracted to reduce cognitive complexity
   *
   * @param errors - Array of errors from each source
   * @returns Error with formatted summary
   * @private
   */
  private createAllSourcesFailedError(
    errors: Array<{ source: ElementSource; error: Error }>
  ): Error {
    const errorSummary = errors
      .map(({ source, error }) => `${getSourceDisplayName(source)}: ${error.message}`)
      .join('\n');

    return new Error(
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
   * REFACTORED: Reduced cognitive complexity by extracting validation and processing steps
   *
   * @param collectionPath - Path in collection
   * @returns InstallResult
   * @private
   */
  private async installFromCollection(collectionPath: string): Promise<InstallResult> {
    // SECURITY: Validate and sanitize the input path first
    const sanitizedPath = validatePath(collectionPath);
    const elementType = this.validateAndExtractElementType(sanitizedPath);

    // STEP 1: FETCH CONTENT INTO MEMORY (NO DISK OPERATIONS YET)
    const content = await this.fetchCollectionContent(sanitizedPath);

    // STEP 2: PERFORM ALL VALIDATION BEFORE ANY DISK OPERATIONS
    const { sanitizedContent, metadata } = await this.validateCollectionContent(content);

    // STEP 3: PREPARE FILE PATH AND CHECK EXISTENCE
    const { filename, localPath, elementDir } = this.prepareFilePath(sanitizedPath, elementType);

    // SECURITY: Check if file already exists before any write operations
    const existsResult = await this.checkFileExists(localPath, filename);
    if (existsResult) {
      return existsResult;
    }

    // STEP 4: ALL VALIDATION COMPLETE - NOW PERFORM ATOMIC WRITE OPERATION
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
   * Validate collection path and extract element type
   * Extracted from installFromCollection() to reduce cognitive complexity
   *
   * @param sanitizedPath - Sanitized collection path
   * @returns Element type
   * @throws Error if path format is invalid
   * @private
   */
  private validateAndExtractElementType(sanitizedPath: string): ElementType {
    // SECURITY: Detect element type from path structure and validate format
    // Expected format: library/[element-type]/[category]/[element].md
    const pathParts = sanitizedPath.split('/');
    if (pathParts.length < 3 || pathParts[0] !== 'library') {
      throw new Error('Invalid collection path format. Expected: library/[element-type]/[category]/[element].md');
    }

    // SECURITY: Ensure the path ends with .md to prevent arbitrary file types
    if (!sanitizedPath.endsWith('.md')) {
      throw new Error('Invalid file type. Only .md files are allowed.');
    }

    const elementTypeStr = pathParts[1];
    return this.getElementTypeFromString(elementTypeStr);
  }

  /**
   * Fetch content from collection with size validation
   * Extracted from installFromCollection() to reduce cognitive complexity
   *
   * @param sanitizedPath - Sanitized collection path
   * @returns Decoded content string
   * @throws Error if fetch fails or size exceeds limits
   * @private
   */
  private async fetchCollectionContent(sanitizedPath: string): Promise<string> {
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
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }

  /**
   * Validate and sanitize collection content
   * Extracted from installFromCollection() to reduce cognitive complexity
   *
   * @param content - Raw content from collection
   * @returns Sanitized content and parsed metadata
   * @throws Error if validation fails
   * @private
   */
  private async validateCollectionContent(content: string): Promise<{
    sanitizedContent: string;
    metadata: IElementMetadata;
  }> {
    // SECURITY: Validate content size after decoding
    validateContentSize(content, SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES);

    // SECURITY: Sanitize content for security threats (XSS, injection, etc.)
    const sanitizedContent = ContentValidator.sanitizePersonaContent(content);

    // SECURITY: Use secure YAML parser to prevent YAML bombs and injection
    const parsed = this.parseSecureYaml(sanitizedContent);
    const metadata = parsed.data as IElementMetadata;

    // SECURITY: Additional metadata validation for injection attacks
    this.validateMetadataSecurity(metadata);

    // SECURITY: Validate required metadata fields
    if (!metadata.name || !metadata.description) {
      throw new Error('Invalid content: missing required name or description');
    }

    return { sanitizedContent, metadata };
  }

  /**
   * Parse YAML content with security error handling
   * Extracted to reduce cognitive complexity
   *
   * @param content - Content to parse
   * @returns Parsed matter result with metadata
   * @throws Error if parsing fails or security threat detected
   * @private
   */
  private parseSecureYaml(content: string): { data: IElementMetadata; content: string } {
    try {
      const parsed = SecureYamlParser.safeMatter(content);
      return { data: parsed.data as IElementMetadata, content: parsed.content };
    } catch (error) {
      if (error instanceof SecurityError) {
        throw new Error(`Security threat in content: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Validate metadata for security threats
   * Extracted to reduce cognitive complexity
   *
   * @param metadata - Metadata to validate
   * @throws Error if validation fails
   * @private
   */
  private validateMetadataSecurity(metadata: IElementMetadata): void {
    const metadataValidation = ContentValidator.validateMetadata(metadata);
    if (!metadataValidation.isValid) {
      throw new Error(`Security validation failed: ${metadataValidation.detectedPatterns?.join(', ')}`);
    }
  }

  /**
   * Prepare file path for installation
   * Extracted from installFromCollection() to reduce cognitive complexity
   *
   * @param sanitizedPath - Sanitized collection path
   * @param elementType - Element type
   * @returns Filename, local path, and element directory
   * @private
   */
  private prepareFilePath(sanitizedPath: string, elementType: ElementType): {
    filename: string;
    localPath: string;
    elementDir: string;
  } {
    // SECURITY: Generate and validate local filename to prevent path traversal
    const originalFilename = sanitizedPath.split('/').pop() || 'downloaded-element.md';
    const filename = validateFilename(originalFilename);

    // Get appropriate directory for element type
    const elementDir = this.portfolioManager.getElementDir(elementType);
    const localPath = path.join(elementDir, filename);

    return { filename, localPath, elementDir };
  }

  /**
   * Check if file already exists
   * Extracted from installFromCollection() to reduce cognitive complexity
   *
   * @param localPath - Local file path to check
   * @param filename - Filename for error message
   * @returns InstallResult if file exists, null otherwise
   * @private
   */
  private async checkFileExists(localPath: string, filename: string): Promise<InstallResult | null> {
    try {
      await fs.access(localPath);
      return {
        success: false,
        message: `AI customization element already exists: ${filename}\n\nThe element has already been installed.`,
        alreadyExists: true
      };
    } catch {
      // File doesn't exist, proceed with installation
      return null;
    }
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
