import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';

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

  static async validatePersonaPath(userPath: string): Promise<string> {
    if (!userPath || typeof userPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }

    // Remove any null bytes
    const cleanPath = userPath.replace(/\x00/g, '');
    
    // Normalize and resolve path
    const normalizedPath = path.normalize(cleanPath);
    const resolvedPath = path.resolve(normalizedPath);
    
    // Check for path traversal attempts
    if (normalizedPath.includes('..') || cleanPath.includes('..')) {
      logger.warn('Path traversal attempt detected', { userPath });
      throw new Error('Path traversal detected');
    }
    
    // Check if path is within allowed directories
    if (this.ALLOWED_DIRECTORIES.length === 0) {
      // If not initialized, allow paths under current working directory's personas folder
      const defaultAllowed = [
        path.resolve('./personas'),
        path.resolve(process.env.PERSONAS_DIR || './personas')
      ];
      const isAllowed = defaultAllowed.some(allowedDir => 
        resolvedPath.startsWith(allowedDir + path.sep) || 
        resolvedPath === allowedDir
      );
      if (!isAllowed) {
        throw new Error(`Path access denied: ${userPath}`);
      }
    } else {
      const isAllowed = this.ALLOWED_DIRECTORIES.some(allowedDir => 
        resolvedPath.startsWith(allowedDir + path.sep) || 
        resolvedPath === allowedDir
      );
      
      if (!isAllowed) {
        throw new Error(`Path access denied: ${userPath}`);
      }
    }
    
    // Validate filename if it's a file
    if (path.extname(resolvedPath)) {
      const filename = path.basename(resolvedPath);
      const ext = path.extname(filename).toLowerCase();
      
      // Check if extension is allowed
      if (!this.ALLOWED_EXTENSIONS.includes(ext)) {
        throw new Error(`File extension not allowed: ${ext}. Allowed: ${this.ALLOWED_EXTENSIONS.join(', ')}`);
      }
      
      // Validate filename format (alphanumeric, dash, underscore, dot)
      if (!/^[a-zA-Z0-9\-_.]+$/i.test(filename)) {
        throw new Error(`Invalid filename format: ${filename}`);
      }
    }
    
    return resolvedPath;
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