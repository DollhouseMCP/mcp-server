import { sanitizeStorageError } from '../storage/StorageScanError.js';
import { promises as fs, Stats } from 'node:fs';
import * as path from 'node:path';
import { FileLockManager, type WrittenFileVersion } from '../security/fileLockManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { logger } from '../utils/logger.js';
import { FileLock } from '../utils/FileLock.js';
import { ElementType } from '../portfolio/types.js';
import { validatePath } from '../security/InputValidator.js';

interface ActiveSessionContainerRegistry {
  getActiveContainer(): {
    resolve<T>(name: string): T;
  } | undefined;
}

/** Only a missing path proves absence; a reader treats every other code, ENOTDIR included, as a failure. */
export function isAbsentPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * An existence probe ("does this path exist", "is this candidate this kind") may answer no when
 * the path is missing or an ancestor is not a directory. Readers and the strict directoryExists
 * never use this: they would answer empty.
 */
export function isAbsentKindError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The one directory-kind probe, for the storage backend and every service caller: true for a
 * directory, false only when the path is missing (ENOENT); a file at the path is ENOTDIR, typed,
 * and any other failure propagates, so no caller certifies an empty collection from a path that
 * is not a directory.
 */
export async function directoryExists(directoryPath: string, stat: (filePath: string) => Promise<Stats> = filePath => fs.stat(filePath)): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await stat(directoryPath);
  } catch (error) {
    if (isAbsentPathError(error)) return false;
    throw error;
  }
  if (stats.isDirectory()) return true;
  throw Object.assign(new Error(`Not a directory: ${path.basename(directoryPath)}`), { code: 'ENOTDIR', path: directoryPath });
}

export interface FileReadOptions {
  encoding?: BufferEncoding;
  source?: string;
  /** Override maximum file size for this operation (in bytes) */
  maxSize?: number;
}

export interface FileWriteOptions {
  encoding?: BufferEncoding;
  source?: string;
  atomic?: boolean;
  /** Override maximum file size for this operation (in bytes) */
  maxSize?: number;
  /** Receives the created file's (mtime, size), observed on the exclusive handle before it closes. */
  onWritten?: (version: WrittenFileVersion) => void;
}

export interface FileCreateOptions extends FileWriteOptions {
  /** Permissions applied before writing any data to the new file. */
  mode?: number;
}

export interface FileOperationOptions {
  source?: string;
}

export interface FileCopyOptions extends FileOperationOptions {
  exclusive?: boolean;
}

export interface FileOperationsConfig {
  /** Enable verbose audit logging for read operations (default: false) */
  verboseAudit?: boolean;
  /** Maximum file size in bytes (default: 10MB) */
  maxFileSize?: number;
}

export interface IFileOperationsService {
  /**
   * Read a file securely with atomic locking
   * @param filePath - Absolute path to file
   * @param elementType - Element type for context (optional for generic files)
   * @param options - Read options
   */
  readFile(filePath: string, options?: FileReadOptions): Promise<string>;

  /**
   * Read an element file (wrapper around readFile with specific logging)
   * @param filePath - Absolute path to file
   * @param elementType - Element type
   * @param options - Read options
   */
  readElementFile(filePath: string, elementType: ElementType, options?: FileReadOptions): Promise<string>;

  /** Record an element read performed elsewhere (a storage layer) in the verbose security audit. */
  auditElementRead(filePath: string, elementType: ElementType | string, source: string): void;

  /**
   * Write a file securely with atomic locking
   * @param filePath - Absolute path to file
   * @param content - Content to write
   * @param options - Write options
   * @returns the written file's (mtime, size) as the write observed it, when the write reports one
   */
  writeFile(filePath: string, content: string, options?: FileWriteOptions): Promise<WrittenFileVersion | void>;

  /**
   * Delete a file securely
   * @param filePath - Absolute path to file
   * @param elementType - Element type for context (optional)
   * @param options - Operation options
   */
  deleteFile(filePath: string, elementType?: ElementType, options?: FileOperationOptions): Promise<void>;

  /**
   * Create a directory if it doesn't exist
   * @param directoryPath - Absolute path to directory
   */
  createDirectory(directoryPath: string, mode?: number): Promise<void>;

  /**
   * List files in a directory
   * @param directoryPath - Absolute path to directory
   */
  listDirectory(directoryPath: string): Promise<string[]>;

  /**
   * List directory contents with type information
   * @param directoryPath - Absolute path to directory
   * @returns Array of entries with name and type info
   */
  listDirectoryWithTypes(directoryPath: string): Promise<Array<{name: string, isDirectory: boolean, isFile: boolean}>>;

  /**
   * Rename/Move a file or directory
   * @param oldPath - Current absolute path
   * @param newPath - New absolute path
   */
  renameFile(oldPath: string, newPath: string): Promise<void>;
  
  /**
   * Check if a file or directory exists
   * @param filePath - Absolute path to check
   */
  exists(filePath: string): Promise<boolean>;
  directoryExists(directoryPath: string): Promise<boolean>;

  /**
   * Get file statistics
   * @param filePath - Absolute path to the file
   * @returns File statistics
   */
  stat(filePath: string): Promise<Stats>;

  /**
   * Resolve a relative path to absolute path within a base directory
   * @param relativePath - Relative path to resolve
   * @param baseDirectory - Base directory for resolution
   */
  resolvePath(relativePath: string, baseDirectory: string): string;

  /**
   * Validate a path doesn't contain traversal attempts
   * @param filePath - Path to validate
   * @param baseDirectory - Base directory to constrain to
   */
  validatePath(filePath: string, baseDirectory: string): boolean;

  /**
   * Create a file atomically - fails if file already exists (prevents TOCTOU race conditions)
   * @param filePath - Absolute path to file
   * @param content - Content to write
   * @param options - Write options
   * @returns true if created, false if file already existed
   */
  createFileExclusive(filePath: string, content: string, options?: FileCreateOptions): Promise<boolean>;

  withWriteLock<T>(filePath: string, operation: () => Promise<T>): Promise<T>;

  /**
   * Copy a file from source to destination
   * @param sourcePath - Absolute path to source file
   * @param destPath - Absolute path to destination
   * @param options - Operation options
   */
  copyFile(sourcePath: string, destPath: string, options?: FileCopyOptions): Promise<void>;

  /**
   * Change file permissions
   * @param filePath - Absolute path to file
   * @param mode - Permission mode (e.g., 0o644)
   * @param options - Operation options
   */
  chmod(filePath: string, mode: number, options?: FileOperationOptions): Promise<void>;

  /**
   * Append content to a file
   * @param filePath - Absolute path to file
   * @param content - Content to append
   * @param options - Write options
   */
  appendFile(filePath: string, content: string, options?: FileWriteOptions): Promise<void>;
}

export class FileOperationsService implements IFileOperationsService {
  private readonly fileLockManager: FileLockManager;
  private readonly defaultMaxFileSize: number;
  private readonly config: FileOperationsConfig;
  private sessionContainerRegistryProvider?: () => ActiveSessionContainerRegistry | undefined;

  constructor(fileLockManager: FileLockManager, config?: FileOperationsConfig) {
    this.fileLockManager = fileLockManager;
    this.config = config ?? { verboseAudit: false };
    this.defaultMaxFileSize = config?.maxFileSize ?? (10 * 1024 * 1024); // 10MB default
  }

  setSessionContainerRegistryProvider(provider: () => ActiveSessionContainerRegistry | undefined): void {
    this.sessionContainerRegistryProvider = provider;
  }

  async readFile(filePath: string, options: FileReadOptions = {}): Promise<string> {
    try {
      const content = await this.fileLockManager.atomicReadFile(filePath, {
        encoding: options.encoding ?? 'utf-8'
      });

      const maxSize = options.maxSize ?? this.defaultMaxFileSize;
      if (content.length > maxSize) {
        throw new Error(`File exceeds maximum size of ${maxSize} bytes`);
      }

      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug(`File not found: ${filePath}`);
      } else {
        logger.error(`Failed to read file: ${filePath}`, error);
      }
      throw error;
    }
  }

  async readElementFile(filePath: string, elementType: ElementType, options: FileReadOptions = {}): Promise<string> {
    const content = await this.readFile(filePath, options);
    this.auditElementRead(filePath, elementType, options.source ?? 'FileOperationsService.readElementFile');

    return content;
  }

  /**
   * Record an element read in the security audit when verbose audit is enabled. Configurable to
   * avoid log spam in production while allowing detailed audit trails (compliance, debugging).
   * The storage layers call it for reads they perform themselves.
   */
  auditElementRead(filePath: string, elementType: ElementType | string, source: string): void {
    if (!this.config.verboseAudit) return;
    SecurityMonitor.logSecurityEvent({
      type: 'FILE_READ',
      severity: 'LOW',
      source,
      details: `Read ${elementType} file: ${path.basename(filePath)}`,
    });
  }

  async writeFile(filePath: string, content: string, options: FileWriteOptions = {}): Promise<WrittenFileVersion | void> {
    try {
      const validatedPath = await this.enforceWriteAllowlist(filePath, 'writeFile');
      const maxSize = options.maxSize ?? this.defaultMaxFileSize;
      if (content.length > maxSize) {
        throw new Error(`Content exceeds maximum size of ${maxSize} bytes`);
      }

      const written = await this.fileLockManager.atomicWriteFile(validatedPath, content, {
        encoding: options.encoding ?? 'utf-8'
      });

      SecurityMonitor.logSecurityEvent({
        type: 'FILE_WRITTEN',
        severity: 'LOW',
        source: options.source ?? 'FileOperationsService.writeFile',
        details: `File written successfully: ${path.basename(validatedPath)}`
      });
      return written;
    } catch (error) {
      logger.error(`Failed to write file: ${filePath}`, error);
      throw error;
    }
  }

  async deleteFile(filePath: string, elementType?: ElementType, options: FileOperationOptions = {}): Promise<void> {
    try {
      const validatedPath = await this.enforceWriteAllowlist(filePath, 'deleteFile');
      await fs.unlink(validatedPath);
      
      if (elementType) {
        SecurityMonitor.logSecurityEvent({
          type: 'FILE_DELETED',
          severity: 'MEDIUM',
          source: options.source ?? 'FileOperationsService.deleteFile',
          details: `Deleted ${elementType} file: ${path.basename(validatedPath)}`
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist, which is fine for delete
        return;
      }
      logger.error(`Failed to delete file: ${filePath}`, error);
      throw error;
    }
  }

  async createDirectory(directoryPath: string, mode?: number): Promise<void> {
    try {
      const validatedPath = await this.enforceWriteAllowlist(directoryPath, 'createDirectory');
      await fs.mkdir(validatedPath, { recursive: true, mode });
    } catch (error) {
      logger.error(`Failed to create directory: ${directoryPath}`, error);
      throw error;
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      if (isAbsentKindError(error)) return false;
      throw sanitizeStorageError(error);
    }
  }

  /** The strict directory probe (see the module helper); failures are client-safe like every service read. */
  async directoryExists(directoryPath: string): Promise<boolean> {
    try {
      return await directoryExists(directoryPath, filePath => this.stat(filePath));
    } catch (error) {
      throw sanitizeStorageError(error);
    }
  }

  /**
   * Get file statistics
   * @param filePath - Absolute path to the file
   * @returns File statistics
   */
  async stat(filePath: string): Promise<Stats> {
    return await fs.stat(filePath);
  }

  async listDirectory(directoryPath: string): Promise<string[]> {
    try {
      return await fs.readdir(directoryPath);
    } catch (error) {
      logger.error(`Failed to list directory: ${directoryPath}`, error);
      throw error;
    }
  }

  async listDirectoryWithTypes(directoryPath: string): Promise<Array<{name: string, isDirectory: boolean, isFile: boolean}>> {
    try {
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      return entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile()
      }));
    } catch (error) {
      logger.error(`Failed to list directory with types: ${directoryPath}`, error);
      throw error;
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    try {
      const validatedOldPath = await this.enforceWriteAllowlist(oldPath, 'renameFile:source');
      const validatedNewPath = await this.enforceWriteAllowlist(newPath, 'renameFile:destination');
      await fs.rename(validatedOldPath, validatedNewPath);
    } catch (error) {
      logger.error(`Failed to rename file from ${oldPath} to ${newPath}`, error);
      throw error;
    }
  }

  resolvePath(relativePath: string, baseDirectory: string): string {
    // Use the existing validatePath utility which handles resolution and traversal checks
    // But here we just want resolution + validation
    try {
       // validatePath from InputValidator throws if invalid
       validatePath(relativePath, baseDirectory);
       return path.resolve(baseDirectory, relativePath);
    } catch (error) {
      throw new Error(`Invalid path resolution: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  validatePath(filePath: string, baseDirectory: string): boolean {
    try {
      validatePath(filePath, baseDirectory);
      return true;
    } catch {
      return false;
    }
  }

  /** Serialize cooperating writers across processes without stealing a slow writer's lock. */
  async withWriteLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const validatedPath = await this.enforceWriteAllowlist(filePath, 'withWriteLock');
    await this.enforceWriteAllowlist(`${validatedPath}.lock`, 'withWriteLock');
    const lock = new FileLock(validatedPath);
    const result = await lock.withLock(operation, { stale: Infinity });
    if (result === null) {
      throw new Error('Could not acquire file write lock. If its owner has exited, stop all writers before removing the lock.');
    }
    return result;
  }

  async createFileExclusive(filePath: string, content: string, options: FileCreateOptions = {}): Promise<boolean> {
    try {
      const validatedPath = await this.enforceWriteAllowlist(filePath, 'createFileExclusive');
      const maxSize = options.maxSize ?? this.defaultMaxFileSize;
      if (content.length > maxSize) {
        throw new Error(`Content exceeds maximum size of ${maxSize} bytes`);
      }

      // Use 'wx' flag for atomic creation - fails if file already exists
      // This prevents TOCTOU race conditions
      const fileHandle = await fs.open(validatedPath, 'wx', options.mode);
      try {
        await fileHandle.writeFile(content, { encoding: options.encoding ?? 'utf-8' });
        if (options.onWritten) {
          const written = await fileHandle.stat();
          options.onWritten({ mtimeMs: written.mtimeMs, sizeBytes: written.size });
        }
      } finally {
        await fileHandle.close();
      }

      SecurityMonitor.logSecurityEvent({
        type: 'FILE_WRITTEN',
        severity: 'LOW',
        source: options.source ?? 'FileOperationsService.createFileExclusive',
        details: `File created exclusively: ${path.basename(validatedPath)}`
      });

      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // File already exists - this is expected in race condition scenarios
        return false;
      }
      logger.error(`Failed to create file exclusively: ${filePath}`, error);
      throw error;
    }
  }

  async copyFile(sourcePath: string, destPath: string, options: FileCopyOptions = {}): Promise<void> {
    try {
      const validatedDestPath = await this.enforceWriteAllowlist(destPath, 'copyFile:destination');
      // Ensure destination directory exists
      await this.createDirectory(path.dirname(validatedDestPath));

      await fs.copyFile(sourcePath, validatedDestPath, options.exclusive ? fs.constants.COPYFILE_EXCL : 0);

      SecurityMonitor.logSecurityEvent({
        type: 'FILE_WRITTEN',
        severity: 'LOW',
        source: options.source ?? 'FileOperationsService.copyFile',
        details: `File copied: ${path.basename(sourcePath)} -> ${path.basename(validatedDestPath)}`
      });
    } catch (error) {
      logger.error(`Failed to copy file from ${sourcePath} to ${destPath}`, error);
      throw error;
    }
  }

  async chmod(filePath: string, mode: number, options: FileOperationOptions = {}): Promise<void> {
    try {
      const validatedPath = await this.enforceWriteAllowlist(filePath, 'chmod');
      await fs.chmod(validatedPath, mode);

      SecurityMonitor.logSecurityEvent({
        type: 'FILE_WRITTEN',
        severity: 'LOW',
        source: options.source ?? 'FileOperationsService.chmod',
        details: `File permissions changed: ${path.basename(validatedPath)} to ${mode.toString(8)}`
      });
    } catch (error) {
      logger.error(`Failed to change permissions for ${filePath}`, error);
      throw error;
    }
  }

  async appendFile(filePath: string, content: string, options: FileWriteOptions = {}): Promise<void> {
    try {
      const validatedPath = await this.enforceWriteAllowlist(filePath, 'appendFile');
      await fs.appendFile(validatedPath, content, { encoding: options.encoding ?? 'utf-8' });

      // Only log if verbose audit is enabled to avoid log spam for telemetry
      if (this.config.verboseAudit) {
        SecurityMonitor.logSecurityEvent({
          type: 'FILE_WRITTEN',
          severity: 'LOW',
          source: options.source ?? 'FileOperationsService.appendFile',
          details: `Content appended to file: ${path.basename(validatedPath)}`
        });
      }
    } catch (error) {
      logger.error(`Failed to append to file: ${filePath}`, error);
      throw error;
    }
  }

  private async enforceWriteAllowlist(filePath: string, opName: string): Promise<string> {
    const activeContainer = this.sessionContainerRegistryProvider?.()?.getActiveContainer();
    if (!activeContainer) {
      return filePath;
    }

    try {
      const pathValidator = activeContainer.resolve<{
        enforceWritablePath(filePath: string): Promise<string>;
      }>('PathValidator');
      return await pathValidator.enforceWritablePath(filePath);
    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: 'WRITE_SANDBOX_VIOLATION',
        severity: 'HIGH',
        source: 'FileOperationsService.enforceWriteAllowlist',
        details: `Write sandbox violation during ${opName}: ${path.basename(filePath)}`,
        additionalData: { operation: opName },
      });
      throw error;
    }
  }
}
