import { logger } from '../utils/logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';

/**
 * FileLockManager - Prevents race conditions in concurrent file operations
 * 
 * Features:
 * - Resource-based locking with automatic cleanup
 * - Configurable timeouts to prevent deadlocks
 * - Atomic file operations with write-rename pattern
 * - Lock queueing for concurrent requests
 * - Comprehensive error handling and logging
 * - Performance metrics tracking
 */
export class FileLockManager {
  // Map of resource identifiers to their lock promises
  private static locks = new Map<string, Promise<any>>();
  
  // Lock acquisition metrics for monitoring
  private static metrics = {
    totalLockRequests: 0,
    lockWaitTime: new Map<string, number[]>(),
    lockTimeouts: 0,
    concurrentWaits: 0
  };

  // Default timeout for lock operations (10 seconds)
  private static readonly DEFAULT_TIMEOUT_MS = 10000;
  
  // Temporary file directory
  private static readonly TEMP_DIR = '.tmp';

  /**
   * Execute an operation with exclusive lock on a resource
   * @param resource - Unique identifier for the resource (e.g., 'persona:name')
   * @param operation - Async function to execute while holding the lock
   * @param options - Lock options including timeout
   * @returns Result of the operation
   */
  static async withLock<T>(
    resource: string,
    operation: () => Promise<T>,
    options: { timeout?: number } = {}
  ): Promise<T> {
    const startTime = Date.now();
    this.metrics.totalLockRequests++;
    
    logger.debug(`Lock requested for resource: ${resource}`);
    
    // Wait for any existing operation on this resource
    const existingLock = this.locks.get(resource);
    if (existingLock) {
      this.metrics.concurrentWaits++;
      logger.debug(`Waiting for existing lock on: ${resource}`);
      
      try {
        await existingLock;
      } catch (error) {
        // Previous operation failed, but we can proceed
        logger.debug(`Previous operation on ${resource} failed, proceeding`);
      }
    }
    
    // Create new lock for this operation
    const timeout = options.timeout || this.DEFAULT_TIMEOUT_MS;
    const lockPromise = this.executeWithTimeout(operation, timeout, resource);
    this.locks.set(resource, lockPromise);
    
    try {
      const result = await lockPromise;
      
      // Record metrics
      const waitTime = Date.now() - startTime;
      if (!this.metrics.lockWaitTime.has(resource)) {
        this.metrics.lockWaitTime.set(resource, []);
      }
      this.metrics.lockWaitTime.get(resource)!.push(waitTime);
      
      logger.debug(`Lock released for resource: ${resource} (${waitTime}ms)`);
      return result;
    } finally {
      // Clean up lock atomically - compare and delete in one operation
      const currentLock = this.locks.get(resource);
      if (currentLock === lockPromise) {
        this.locks.delete(resource);
        logger.debug(`Lock queue cleaned up for resource: ${resource}`);
      }
    }
  }

  /**
   * Execute operation with timeout protection
   */
  private static async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    resource: string
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        this.metrics.lockTimeouts++;
        reject(new Error(`Lock operation timeout for resource: ${resource}`));
      }, timeoutMs);
    });
    
    try {
      const result = await Promise.race([operation(), timeoutPromise]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      return result;
    } catch (error) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      throw error;
    }
  }

  /**
   * Perform atomic file write operation
   * Writes to temporary file then renames to ensure atomicity
   */
  static async atomicWriteFile(
    filePath: string,
    content: string,
    options?: { encoding?: BufferEncoding }
  ): Promise<void> {
    const tempPath = await this.getTempFilePath(filePath);
    const dir = path.dirname(tempPath);
    
    try {
      // Ensure temp directory exists
      await fs.mkdir(dir, { recursive: true });
      
      // Write to temporary file
      await fs.writeFile(tempPath, content, options);
      
      // Atomic rename (on same filesystem)
      await fs.rename(tempPath, filePath);
      
      logger.debug(`Atomic write completed: ${filePath}`);
    } catch (error) {
      // Clean up temp file on error
      try {
        await fs.unlink(tempPath);
        logger.debug(`Cleaned up temp file after error: ${tempPath}`);
      } catch (unlinkError) {
        // Log cleanup failure but don't throw - original error is more important
        logger.warn(`Failed to clean up temp file ${tempPath}: ${unlinkError}`);
      }
      throw error;
    }
  }

  /**
   * Perform atomic file read with lock
   */
  static async atomicReadFile(
    filePath: string,
    options?: { encoding?: BufferEncoding }
  ): Promise<string> {
    return this.withLock(`file:${filePath}`, async () => {
      const content = await fs.readFile(filePath, options);
      return content.toString();
    });
  }

  /**
   * Generate temporary file path for atomic operations
   */
  private static async getTempFilePath(originalPath: string): Promise<string> {
    const dir = path.dirname(originalPath);
    const basename = path.basename(originalPath);
    const random = randomBytes(8).toString('hex');
    return path.join(dir, this.TEMP_DIR, `${basename}.${random}.tmp`);
  }

  /**
   * Get lock metrics for monitoring
   */
  static getMetrics() {
    const avgWaitTimes = new Map<string, number>();
    for (const [resource, times] of this.metrics.lockWaitTime.entries()) {
      if (times.length > 0) {
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        avgWaitTimes.set(resource, Math.round(avg));
      }
    }
    
    return {
      totalRequests: this.metrics.totalLockRequests,
      activeLocksCount: this.locks.size,
      timeouts: this.metrics.lockTimeouts,
      concurrentWaits: this.metrics.concurrentWaits,
      avgWaitTimeByResource: Object.fromEntries(avgWaitTimes),
      activeLocks: Array.from(this.locks.keys())
    };
  }

  /**
   * Clear all locks (use with caution - mainly for testing)
   */
  static clearAllLocks(): void {
    this.locks.clear();
    logger.warn('All file locks cleared - use only for testing/recovery');
  }

  /**
   * Reset metrics
   */
  static resetMetrics(): void {
    this.metrics = {
      totalLockRequests: 0,
      lockWaitTime: new Map<string, number[]>(),
      lockTimeouts: 0,
      concurrentWaits: 0
    };
  }
}