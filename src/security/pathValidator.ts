import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { RegexValidator } from './regexValidator.js';

export class PathValidator {
  private static ALLOWED_DIRECTORIES: string[] = [];
  private static ALLOWED_EXTENSIONS: string[] = ['.md', '.markdown', '.txt', '.yml', '.yaml'];

  static initialize(personasDir: string, allowedExtensions?: string[]): void {
    this.ALLOWED_DIRECTORIES = [
      path.resolve(personasDir),
      path.resolve('./personas'),
      path.resolve('./custom-personas'),
      path.resolve('./backups'),
      path.resolve(process.env.PERSONAS_DIR || './personas')
    ];

    if (allowedExtensions) {
      this.ALLOWED_EXTENSIONS = allowedExtensions;
    }
  }

  /**
   * SECURITY FIX #1290: Resolve symlinks to prevent path traversal
   * Helper function to resolve symlinks in paths
   */
  private static async resolveSymlinks(resolvedPath: string, userPath: string): Promise<string> {
    try {
      // Try to resolve symlinks in the full path
      const realPath = await fs.realpath(resolvedPath);

      // Log symlink resolution for security auditing
      if (realPath !== resolvedPath) {
        logger.warn('Symlink detected and resolved', {
          requestedPath: userPath,
          resolvedPath,
          realPath
        });
      }
      return realPath;
    } catch (err) {
      // If path doesn't exist (e.g., creating new file), resolve parent directory
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.resolveParentSymlink(resolvedPath, userPath);
      }
      throw err;
    }
  }

  /**
   * Helper to resolve symlinks in parent directory when target doesn't exist
   */
  private static async resolveParentSymlink(resolvedPath: string, userPath: string): Promise<string> {
    const parentDir = path.dirname(resolvedPath);
    try {
      const realParent = await fs.realpath(parentDir);

      // Log parent symlink resolution for security auditing
      if (realParent !== parentDir) {
        logger.warn('Parent directory symlink detected and resolved', {
          requestedPath: userPath,
          parentDir,
          realParent
        });
      }

      // Reconstruct path with resolved parent and original filename
      return path.join(realParent, path.basename(resolvedPath));
    } catch {
      // Parent directory doesn't exist - use resolved path
      // (will fail later in file operations, but not a security issue)
      return resolvedPath;
    }
  }

  /**
   * Validate that the real path is within allowed directories
   */
  private static validatePathIsAllowed(realPath: string, userPath: string): void {
    const allowedDirs = this.ALLOWED_DIRECTORIES.length === 0
      ? [path.resolve('./personas'), path.resolve(process.env.PERSONAS_DIR || './personas')]
      : this.ALLOWED_DIRECTORIES;

    const isAllowed = allowedDirs.some(allowedDir =>
      realPath.startsWith(allowedDir + path.sep) || realPath === allowedDir
    );

    if (!isAllowed) {
      // SECURITY FIX #206: Don't expose user paths in error messages
      logger.error('Path access denied', { path: userPath });
      throw new Error('Path access denied');
    }
  }

  /**
   * Validate filename extension and format
   */
  private static validateFilename(realPath: string): void {
    if (!path.extname(realPath)) {
      return; // Not a file, skip validation
    }

    const filename = path.basename(realPath);
    const ext = path.extname(filename).toLowerCase();

    // Check if extension is allowed
    if (!this.ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(`File extension not allowed: ${ext}. Allowed: ${this.ALLOWED_EXTENSIONS.join(', ')}`);
    }

    // Validate filename format (alphanumeric, dash, underscore, dot)
    if (!RegexValidator.validate(filename, /^[a-zA-Z0-9\-_.]+$/i, { maxLength: 255 })) {
      throw new Error(`Invalid filename format: ${filename}`);
    }
  }

  static async validatePersonaPath(userPath: string): Promise<string> {
    if (!userPath || typeof userPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }

    // Remove any null bytes
    const cleanPath = userPath.replaceAll(/\u0000/g, ''); // NOSONAR - Removing null bytes for security

    // Normalize and resolve path
    const normalizedPath = path.normalize(cleanPath);
    const resolvedPath = path.resolve(normalizedPath);

    // Check for path traversal attempts
    if (normalizedPath.includes('..') || cleanPath.includes('..')) {
      logger.warn('Path traversal attempt detected', { userPath });
      throw new Error('Path traversal detected');
    }

    // Resolve symlinks to get real path
    const realPath = await this.resolveSymlinks(resolvedPath, userPath);

    // Validate path is within allowed directories
    this.validatePathIsAllowed(realPath, userPath);

    // Validate filename extension and format
    this.validateFilename(realPath);

    // Return the real path (with symlinks resolved) for safe file operations
    return realPath;
  }

  static async safeReadFile(filePath: string): Promise<string> {
    const validatedPath = await this.validatePersonaPath(filePath);
    
    // Check file exists and is not a directory
    const stats = await fs.stat(validatedPath);
    if (stats.isDirectory()) {
      throw new Error('Path is a directory, not a file');
    }
    
    // Size check
    if (stats.size > 500000) { // 500KB
      throw new Error('File too large');
    }
    
    return fs.readFile(validatedPath, 'utf-8');
  }

  static async safeWriteFile(filePath: string, content: string): Promise<void> {
    const validatedPath = await this.validatePersonaPath(filePath);
    
    // Content validation
    if (content.length > 500000) {
      throw new Error('Content too large');
    }
    
    // Ensure directory exists before atomic write
    const dirPath = path.dirname(validatedPath);
    await fs.mkdir(dirPath, { recursive: true });
    
    // Write to temp file first (atomic write)
    const tempPath = `${validatedPath}.tmp`;
    await fs.writeFile(tempPath, content, 'utf-8');
    
    // Rename to final path (atomic on most filesystems)
    await fs.rename(tempPath, validatedPath);
  }
}