import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { RegexValidator } from './regexValidator.js';
import { SECURITY_LIMITS } from './constants.js';

export class PathValidator {
  private static ALLOWED_DIRECTORIES: string[] = [];
  private static ALLOWED_EXTENSIONS: string[] = ['.md', '.markdown', '.txt', '.yml', '.yaml'];
  private static resolvedAllowedDirs: Promise<string[]> | null = null;

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

    // Clear cached resolved directories when reinitializing
    this.resolvedAllowedDirs = null;
  }

  /**
   * Get allowed directories with symlinks resolved
   * Caches the result to avoid repeated filesystem calls
   */
  private static async getResolvedAllowedDirectories(): Promise<string[]> {
    if (this.resolvedAllowedDirs) {
      return this.resolvedAllowedDirs;
    }

    this.resolvedAllowedDirs = (async () => {
      const allowedDirs = this.ALLOWED_DIRECTORIES.length === 0
        ? [path.resolve('./personas'), path.resolve(process.env.PERSONAS_DIR || './personas')]
        : this.ALLOWED_DIRECTORIES;

      // Resolve symlinks for each allowed directory
      const resolved = await Promise.all(
        allowedDirs.map(async (dir) => {
          try {
            return await fs.realpath(dir);
          } catch {
            // If directory doesn't exist yet, use the original path
            return dir;
          }
        })
      );

      return resolved;
    })();

    return this.resolvedAllowedDirs;
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
   * FIX: Now resolves symlinks in allowed directories to handle macOS /tmp -> /private/tmp
   */
  private static async validatePathIsAllowed(realPath: string, userPath: string): Promise<void> {
    const allowedDirs = await this.getResolvedAllowedDirectories();

    const isAllowed = allowedDirs.some(allowedDir =>
      realPath.startsWith(allowedDir + path.sep) || realPath === allowedDir
    );

    if (!isAllowed) {
      // SECURITY FIX #206: Don't expose user paths in error messages
      logger.error('Path access denied', { path: userPath, realPath, allowedDirs });
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
    if (!RegexValidator.validate(filename, /^[a-zA-Z0-9_.-]+$/, { maxLength: SECURITY_LIMITS.MAX_FILENAME_LENGTH })) {
      throw new Error(`Invalid filename format: ${filename}`);
    }
  }

  /**
   * Validate element path WITHOUT resolving symlinks
   * Used by BaseElementManager to validate paths while preserving the original path representation
   *
   * SECURITY: Rejects symlinks that point outside the allowed directory
   *
   * @param absolutePath - Absolute path to validate
   * @param allowedDir - Base directory that the path must be within
   * @throws Error if path is invalid, is a symlink pointing outside allowed directory, or outside allowed directory
   */
  static async validateElementPathOnly(absolutePath: string, allowedDir: string): Promise<void> {
    if (!absolutePath || typeof absolutePath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }

    if (!allowedDir || typeof allowedDir !== 'string') {
      throw new Error('allowedDir must be a non-empty string');
    }

    // Remove any null bytes
    // eslint-disable-next-line no-control-regex -- Intentionally removing null bytes for security
    const cleanPath = absolutePath.replaceAll(/\u0000/g, ''); // NOSONAR - Removing null bytes for security

    // Check for path traversal attempts in the normalized path
    const normalizedPath = path.normalize(cleanPath);
    if (normalizedPath.includes('..') || cleanPath.includes('..')) {
      logger.warn('Path traversal attempt detected', { userPath: absolutePath });
      throw new Error('Path traversal detected');
    }

    // Validate path is within allowed directory (without resolving symlinks)
    const normalizedAllowedDir = path.normalize(allowedDir);
    const pathWithSep = normalizedPath + path.sep;
    const allowedDirWithSep = normalizedAllowedDir + path.sep;

    if (!pathWithSep.startsWith(allowedDirWithSep) && normalizedPath !== normalizedAllowedDir) {
      logger.error('Path access denied', { path: absolutePath, allowedDir: normalizedAllowedDir });
      throw new Error('Path access denied');
    }

    // SECURITY FIX: Check if path is a symlink and if so, ensure it points within allowed directory
    try {
      const stats = await fs.lstat(normalizedPath); // lstat doesn't follow symlinks
      if (stats.isSymbolicLink()) {
        // Resolve the symlink target to check if it's within allowed directory
        const realPath = await fs.realpath(normalizedPath);
        const realPathWithSep = realPath + path.sep;

        if (!realPathWithSep.startsWith(allowedDirWithSep) && realPath !== normalizedAllowedDir) {
          logger.error('Symlink target outside allowed directory', {
            path: absolutePath,
            realPath,
            allowedDir: normalizedAllowedDir
          });
          throw new Error('Path access denied');
        }
      }
    } catch (err) {
      // If file doesn't exist, that's okay (might be creating a new file)
      // Re-throw if it's NOT an ENOENT error
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    // Validate filename extension and format
    this.validateFilename(normalizedPath);
  }

  /**
   * Stateless element path validation (generic for all element types)
   * Used by BaseElementManager for validating paths across all element types.
   *
   * @param userPath - User-provided path to validate
   * @param allowedDir - Base directory that the path must be within
   * @returns Validated absolute path with symlinks resolved
   * @deprecated Use validateElementPathOnly() for path validation without resolution
   */
  static async validateElementPath(userPath: string, allowedDir: string): Promise<string> {
    if (!userPath || typeof userPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }

    if (!allowedDir || typeof allowedDir !== 'string') {
      throw new Error('allowedDir must be a non-empty string');
    }

    // Remove any null bytes
    // eslint-disable-next-line no-control-regex -- Intentionally removing null bytes for security
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

    // Validate path is within allowed directory
    const resolvedAllowedDir = await fs.realpath(allowedDir).catch(() => allowedDir);
    if (!realPath.startsWith(resolvedAllowedDir + path.sep) && realPath !== resolvedAllowedDir) {
      logger.error('Path access denied', { path: userPath, realPath, allowedDir: resolvedAllowedDir });
      throw new Error('Path access denied');
    }

    // Validate filename extension and format
    this.validateFilename(realPath);

    // Return the real path (with symlinks resolved) for safe file operations
    return realPath;
  }

  /**
   * @deprecated Use validateElementPath() instead. This method uses class-level state.
   * Validate a persona path against pre-initialized allowed directories.
   *
   * @param userPath - User-provided path to validate
   * @returns Validated absolute path with symlinks resolved
   */
  static async validatePersonaPath(userPath: string): Promise<string> {
    if (!userPath || typeof userPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }

    // Remove any null bytes
    // eslint-disable-next-line no-control-regex -- Intentionally removing null bytes for security
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

    // Validate path is within allowed directories (now async to resolve symlinks in allowed dirs)
    await this.validatePathIsAllowed(realPath, userPath);

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
