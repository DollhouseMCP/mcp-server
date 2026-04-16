/**
 * ElementFileOperations - Common file operations for element managers
 *
 * Provides shared file handling operations for all element types:
 * - Reading files with frontmatter parsing
 * - Writing files with atomic operations
 * - Directory scanning and filtering
 *
 * SECURITY: All operations use FileLockManager for atomic reads/writes
 * PATH VALIDATION: All paths are validated before file operations
 * LOGGING: Operations are logged for debugging and audit trail
 */

import { FileLockManager } from '../../security/fileLockManager.js';
import { sanitizeInput, validatePath } from '../../security/InputValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import matter from 'gray-matter';

/**
 * Result of parsing a file with frontmatter
 */
export interface ParsedFile {
  metadata: any;
  content: string;
  raw: string;
}

/**
 * Options for file operations
 */
export interface FileOperationOptions {
  /** Maximum file size in bytes (default: 1MB) */
  maxSize?: number;
  /** Whether to validate path is within base directory (default: true) */
  validatePath?: boolean;
  /** Whether to create directory if it doesn't exist (default: true) */
  ensureDir?: boolean;
}

/**
 * Utility class for common file operations
 * Used by BaseElementManager and can be used by other managers
 *
 * DEPENDENCY INJECTION: Requires FileLockManager instance for atomic operations
 */
export class ElementFileOperations {
  private fileLockManager: FileLockManager;

  /**
   * Constructor - accepts FileLockManager for atomic operations
   * @param fileLockManager - FileLockManager instance for atomic file operations
   */
  constructor(fileLockManager: FileLockManager) {
    this.fileLockManager = fileLockManager;
  }

  /**
   * Atomically read a file with frontmatter
   * SECURITY: Uses FileLockManager to prevent race conditions
   *
   * @param filePath - Absolute or relative path to file
   * @param baseDir - Base directory for validation
   * @param options - Operation options
   * @returns Parsed file with metadata and content
   */
  async readFileWithFrontmatter(
    filePath: string,
    baseDir: string,
    options: FileOperationOptions = {}
  ): Promise<ParsedFile> {
    const {
      maxSize = 1024 * 1024, // 1MB default
      validatePath: shouldValidatePath = true
    } = options;

    // SECURITY: Sanitize path
    const sanitizedPath = sanitizeInput(filePath, 255);

    // Validate path if requested
    if (shouldValidatePath) {
      try {
        validatePath(sanitizedPath, baseDir);
      } catch (error) {
        throw new Error(`Invalid file path: ${error instanceof Error ? error.message : 'Invalid path'}`);
      }
    }

    // Resolve full path
    const fullPath = path.isAbsolute(sanitizedPath)
      ? sanitizedPath
      : path.join(baseDir, sanitizedPath);

    // Check file size before reading
    const stats = await fs.stat(fullPath);
    if (stats.size > maxSize) {
      throw new Error(`File too large: ${stats.size} bytes (max: ${maxSize})`);
    }

    // CRITICAL FIX: Use atomic file read via injected instance
    const raw = await this.fileLockManager.atomicReadFile(fullPath, { encoding: 'utf-8' });

    // Parse frontmatter
    const parsed = matter(raw);

    return {
      metadata: parsed.data,
      content: parsed.content,
      raw
    };
  }

  /**
   * Atomically write a file with frontmatter
   * SECURITY: Uses FileLockManager to prevent corruption
   *
   * @param filePath - Absolute or relative path to file
   * @param metadata - YAML frontmatter metadata
   * @param content - File content
   * @param baseDir - Base directory for validation
   * @param options - Operation options
   */
  async writeFileWithFrontmatter(
    filePath: string,
    metadata: any,
    content: string,
    baseDir: string,
    options: FileOperationOptions = {}
  ): Promise<void> {
    const {
      validatePath: shouldValidatePath = true,
      ensureDir = true
    } = options;

    // SECURITY: Sanitize path
    const sanitizedPath = sanitizeInput(filePath, 255);

    // Validate path if requested
    if (shouldValidatePath) {
      try {
        validatePath(sanitizedPath, baseDir);
      } catch (error) {
        throw new Error(`Invalid file path: ${error instanceof Error ? error.message : 'Invalid path'}`);
      }
    }

    // Resolve full path
    const fullPath = path.isAbsolute(sanitizedPath)
      ? sanitizedPath
      : path.join(baseDir, sanitizedPath);

    // Ensure directory exists
    if (ensureDir) {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
    }

    // Clean metadata to remove undefined values
    const cleanMetadata = Object.entries(metadata).reduce((acc, [key, value]) => {
      if (key !== 'gatekeeperDiagnostics' && value !== undefined) {
        acc[key] = value;
      }
      return acc;
    }, {} as any);

    // Create frontmatter content
    const fileContent = matter.stringify(content, cleanMetadata);

    // CRITICAL FIX: Use atomic file write via injected instance
    await this.fileLockManager.atomicWriteFile(fullPath, fileContent, { encoding: 'utf-8' });
  }

  /**
   * Validate path is within base directory and resolve to absolute path
   * SECURITY: Prevents path traversal attacks
   *
   * @param filePath - Path to validate
   * @param baseDir - Base directory
   * @returns Normalized absolute path
   * @throws Error if path is invalid or outside base directory
   */
  validateAndResolvePath(filePath: string, baseDir: string): string {
    const sanitizedPath = sanitizeInput(filePath, 255);

    // Resolve to absolute path
    const fullPath = path.isAbsolute(sanitizedPath)
      ? sanitizedPath
      : path.join(baseDir, sanitizedPath);

    // Normalize and check path traversal
    const normalizedPath = path.normalize(fullPath);

    if (!normalizedPath.startsWith(baseDir)) {
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'CRITICAL',
        source: 'ElementFileOperations.validateAndResolvePath',
        details: `Attempted to access file outside directory: ${sanitizedPath}`
      });
      throw new Error('Path traversal attempt detected');
    }

    return normalizedPath;
  }

  /**
   * Generate filename from element name
   * Converts name to lowercase and replaces invalid characters with hyphens
   *
   * @param name - Element name
   * @param extension - File extension (default: '.md')
   * @returns Sanitized filename
   */
  generateFilename(name: string, extension: string = '.md'): string {
    const sanitized = sanitizeInput(name, 100);
    const filename = sanitized
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, '-')
      .replaceAll(/-+/g, '-')
      .replaceAll(/^-|-$/g, '');

    return `${filename}${extension}`;
  }

  /**
   * Check if a file exists
   *
   * @param filePath - Path to check
   * @param baseDir - Base directory (optional)
   * @returns True if file exists
   */
  async fileExists(filePath: string, baseDir?: string): Promise<boolean> {
    try {
      const sanitizedPath = sanitizeInput(filePath, 255);
      const fullPath = baseDir
        ? path.join(baseDir, sanitizedPath)
        : sanitizedPath;
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a file with validation
   * SECURITY: Validates path before deletion
   *
   * @param filePath - Path to delete
   * @param baseDir - Base directory for validation
   * @throws Error if path is invalid
   */
  async deleteFile(filePath: string, baseDir: string): Promise<void> {
    const normalizedPath = this.validateAndResolvePath(filePath, baseDir);

    // Log security event
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_DELETED',
      severity: 'MEDIUM',
      source: 'ElementFileOperations.deleteFile',
      details: `File deleted: ${path.basename(normalizedPath)}`
    });

    await fs.unlink(normalizedPath);
  }

  /**
   * List files in a directory
   *
   * @param dir - Directory to list
   * @param extension - Filter by extension (optional)
   * @returns Array of file paths
   */
  async listFiles(dir: string, extension?: string): Promise<string[]> {
    try {
      // Ensure directory exists
      await fs.mkdir(dir, { recursive: true });

      const files = await fs.readdir(dir);

      if (extension) {
        return files.filter(f => f.endsWith(extension));
      }

      return files;
    } catch (error) {
      logger.error(`Failed to list files in ${dir}:`, error);
      return [];
    }
  }
}
