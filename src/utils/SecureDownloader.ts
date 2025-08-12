/**
 * SecureDownloader - Reusable utility for safe content downloads
 * 
 * Implements the validate-before-write pattern with comprehensive security features:
 * - Content validation hooks (customizable validators)
 * - Atomic file operations with temp files
 * - Guaranteed cleanup on failure
 * - Memory-efficient streaming for large files
 * - Size limits to prevent DoS attacks
 * - Path validation to prevent traversal
 * - Timeout handling for network operations
 * - Content type validation
 * 
 * Usage Examples:
 * 
 * // Basic download with validation
 * const downloader = new SecureDownloader();
 * await downloader.downloadToFile(
 *   'https://example.com/file.md',
 *   './downloads/file.md',
 *   {
 *     validator: async (content) => ({
 *       isValid: !content.includes('malicious'),
 *       errorMessage: content.includes('malicious') ? 'Malicious content detected' : undefined
 *     }),
 *     maxSize: 1024 * 1024, // 1MB limit
 *     timeout: 30000 // 30 second timeout
 *   }
 * );
 * 
 * // Download to memory with validation
 * const content = await downloader.downloadToMemory(
 *   'https://example.com/data.json',
 *   {
 *     validator: async (content) => {
 *       try {
 *         JSON.parse(content);
 *         return { isValid: true };
 *       } catch {
 *         return { isValid: false, errorMessage: 'Invalid JSON format' };
 *       }
 *     }
 *   }
 * );
 * 
 * // Streaming download for large files
 * await downloader.downloadStream(
 *   'https://example.com/large-file.zip',
 *   './downloads/large-file.zip',
 *   {
 *     streamValidator: (chunk) => !chunk.includes(Buffer.from('VIRUS')),
 *     maxSize: 100 * 1024 * 1024, // 100MB limit
 *     timeout: 300000 // 5 minute timeout
 *   }
 * );
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes, createHash } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

import { SecurityError } from '../errors/SecurityError.js';
import { SECURITY_LIMITS } from '../security/constants.js';
import { ContentValidator as SecurityContentValidator } from '../security/contentValidator.js';
import { PathValidator } from '../security/pathValidator.js';
import { FileLockManager } from '../security/fileLockManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { logger } from './logger.js';

/**
 * Result of content validation
 */
export interface ValidationResult {
  /** Whether the content is valid and safe */
  isValid: boolean;
  /** Error message if validation failed */
  errorMessage?: string;
  /** Severity of any detected issues */
  severity?: 'low' | 'medium' | 'high' | 'critical';
  /** Additional metadata about validation */
  metadata?: Record<string, any>;
}

/**
 * Content validator function type
 */
export type ContentValidatorFunction = (content: string) => Promise<ValidationResult>;

/**
 * Stream chunk validator function type
 */
export type StreamValidator = (chunk: Uint8Array) => boolean;

/**
 * Options for download operations
 */
export interface DownloadOptions {
  /** Custom content validator function */
  validator?: ContentValidatorFunction;
  /** Maximum file size in bytes (default: SECURITY_LIMITS.MAX_FILE_SIZE) */
  maxSize?: number;
  /** Network timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Whether to use atomic file operations (default: true) */
  atomic?: boolean;
  /** Expected content type (for validation) */
  expectedContentType?: string;
  /** Custom HTTP headers */
  headers?: Record<string, string>;
}

/**
 * Options for streaming downloads
 */
export interface StreamDownloadOptions {
  /** Chunk-level validator for streaming validation */
  streamValidator?: StreamValidator;
  /** Maximum file size in bytes (default: SECURITY_LIMITS.MAX_FILE_SIZE) */
  maxSize?: number;
  /** Network timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Custom HTTP headers */
  headers?: Record<string, string>;
}

/**
 * Custom error types for different failure scenarios
 */
export class DownloadError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'DownloadError';
  }

  static networkError(message: string, originalError?: Error): DownloadError {
    return new DownloadError(message, 'NETWORK_ERROR', originalError);
  }

  static validationError(message: string): DownloadError {
    return new DownloadError(message, 'VALIDATION_ERROR');
  }

  static securityError(message: string): DownloadError {
    return new DownloadError(message, 'SECURITY_ERROR');
  }

  static timeoutError(message: string): DownloadError {
    return new DownloadError(message, 'TIMEOUT_ERROR');
  }

  static filesystemError(message: string, originalError?: Error): DownloadError {
    return new DownloadError(message, 'FILESYSTEM_ERROR', originalError);
  }
}

/**
 * SecureDownloader - Implements validate-before-write pattern for safe downloads
 * 
 * Key Security Features:
 * 1. VALIDATE-BEFORE-WRITE: All content validation occurs before any disk operations
 * 2. ATOMIC OPERATIONS: Uses temporary files with atomic rename to prevent corruption
 * 3. GUARANTEED CLEANUP: Automatic cleanup of temporary files on any failure
 * 4. SIZE LIMITS: Prevents DoS attacks through large file downloads
 * 5. PATH VALIDATION: Prevents directory traversal attacks
 * 6. TIMEOUT PROTECTION: Prevents hanging network operations
 * 7. CONTENT VALIDATION: Extensible validation system for different content types
 */
export class SecureDownloader {
  private readonly defaultTimeout: number;
  private readonly defaultMaxSize: number;
  private readonly tempDir: string;

  constructor(options?: {
    defaultTimeout?: number;
    defaultMaxSize?: number;
    tempDir?: string;
  }) {
    this.defaultTimeout = options?.defaultTimeout || 30000; // 30 seconds
    this.defaultMaxSize = options?.defaultMaxSize || SECURITY_LIMITS.MAX_FILE_SIZE;
    this.tempDir = options?.tempDir || '.tmp';
  }

  /**
   * Download content to a file with validation
   * 
   * SECURITY: Implements validate-before-write pattern:
   * 1. Download content to memory
   * 2. Validate all content
   * 3. Only then write to disk atomically
   * 
   * @param url - URL to download from
   * @param destinationPath - Local file path to save to
   * @param options - Download and validation options
   */
  async downloadToFile(
    url: string,
    destinationPath: string,
    options: DownloadOptions = {}
  ): Promise<void> {
    const startTime = Date.now();
    logger.debug(`Starting secure download from ${url} to ${destinationPath}`);

    try {
      // SECURITY: Validate URL and destination path first
      this.validateUrl(url);
      const validatedPath = await this.validateDestinationPath(destinationPath);

      // SECURITY: Check if file already exists (prevent accidental overwrites)
      try {
        await fs.access(validatedPath);
        throw DownloadError.filesystemError(`File already exists: ${destinationPath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error; // Re-throw if it's not a "file not found" error
        }
        // File doesn't exist, proceed with download
      }

      // STEP 1: Download content to memory (no disk operations yet)
      const content = await this.downloadToMemory(url, options);

      // STEP 2: All validation is complete, now write atomically
      const useAtomic = options.atomic !== false; // Default to true
      if (useAtomic) {
        await this.atomicWriteFile(validatedPath, content);
      } else {
        await this.directWriteFile(validatedPath, content);
      }

      const duration = Date.now() - startTime;
      logger.info(`Secure download completed: ${destinationPath} (${content.length} bytes, ${duration}ms)`);

      // Log successful download for security monitoring
      SecurityMonitor.logSecurityEvent({
        type: 'FILE_COPIED',
        severity: 'LOW',
        source: 'secure_downloader',
        details: `Downloaded ${content.length} bytes from ${url} to ${destinationPath}`,
        metadata: {
          url,
          destinationPath,
          contentLength: content.length,
          duration
        }
      });

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`Secure download failed: ${error instanceof Error ? error.message : String(error)}`);

      // Log failed download for security monitoring
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'MEDIUM',
        source: 'secure_downloader',
        details: `Download failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: {
          url,
          destinationPath,
          duration,
          errorType: error instanceof DownloadError ? error.code : 'UNKNOWN'
        }
      });

      throw error;
    }
  }

  /**
   * Download content to memory with validation
   * 
   * @param url - URL to download from
   * @param options - Download and validation options
   * @returns Validated content as string
   */
  async downloadToMemory(
    url: string,
    options: DownloadOptions = {}
  ): Promise<string> {
    const timeout = options.timeout || this.defaultTimeout;
    const maxSize = options.maxSize || this.defaultMaxSize;

    logger.debug(`Downloading content from ${url} (max: ${maxSize} bytes, timeout: ${timeout}ms)`);

    try {
      // SECURITY: Validate URL format
      this.validateUrl(url);

      // STEP 1: Fetch content with size and timeout protection
      const content = await this.fetchWithLimits(url, maxSize, timeout, options.headers);

      // STEP 2: Validate content type if specified
      if (options.expectedContentType) {
        await this.validateContentType(content, options.expectedContentType);
      }

      // STEP 3: Run built-in security validation
      const securityResult = SecurityContentValidator.validateAndSanitize(content);
      if (!securityResult.isValid && securityResult.severity === 'critical') {
        throw DownloadError.securityError(
          `Critical security threat detected: ${securityResult.detectedPatterns?.join(', ')}`
        );
      }

      // STEP 4: Run custom validator if provided
      if (options.validator) {
        logger.debug('Running custom content validation');
        const validationResult = await options.validator(content);
        if (!validationResult.isValid) {
          throw DownloadError.validationError(
            validationResult.errorMessage || 'Content validation failed'
          );
        }
      }

      logger.debug(`Content validation passed (${content.length} bytes)`);
      return securityResult.sanitizedContent || content;

    } catch (error) {
      if (error instanceof DownloadError) {
        throw error;
      }
      throw DownloadError.networkError(
        `Failed to download content from ${url}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Download large files using streaming with chunk-level validation
   * 
   * @param url - URL to download from
   * @param destinationPath - Local file path to save to
   * @param options - Streaming download options
   */
  async downloadStream(
    url: string,
    destinationPath: string,
    options: StreamDownloadOptions = {}
  ): Promise<void> {
    const startTime = Date.now();
    const maxSize = options.maxSize || this.defaultMaxSize;
    const timeout = options.timeout || this.defaultTimeout;

    logger.debug(`Starting streaming download from ${url} to ${destinationPath}`);

    try {
      // SECURITY: Validate URL and destination path
      this.validateUrl(url);
      const validatedPath = await this.validateDestinationPath(destinationPath);

      // Generate temporary file path for atomic operation
      const tempPath = await this.getTempFilePath(validatedPath);

      let downloadedSize = 0;
      let timeoutHandle: NodeJS.Timeout | undefined;

      // Create abort controller for timeout handling
      const abortController = new AbortController();
      timeoutHandle = setTimeout(() => {
        abortController.abort();
      }, timeout);

      try {
        // SECURITY: Fetch with abort signal for timeout
        const response = await fetch(url, {
          signal: abortController.signal,
          headers: options.headers
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error('Response body is null');
        }

        // Ensure temp directory exists
        await fs.mkdir(path.dirname(tempPath), { recursive: true });

        // Create write stream to temporary file
        const writeStream = createWriteStream(tempPath);

        // Create a transform stream for validation and size checking
        const validationStream = new Readable({
          async read() {
            // This stream will be fed by the pipeline
          }
        });

        // Set up chunk validation and size checking
        const reader = response.body.getReader();
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              // SECURITY: Check size limit
              downloadedSize += value.length;
              if (downloadedSize > maxSize) {
                throw DownloadError.securityError(
                  `File size exceeds limit: ${downloadedSize} > ${maxSize} bytes`
                );
              }

              // SECURITY: Run chunk validator if provided
              if (options.streamValidator && !options.streamValidator(value)) {
                throw DownloadError.validationError('Chunk validation failed');
              }

              validationStream.push(value);
            }
            validationStream.push(null); // End stream
          } catch (error) {
            validationStream.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        };

        // Start the pump and pipeline concurrently
        const [pumpResult] = await Promise.all([
          pump(),
          pipeline(validationStream, writeStream)
        ]);

        // Clear timeout
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }

        // SECURITY: Atomic rename to final destination
        await fs.rename(tempPath, validatedPath);

        const duration = Date.now() - startTime;
        logger.info(`Streaming download completed: ${destinationPath} (${downloadedSize} bytes, ${duration}ms)`);

        // Log successful streaming download
        SecurityMonitor.logSecurityEvent({
          type: 'FILE_COPIED',
          severity: 'LOW',
          source: 'secure_downloader',
          details: `Streamed ${downloadedSize} bytes from ${url} to ${destinationPath}`,
          metadata: {
            url,
            destinationPath,
            contentLength: downloadedSize,
            duration
          }
        });

      } catch (error) {
        // SECURITY: Guaranteed cleanup of temporary file
        try {
          await fs.unlink(tempPath);
          logger.debug(`Cleaned up temp file: ${tempPath}`);
        } catch (cleanupError) {
          logger.warn(`Failed to clean up temp file ${tempPath}: ${cleanupError}`);
        }
        throw error;
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`Streaming download failed: ${error instanceof Error ? error.message : String(error)}`);

      // Log failed streaming download
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'MEDIUM',
        source: 'secure_downloader',
        details: `Streaming download failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: {
          url,
          destinationPath,
          duration,
          errorType: error instanceof DownloadError ? error.code : 'UNKNOWN'
        }
      });

      if (error instanceof Error && error.name === 'AbortError') {
        throw DownloadError.timeoutError(`Download timed out after ${timeout}ms`);
      }

      if (error instanceof DownloadError) {
        throw error;
      }

      throw DownloadError.networkError(
        `Streaming download failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Validate URL format and security
   */
  private validateUrl(url: string): void {
    if (!url || typeof url !== 'string') {
      throw DownloadError.validationError('URL must be a non-empty string');
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      throw DownloadError.validationError(`Invalid URL format: ${url}`);
    }

    // SECURITY: Only allow HTTPS and HTTP protocols
    if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
      throw DownloadError.securityError(`Unsupported protocol: ${parsedUrl.protocol}. Only HTTP/HTTPS allowed.`);
    }

    // SECURITY: Prevent requests to localhost/private networks
    const hostname = parsedUrl.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      throw DownloadError.securityError('Downloads from localhost are not allowed');
    }

    // SECURITY: Check for private IP ranges (basic protection)
    if (hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.startsWith('172.')) {
      throw DownloadError.securityError('Downloads from private IP ranges are not allowed');
    }
  }

  /**
   * Validate destination path for security
   */
  private async validateDestinationPath(filePath: string): Promise<string> {
    try {
      // Use existing PathValidator for comprehensive path validation
      return await PathValidator.validatePersonaPath(filePath);
    } catch (error) {
      throw DownloadError.securityError(
        `Invalid destination path: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Fetch content with size and timeout limits
   */
  private async fetchWithLimits(
    url: string,
    maxSize: number,
    timeout: number,
    headers?: Record<string, string>
  ): Promise<string> {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeout);

    try {
      const response = await fetch(url, {
        signal: abortController.signal,
        headers: {
          'User-Agent': 'DollhouseMCP-SecureDownloader/1.0',
          ...headers
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // SECURITY: Check Content-Length header if available
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxSize) {
        throw DownloadError.securityError(
          `Content size ${contentLength} exceeds limit of ${maxSize} bytes`
        );
      }

      // Read content with size checking
      const chunks: Uint8Array[] = [];
      let totalSize = 0;

      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          totalSize += value.length;
          if (totalSize > maxSize) {
            throw DownloadError.securityError(
              `Content size ${totalSize} exceeds limit of ${maxSize} bytes`
            );
          }

          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      // Combine chunks and decode
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      return new TextDecoder('utf-8').decode(combined);

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw DownloadError.timeoutError(`Request timed out after ${timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Validate content type if specified
   */
  private async validateContentType(content: string, expectedType: string): Promise<void> {
    // Basic content type validation based on content analysis
    switch (expectedType.toLowerCase()) {
      case 'json':
        try {
          JSON.parse(content);
        } catch {
          throw DownloadError.validationError('Content is not valid JSON');
        }
        break;
      case 'yaml':
      case 'yml':
        // Use existing YAML validation
        if (!SecurityContentValidator.validateYamlContent(content)) {
          throw DownloadError.validationError('Content is not valid YAML');
        }
        break;
      case 'markdown':
      case 'md':
        // Basic markdown validation (check for frontmatter format)
        if (content.startsWith('---')) {
          const frontmatterEnd = content.indexOf('\n---\n', 3);
          if (frontmatterEnd === -1) {
            throw DownloadError.validationError('Invalid markdown frontmatter format');
          }
        }
        break;
      default:
        logger.debug(`No specific validation for content type: ${expectedType}`);
    }
  }

  /**
   * Atomic file write using FileLockManager
   */
  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const resource = `download:${filePath}`;
    
    await FileLockManager.withLock(resource, async () => {
      // Ensure directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      
      // Use FileLockManager's atomic write
      await FileLockManager.atomicWriteFile(filePath, content, { encoding: 'utf-8' });
    });
  }

  /**
   * Direct file write (non-atomic, for when atomic is disabled)
   */
  private async directWriteFile(filePath: string, content: string): Promise<void> {
    // Ensure directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    
    // Direct write
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Generate temporary file path for atomic operations
   */
  private async getTempFilePath(originalPath: string): Promise<string> {
    const dir = path.dirname(originalPath);
    const basename = path.basename(originalPath);
    const random = randomBytes(8).toString('hex');
    const tempDir = path.join(dir, this.tempDir);
    
    // Ensure temp directory exists
    await fs.mkdir(tempDir, { recursive: true });
    
    return path.join(tempDir, `${basename}.${random}.tmp`);
  }

  /**
   * Create a content validator that combines multiple validators
   */
  static combineValidators(...validators: ContentValidatorFunction[]): ContentValidatorFunction {
    return async (content: string): Promise<ValidationResult> => {
      for (const validator of validators) {
        const result = await validator(content);
        if (!result.isValid) {
          return result;
        }
      }
      return { isValid: true };
    };
  }

  /**
   * Create a content validator for JSON content
   */
  static jsonValidator(): ContentValidatorFunction {
    return async (content: string): Promise<ValidationResult> => {
      try {
        JSON.parse(content);
        return { isValid: true };
      } catch (error) {
        return {
          isValid: false,
          errorMessage: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          severity: 'medium'
        };
      }
    };
  }

  /**
   * Create a content validator for YAML content
   */
  static yamlValidator(): ContentValidatorFunction {
    return async (content: string): Promise<ValidationResult> => {
      const isValid = SecurityContentValidator.validateYamlContent(content);
      return {
        isValid,
        errorMessage: isValid ? undefined : 'Invalid or malicious YAML content',
        severity: isValid ? 'low' : 'high'
      };
    };
  }

  /**
   * Create a content validator for markdown content
   */
  static markdownValidator(): ContentValidatorFunction {
    return async (content: string): Promise<ValidationResult> => {
      try {
        // Use existing persona content sanitization for markdown
        SecurityContentValidator.sanitizePersonaContent(content);
        return { isValid: true };
      } catch (error) {
        return {
          isValid: false,
          errorMessage: `Invalid markdown: ${error instanceof Error ? error.message : String(error)}`,
          severity: error instanceof SecurityError ? 'critical' : 'medium'
        };
      }
    };
  }

  /**
   * Create a content validator with size limits
   */
  static sizeValidator(maxSize: number): ContentValidatorFunction {
    return async (content: string): Promise<ValidationResult> => {
      const size = Buffer.byteLength(content, 'utf-8');
      if (size > maxSize) {
        return {
          isValid: false,
          errorMessage: `Content size ${size} exceeds limit of ${maxSize} bytes`,
          severity: 'high'
        };
      }
      return { isValid: true };
    };
  }

  /**
   * Create a content validator that checks for forbidden patterns
   */
  static patternValidator(
    forbiddenPatterns: RegExp[],
    errorMessage: string = 'Forbidden pattern detected'
  ): ContentValidatorFunction {
    return async (content: string): Promise<ValidationResult> => {
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(content)) {
          return {
            isValid: false,
            errorMessage,
            severity: 'high',
            metadata: { pattern: pattern.source }
          };
        }
      }
      return { isValid: true };
    };
  }
}