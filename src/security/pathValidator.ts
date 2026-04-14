/**
 * Path Validator
 *
 * Validates file paths against allowed directories and security constraints.
 * Prevents path traversal attacks, validates extensions, resolves symlinks.
 *
 * Issue #1948: Converted from pure-static class to instance + static delegation.
 * Instance fields hold per-PathValidator allowed directories (eliminates
 * cross-session state mutation). Static methods delegate to a root instance
 * for backward compatibility.
 *
 * @since v1.0.0
 * @since v2.1.0 — Issue #1948: Instance-based with static delegation
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { RegexValidator } from './regexValidator.js';
import { SECURITY_LIMITS } from './constants.js';

export class PathValidator {
  // ── Instance fields (per-PathValidator, replaces static state) ─────

  private readonly allowedDirectories: string[];
  private readonly allowedExtensions: string[];
  private resolvedAllowedDirs: Promise<string[]> | null = null;

  /**
   * @param personasDir - Primary directory for persona files
   * @param allowedExtensions - Optional override for allowed file extensions
   */
  constructor(personasDir: string, allowedExtensions?: string[]) {
    // Deduplicate allowed directories (personasDir and PERSONAS_DIR may resolve to the same path)
    this.allowedDirectories = [...new Set([
      path.resolve(personasDir),
      path.resolve('./custom-personas'),
      path.resolve('./backups'),
      ...(process.env.PERSONAS_DIR ? [path.resolve(process.env.PERSONAS_DIR)] : []),
    ])];
    this.allowedExtensions = allowedExtensions ?? ['.md', '.markdown', '.txt', '.yml', '.yaml'];
  }

  // ── Instance methods ──────────────────────────────────────────────

  private async getResolvedAllowedDirectories(): Promise<string[]> {
    if (this.resolvedAllowedDirs) {
      return this.resolvedAllowedDirs;
    }

    this.resolvedAllowedDirs = (async () => {
      const allowedDirs = this.allowedDirectories.length === 0
        ? [path.resolve('./personas'), path.resolve(process.env.PERSONAS_DIR || './personas')]
        : this.allowedDirectories;

      const resolved = await Promise.all(
        allowedDirs.map(async (dir) => {
          try {
            return await fs.realpath(dir);
          } catch {
            return dir;
          }
        })
      );

      return resolved;
    })();

    return this.resolvedAllowedDirs;
  }

  private async validatePathIsAllowed(realPath: string, userPath: string): Promise<void> {
    const allowedDirs = await this.getResolvedAllowedDirectories();

    const isAllowed = allowedDirs.some(allowedDir =>
      realPath.startsWith(allowedDir + path.sep) || realPath === allowedDir
    );

    if (!isAllowed) {
      logger.error('Path access denied', { path: userPath, realPath, allowedDirs });
      throw new Error('Path access denied');
    }
  }

  private validateFilename(realPath: string): void {
    if (!path.extname(realPath)) {
      return;
    }

    const filename = path.basename(realPath);
    const ext = path.extname(filename).toLowerCase();

    if (!this.allowedExtensions.includes(ext)) {
      throw new Error(`File extension not allowed: ${ext}. Allowed: ${this.allowedExtensions.join(', ')}`);
    }

    if (!RegexValidator.validate(filename, /^[a-zA-Z0-9_.-]+$/, { maxLength: SECURITY_LIMITS.MAX_FILENAME_LENGTH })) {
      throw new Error(`Invalid filename format: ${filename}`);
    }
  }

  async validatePersonaPath(userPath: string): Promise<string> {
    if (!userPath || typeof userPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }

    // eslint-disable-next-line no-control-regex -- Intentionally removing null bytes for security
    const cleanPath = userPath.replaceAll(/\u0000/g, ''); // NOSONAR
    const normalizedPath = path.normalize(cleanPath);
    const resolvedPath = path.resolve(normalizedPath);

    if (normalizedPath.includes('..') || cleanPath.includes('..')) {
      logger.warn('Path traversal attempt detected', { userPath });
      throw new Error('Path traversal detected');
    }

    const realPath = await PathValidator.resolveSymlinks(resolvedPath, userPath);
    await this.validatePathIsAllowed(realPath, userPath);
    this.validateFilename(realPath);

    return realPath;
  }

  async safeReadFile(filePath: string): Promise<string> {
    const validatedPath = await this.validatePersonaPath(filePath);

    const stats = await fs.stat(validatedPath);
    if (stats.isDirectory()) {
      throw new Error('Path is a directory, not a file');
    }

    if (stats.size > 500000) {
      throw new Error('File too large');
    }

    return fs.readFile(validatedPath, 'utf-8');
  }

  async safeWriteFile(filePath: string, content: string): Promise<void> {
    const validatedPath = await this.validatePersonaPath(filePath);

    if (content.length > 500000) {
      throw new Error('Content too large');
    }

    const dirPath = path.dirname(validatedPath);
    await fs.mkdir(dirPath, { recursive: true });

    const tempPath = `${validatedPath}.tmp`;
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, validatedPath);
  }

  // ── Root instance management ──────────────────────────────────────

  private static _rootInstance: PathValidator | null = null;

  /** Set the root instance (called by DI container). Warns on re-set (prevents silent replacement). */
  static setRootInstance(instance: PathValidator): void {
    if (PathValidator._rootInstance && PathValidator._rootInstance !== instance) {
      if (process.env.NODE_ENV !== 'test') {
        throw new Error('PathValidator root instance already set — cannot replace at runtime');
      }
    }
    PathValidator._rootInstance = instance;
  }

  /** Get the root instance. Throws if not initialized. */
  static getInstance(): PathValidator {
    if (!PathValidator._rootInstance) {
      throw new Error(
        'PathValidator root instance not initialized. ' +
        'Call PathValidator.initialize() or inject via DI container.'
      );
    }
    return PathValidator._rootInstance;
  }

  // ── Static delegation methods (backward compatibility) ────────────

  /**
   * Initialize the static root instance.
   * @deprecated Use DI container registration instead. Kept for backward compat.
   */
  static initialize(personasDir: string, allowedExtensions?: string[]): void {
    PathValidator._rootInstance = new PathValidator(personasDir, allowedExtensions);
  }

  /** Symlink resolution — pure helper, no class state needed. */
  private static async resolveSymlinks(resolvedPath: string, userPath: string): Promise<string> {
    try {
      const realPath = await fs.realpath(resolvedPath);

      if (realPath !== resolvedPath) {
        logger.warn('Symlink detected and resolved', {
          requestedPath: userPath,
          resolvedPath,
          realPath
        });
      }
      return realPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return PathValidator.resolveParentSymlink(resolvedPath, userPath);
      }
      throw err;
    }
  }

  private static async resolveParentSymlink(resolvedPath: string, userPath: string): Promise<string> {
    const parentDir = path.dirname(resolvedPath);
    try {
      const realParent = await fs.realpath(parentDir);

      if (realParent !== parentDir) {
        logger.warn('Parent directory symlink detected and resolved', {
          requestedPath: userPath,
          parentDir,
          realParent
        });
      }

      return path.join(realParent, path.basename(resolvedPath));
    } catch {
      return resolvedPath;
    }
  }

  /**
   * Validate element path without resolving symlinks.
   * Pure — does not use class-level state. Takes allowedDir as parameter.
   */
  static async validateElementPathOnly(absolutePath: string, allowedDir: string): Promise<void> {
    if (!absolutePath || typeof absolutePath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }

    if (!allowedDir || typeof allowedDir !== 'string') {
      throw new Error('allowedDir must be a non-empty string');
    }

    // eslint-disable-next-line no-control-regex -- Intentionally removing null bytes for security
    const cleanPath = absolutePath.replaceAll(/\u0000/g, ''); // NOSONAR
    const normalizedPath = path.normalize(cleanPath);
    if (normalizedPath.includes('..') || cleanPath.includes('..')) {
      logger.warn('Path traversal attempt detected', { userPath: absolutePath });
      throw new Error('Path traversal detected');
    }

    const normalizedAllowedDir = path.normalize(allowedDir);
    const pathWithSep = normalizedPath + path.sep;
    const allowedDirWithSep = normalizedAllowedDir + path.sep;

    if (!pathWithSep.startsWith(allowedDirWithSep) && normalizedPath !== normalizedAllowedDir) {
      logger.error('Path access denied', { path: absolutePath, allowedDir: normalizedAllowedDir });
      throw new Error('Path access denied');
    }

    try {
      const stats = await fs.lstat(normalizedPath);
      if (stats.isSymbolicLink()) {
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
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    // Use root instance for filename validation if available, otherwise use static defaults
    const instance = PathValidator._rootInstance;
    if (instance) {
      instance.validateFilename(normalizedPath);
    } else {
      // Fallback for tests/code paths without DI
      const ext = path.extname(path.basename(normalizedPath)).toLowerCase();
      const defaultExtensions = ['.md', '.markdown', '.txt', '.yml', '.yaml'];
      if (ext && !defaultExtensions.includes(ext)) {
        throw new Error(`File extension not allowed: ${ext}`);
      }
    }
  }

  /**
   * @deprecated Use validateElementPathOnly() for path validation without resolution
   */
  static async validateElementPath(userPath: string, allowedDir: string): Promise<string> {
    if (!userPath || typeof userPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }

    if (!allowedDir || typeof allowedDir !== 'string') {
      throw new Error('allowedDir must be a non-empty string');
    }

    // eslint-disable-next-line no-control-regex -- Intentionally removing null bytes for security
    const cleanPath = userPath.replaceAll(/\u0000/g, ''); // NOSONAR
    const normalizedPath = path.normalize(cleanPath);
    const resolvedPath = path.resolve(normalizedPath);

    if (normalizedPath.includes('..') || cleanPath.includes('..')) {
      logger.warn('Path traversal attempt detected', { userPath });
      throw new Error('Path traversal detected');
    }

    const realPath = await PathValidator.resolveSymlinks(resolvedPath, userPath);

    const resolvedAllowedDir = await fs.realpath(allowedDir).catch(() => allowedDir);
    if (!realPath.startsWith(resolvedAllowedDir + path.sep) && realPath !== resolvedAllowedDir) {
      logger.error('Path access denied', { path: userPath, realPath, allowedDir: resolvedAllowedDir });
      throw new Error('Path access denied');
    }

    const instance = PathValidator._rootInstance;
    if (instance) {
      instance.validateFilename(realPath);
    }

    return realPath;
  }

  /**
   * Validate a persona path against pre-initialized allowed directories.
   * @deprecated Use instance method via DI injection instead.
   * Delegates to root instance for backward compatibility.
   */
  static async validatePersonaPath(userPath: string): Promise<string> {
    return PathValidator.getInstance().validatePersonaPath(userPath);
  }

  /** @deprecated Delegates to root instance. */
  static async safeReadFile(filePath: string): Promise<string> {
    return PathValidator.getInstance().safeReadFile(filePath);
  }

  /** @deprecated Delegates to root instance. */
  static async safeWriteFile(filePath: string, content: string): Promise<void> {
    return PathValidator.getInstance().safeWriteFile(filePath, content);
  }
}
