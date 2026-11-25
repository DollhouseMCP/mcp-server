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
import { acceptedExtensions, ELEMENT_FILE_EXTENSIONS } from '../storage/elementFileExtensions.js';
import fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { RegexValidator } from './regexValidator.js';
import { SECURITY_LIMITS } from './constants.js';

const PATH_ACCESS_DENIED_MESSAGE = 'Path access denied';

/** `quiet`: the caller owns the log line (a storage index demotes repeats); the refusal itself is unchanged. */
export interface ElementPathCheckOptions { quiet?: boolean }

/** The validator's own evidence for a refusal, carried on the error so the owner of the log line reports it. */
export interface PathRefusalDetail { path: string; allowedDir?: string; realPath?: string }

export function pathRefusalDetail(error: unknown): PathRefusalDetail | undefined {
  const detail = (error as { pathRefusal?: PathRefusalDetail } | null)?.pathRefusal;
  return detail && typeof detail.path === 'string' ? detail : undefined;
}

function refusal(message: string, pathRefusal: PathRefusalDetail): Error {
  return Object.assign(new Error(message), { pathRefusal });
}

/**
 * Per-user allowlist for session-scoped PathValidator instances.
 * Specifies which directories the session's user can write to and
 * read from. Used by HTTP multi-user mode; stdio uses the simpler
 * single-dir constructor form.
 */
export interface PathValidatorAllowlist {
  writeDirs: string[];
  readOnlyDirs?: string[];
  allowedExtensions?: string[];
}

export class PathValidator {
  // ── Instance fields (per-PathValidator, replaces static state) ─────

  /** All directories that can be read (write dirs + read-only dirs). */
  private readonly allowedDirectories: string[];
  /** Directories that can be written to. Subset of allowedDirectories. */
  private readonly writableDirectories: string[];
  private readonly allowedExtensions: string[];
  private resolvedAllowedDirs: Promise<string[]> | null = null;
  private resolvedWritableDirs: Promise<string[]> | null = null;

  /**
   * Overload 1: legacy single-dir form (stdio, backward compat).
   * All dirs are writable (single-user, no shared pool).
   * Overload 2: structured allowlist form (per-user HTTP sessions).
   * writeDirs are writable; readOnlyDirs are read-only.
   */
  constructor(personasDir: string, allowedExtensions?: string[]);
  constructor(allowlist: PathValidatorAllowlist);
  constructor(
    personasDirOrAllowlist: string | PathValidatorAllowlist,
    allowedExtensions?: string[],
  ) {
    if (typeof personasDirOrAllowlist === 'string') {
      // Legacy form: single personas dir + hardcoded extras (all writable)
      const personasDir = personasDirOrAllowlist;
      const dirs = [...new Set([
        path.resolve(personasDir),
        path.resolve('./custom-personas'),
        path.resolve('./backups'),
        ...(process.env.PERSONAS_DIR ? [path.resolve(process.env.PERSONAS_DIR)] : []),
      ])];
      this.allowedDirectories = dirs;
      this.writableDirectories = dirs;
      this.allowedExtensions = allowedExtensions ?? ['.md', '.markdown', '.txt', '.yml', '.yaml'];
    } else {
      // Structured form: explicit write + read-only dirs
      const allowlist = personasDirOrAllowlist;
      const writeDirs = [...new Set(allowlist.writeDirs.map(d => path.resolve(d)))];
      const readOnlyDirs = [...new Set((allowlist.readOnlyDirs ?? []).map(d => path.resolve(d)))];
      this.writableDirectories = writeDirs;
      this.allowedDirectories = [...new Set([...writeDirs, ...readOnlyDirs])];
      this.allowedExtensions = allowlist.allowedExtensions ?? ['.md', '.markdown', '.txt', '.yml', '.yaml'];
    }
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
        allowedDirs.map(dir => PathValidator.resolveSymlinks(path.resolve(dir), dir))
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
      logger.error(PATH_ACCESS_DENIED_MESSAGE, { path: userPath, realPath, allowedDirs });
      throw new Error(PATH_ACCESS_DENIED_MESSAGE);
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

  private async resolveAndValidateWithinAllowedDirs(userPath: string): Promise<string> {
    if (!userPath || typeof userPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }

    // Intentionally remove all null bytes before path normalization.
    const cleanPath = userPath.replaceAll('\0', ''); // NOSONAR
    const normalizedPath = path.normalize(cleanPath);
    const resolvedPath = path.resolve(normalizedPath);

    if (normalizedPath.includes('..') || cleanPath.includes('..')) {
      logger.warn('Path traversal attempt detected', { userPath });
      throw new Error('Path traversal detected');
    }

    const realPath = await PathValidator.resolveSymlinks(resolvedPath, userPath);
    await this.validatePathIsAllowed(realPath, userPath);

    return realPath;
  }

  async validatePersonaPath(userPath: string): Promise<string> {
    const realPath = await this.resolveAndValidateWithinAllowedDirs(userPath);
    this.validateFilename(realPath);

    return realPath;
  }

  async enforceWritablePath(filePath: string): Promise<string> {
    const validatedPath = await this.resolveAndValidateWithinAllowedDirs(filePath);
    await this.validatePathIsWritable(validatedPath);
    return validatedPath;
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

    // Enforce write-only dirs (read-only dirs like shared/ are not writable)
    await this.validatePathIsWritable(validatedPath);

    if (content.length > 500000) {
      throw new Error('Content too large');
    }

    const dirPath = path.dirname(validatedPath);
    await fs.mkdir(dirPath, { recursive: true });

    const tempPath = `${validatedPath}.tmp`;
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, validatedPath);
  }

  private async validatePathIsWritable(realPath: string): Promise<void> {
    this.resolvedWritableDirs ??= Promise.all(
      this.writableDirectories.map(dir => PathValidator.resolveSymlinks(path.resolve(dir), dir))
    );
    const writableDirs = await this.resolvedWritableDirs;
    const isWritable = writableDirs.some(dir =>
      realPath.startsWith(dir + path.sep) || realPath === dir
    );
    if (!isWritable) {
      logger.error('Write access denied — path is in a read-only directory', { path: realPath });
      throw new Error('Write access denied');
    }
  }

  // ── Root instance management ──────────────────────────────────────

  private static _rootInstance: PathValidator | null = null;

  /** Set the root instance (called by DI container). Warns on re-set (prevents silent replacement). */
  static setRootInstance(instance: PathValidator): void {
    if (
      PathValidator._rootInstance &&
      PathValidator._rootInstance !== instance &&
      process.env.NODE_ENV !== 'test'
    ) {
      throw new Error('PathValidator root instance already set — cannot replace at runtime');
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
  //
  // These methods delegate to the ROOT instance (_rootInstance), NOT to
  // any session-scoped instance. In HTTP multi-user mode, session-scoped
  // PathValidator instances are resolved from the SessionContainer via
  // DI — callers that go through instance methods (validatePersonaPath,
  // safeWriteFile, safeReadFile) get per-user isolation. Callers that
  // use the static methods below always get the root (permissive)
  // instance. This is a pre-existing design limitation of the static
  // delegation pattern, not introduced by per-user isolation.

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
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return PathValidator.resolveParentSymlink(resolvedPath, userPath);
      }
      throw err;
    }
  }

  private static async resolveParentSymlink(resolvedPath: string, userPath: string): Promise<string> {
    let existingAncestor = resolvedPath;
    const missingSegments: string[] = [];

    for (;;) {
      try {
        const realAncestor = await fs.realpath(existingAncestor);
        const realPath = path.join(realAncestor, ...missingSegments);

        if (realPath !== resolvedPath) {
          logger.warn('Path ancestor symlink detected and resolved', {
            requestedPath: userPath,
            resolvedPath,
            realPath,
          });
        }

        return realPath;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw error;
        }

        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) {
          return resolvedPath;
        }
        missingSegments.unshift(path.basename(existingAncestor));
        existingAncestor = parent;
      }
    }
  }

  /**
   * Validate a stored element path: traversal, containment, the symlink target, then the filename
   * rules, in that order, so the reported refusal is the first policy the path breaks.
   * Pure — does not use class-level state. Takes allowedDir as parameter.
   */
  static async validateElementPathOnly(absolutePath: string, allowedDir: string, options: ElementPathCheckOptions = {}): Promise<void> {
    const normalizedPath = PathValidator.containReference(absolutePath, allowedDir, options);
    await PathValidator.assertSymlinkWithinDirectory(normalizedPath, path.normalize(allowedDir), absolutePath, options);
    PathValidator.validateFilenameExtension(normalizedPath);
  }

  /**
   * Whether caller text is shaped like a path rather than a name: it carries a separator, is an
   * absolute path or holds percent-encoded bytes (an encoded path, never a display name). Only such
   * text is validated as a reference on its own syntax before a name lookup; anything else may be a
   * stored display name ('..', 'Q&A', 'My Skill') and is certified through the index first.
   * References themselves are never decoded.
   */
  static isPathShaped(text: string): boolean {
    return /[\\/]/.test(text) || PathValidator.isPathSyntax(text);
  }

  /**
   * Path syntax that can only address a location, never name an element: beside a separator, an
   * empty or dots-only segment ('a//b', './x', '../x', '....//x'); an absolute path, a drive letter,
   * percent-encoding or a NUL byte. A drive letter is one followed by a separator or the end of the
   * text ('C:/x', 'C:\\x', 'C:'), or by a filename carrying the type's extension ('C:alpha.md');
   * 'Q: Interview Prep' is a name. A separator alone is not path syntax: a stored
   * display name may contain one ('CI/CD Helper', 'A/B Testing').
   */
  static isPathSyntax(text: string, fileExtension?: string): boolean {
    return path.isAbsolute(text) || path.win32.isAbsolute(text) || PathValidator.isDrivePath(text, fileExtension)
      || /%[0-9a-f]{2}/i.test(text) || text.includes('\0')
      || (/[\\/]/.test(text) && text.split(/[\\/]/).some(segment => /^\.*$/.test(segment)));
  }

  /**
   * A drive letter then a separator or nothing, or then a filename with the type's extension (any
   * element file extension when none is given).
   */
  private static isDrivePath(text: string, fileExtension?: string): boolean {
    if (/^[a-z]:(?:[\\/]|$)/i.test(text)) return true;
    if (!/^[a-z]:/i.test(text)) return false;
    const lower = text.toLowerCase();
    const extensions = fileExtension
      ? acceptedExtensions(fileExtension.toLowerCase())
      : Object.values(ELEMENT_FILE_EXTENSIONS).flatMap(acceptedExtensions);
    return extensions.some(extension => lower.endsWith(extension));
  }

  /**
   * Validate the reference itself without touching storage: traversal, containment and filename
   * rules. A caller can get only these wrong; whether the stored target (a symlink) stays inside
   * the directory is storage state, checked by validateElementPathOnly on the read path.
   * Returns the normalized path. A repeated storage-side check passes `quiet` so the index
   * owns the (repeat-demoted) log line instead of the validator.
   */
  static validateElementReference(absolutePath: string, allowedDir: string, options: ElementPathCheckOptions = {}): string {
    const normalizedPath = PathValidator.containReference(absolutePath, allowedDir, options);
    PathValidator.validateFilenameExtension(normalizedPath);
    return normalizedPath;
  }

  /** Traversal and containment: the normalized path, inside the directory, before any storage or filename check. */
  private static containReference(absolutePath: string, allowedDir: string, options: ElementPathCheckOptions): string {
    if (!absolutePath || typeof absolutePath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }
    if (!allowedDir || typeof allowedDir !== 'string') {
      throw new Error('allowedDir must be a non-empty string');
    }

    // A reference carrying a NUL is refused, never rewritten to the reference without it.
    if (absolutePath.includes('\0')) {
      if (!options.quiet) logger.warn('Null byte in path reference refused', { userPath: absolutePath });
      throw refusal('Null bytes are not allowed in a path', { path: absolutePath });
    }
    const normalizedPath = path.normalize(absolutePath);
    PathValidator.assertNoTraversal(normalizedPath, absolutePath, absolutePath, options);
    PathValidator.assertWithinDirectory(normalizedPath, path.normalize(allowedDir), absolutePath, options);
    return normalizedPath;
  }

  private static assertNoTraversal(normalizedPath: string, cleanPath: string, userPath: string, options: ElementPathCheckOptions): void {
    if (normalizedPath.includes('..') || cleanPath.includes('..')) {
      if (!options.quiet) logger.warn('Path traversal attempt detected', { userPath });
      throw refusal('Path traversal detected', { path: userPath });
    }
  }

  private static assertWithinDirectory(normalizedPath: string, normalizedAllowedDir: string, userPath: string, options: ElementPathCheckOptions): void {
    const pathWithSep = normalizedPath + path.sep;
    const allowedDirWithSep = normalizedAllowedDir + path.sep;
    if (!pathWithSep.startsWith(allowedDirWithSep) && normalizedPath !== normalizedAllowedDir) {
      if (!options.quiet) logger.error(PATH_ACCESS_DENIED_MESSAGE, { path: userPath, allowedDir: normalizedAllowedDir });
      throw refusal(PATH_ACCESS_DENIED_MESSAGE, { path: userPath, allowedDir: normalizedAllowedDir });
    }
  }

  private static async assertSymlinkWithinDirectory(normalizedPath: string, normalizedAllowedDir: string, userPath: string,
    options: ElementPathCheckOptions): Promise<void> {
    let stats;
    try {
      stats = await fs.lstat(normalizedPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw cause;
    }
    if (!stats.isSymbolicLink()) return;

    let realPath: string;
    try {
      realPath = await fs.realpath(normalizedPath);
    } catch (cause) {
      // The reference exists: a missing target is a failed read, not absence of the reference.
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        throw Object.assign(new Error('Symlink target is unavailable', { cause }), { code: 'EIO' });
      }
      throw cause;
    }
    const realPathWithSep = realPath + path.sep;
    const allowedDirWithSep = normalizedAllowedDir + path.sep;
    if (!realPathWithSep.startsWith(allowedDirWithSep) && realPath !== normalizedAllowedDir) {
      if (!options.quiet) logger.error('Symlink target outside allowed directory', { path: userPath, realPath, allowedDir: normalizedAllowedDir });
      throw refusal(PATH_ACCESS_DENIED_MESSAGE, { path: userPath, realPath, allowedDir: normalizedAllowedDir });
    }
  }

  private static validateFilenameExtension(normalizedPath: string): void {
    const instance = PathValidator._rootInstance;
    if (instance) {
      instance.validateFilename(normalizedPath);
      return;
    }
    const ext = path.extname(path.basename(normalizedPath)).toLowerCase();
    const defaultExtensions = ['.md', '.markdown', '.txt', '.yml', '.yaml'];
    if (ext && !defaultExtensions.includes(ext)) {
      throw new Error(`File extension not allowed: ${ext}`);
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

    // Intentionally remove all null bytes before path normalization.
    const cleanPath = userPath.replaceAll('\0', ''); // NOSONAR
    const normalizedPath = path.normalize(cleanPath);
    const resolvedPath = path.resolve(normalizedPath);

    if (normalizedPath.includes('..') || cleanPath.includes('..')) {
      logger.warn('Path traversal attempt detected', { userPath });
      throw new Error('Path traversal detected');
    }

    const realPath = await PathValidator.resolveSymlinks(resolvedPath, userPath);

    const resolvedAllowedDir = await fs.realpath(allowedDir).catch(() => allowedDir);
    if (!realPath.startsWith(resolvedAllowedDir + path.sep) && realPath !== resolvedAllowedDir) {
      logger.error(PATH_ACCESS_DENIED_MESSAGE, { path: userPath, realPath, allowedDir: resolvedAllowedDir });
      throw new Error(PATH_ACCESS_DENIED_MESSAGE);
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
