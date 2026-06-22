import { promises as fs, Stats } from 'fs';
import * as path from 'path';
import { FileLockManager } from '../security/fileLockManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { logger } from '../utils/logger.js';
import { ElementType } from '../portfolio/types.js';
import { validatePath } from '../security/InputValidator.js';

interface ActiveSessionContainerRegistry {
  getActiveContainer(): {
    resolve<T>(name: string): T;
  } | undefined;
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
}

export interface FileOperationOptions {
  source?: string;
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

  /**
   * Write a file securely with atomic locking
   * @param filePath - Absolute path to file
   * @param content - Content to write
   * @param options - Write options
   */
  writeFile(filePath: string, content: string, options?: FileWriteOptions): Promise<void>;

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
  createDirectory(directoryPath: string): Promise<void>;

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
  createFileExclusive(filePath: string, content: string, options?: FileWriteOptions): Promise<boolean>;

  /**
   * Copy a file from source to destination
   * @param sourcePath - Absolute path to source file
   * @param destPath - Absolute path to destination
   * @param options - Operation options
   */
  copyFile(sourcePath: string, destPath: string, options?: FileOperationOptions): Promise<void>;

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
  private fileLockManager: FileLockManager;
  private readonly defaultMaxFileSize: number;
  private config: FileOperationsConfig;
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

    // Log security event for element access when verbose audit is enabled
    // This is configurable to avoid log spam in production while allowing
    // detailed audit trails when needed (e.g., for compliance or debugging)
    if (this.config.verboseAudit) {
      SecurityMonitor.logSecurityEvent({
        type: 'FILE_READ',
        severity: 'LOW',
        source: options.source ?? 'FileOperationsService.readElementFile',
        details: `Read ${elementType} file: ${path.basename(filePath)}`
      });
    }

    return content;
  }

  async writeFile(filePath: string, content: string, options: FileWriteOptions = {}): Promise<void> {
    try {
      const validatedPath = await this.enforceWriteAllowlist(filePath, 'writeFile');
      const maxSize = options.maxSize ?? this.defaultMaxFileSize;
      if (content.length > maxSize) {
        throw new Error(`Content exceeds maximum size of ${maxSize} bytes`);
      }

      await this.fileLockManager.atomicWriteFile(validatedPath, content, {
        encoding: options.encoding ?? 'utf-8'
      });

      SecurityMonitor.logSecurityEvent({
        type: 'FILE_WRITTEN',
        severity: 'LOW',
        source: options.source ?? 'FileOperationsService.writeFile',
        details: `File written successfully: ${path.basename(validatedPath)}`
      });
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

  async createDirectory(directoryPath: string): Promise<void> {
    try {
      const validatedPath = await this.enforceWriteAllowlist(directoryPath, 'createDirectory');
      await fs.mkdir(validatedPath, { recursive: true });
    } catch (error) {
      logger.error(`Failed to create directory: ${directoryPath}`, error);
      throw error;
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
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

  async createFileExclusive(filePath: string, content: string, options: FileWriteOptions = {}): Promise<boolean> {
    try {
      const validatedPath = await this.enforceWriteAllowlist(filePath, 'createFileExclusive');
      const maxSize = options.maxSize ?? this.defaultMaxFileSize;
      if (content.length > maxSize) {
        throw new Error(`Content exceeds maximum size of ${maxSize} bytes`);
      }

      // Use 'wx' flag for atomic creation - fails if file already exists
      // This prevents TOCTOU race conditions
      const fileHandle = await fs.open(validatedPath, 'wx');
      try {
        await fileHandle.writeFile(content, { encoding: options.encoding ?? 'utf-8' });
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

  async copyFile(sourcePath: string, destPath: string, options: FileOperationOptions = {}): Promise<void> {
    try {
      const validatedDestPath = await this.enforceWriteAllowlist(destPath, 'copyFile:destination');
      // Ensure destination directory exists
      await this.createDirectory(path.dirname(validatedDestPath));

      await fs.copyFile(sourcePath, validatedDestPath);

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
