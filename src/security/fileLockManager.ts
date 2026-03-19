import { logger } from '../utils/logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { getValidatedLockTimeout } from '../config/performance-constants.js';

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
  private locks = new Map<string, Promise<any>>();

  // Lock acquisition metrics for monitoring
  private metrics = {
    totalLockRequests: 0,
    lockWaitTime: new Map<string, number[]>(),
    lockTimeouts: 0,
    concurrentWaits: 0
  };

  private logListener?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;

  addLogListener(fn: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void): () => void {
    this.logListener = fn;
    return () => { this.logListener = undefined; };
  }

  // Default timeout for lock operations - using centralized configuration
  private readonly DEFAULT_TIMEOUT_MS = getValidatedLockTimeout();

  // Temporary file directory
  private readonly TEMP_DIR = '.tmp';

  /**
   * Execute an operation with exclusive lock on a resource
   * @param resource - Unique identifier for the resource (e.g., 'persona:name')
   * @param operation - Async function to execute while holding the lock
   * @param options - Lock options including timeout
   * @returns Result of the operation
   */
  async withLock<T>(
    resource: string,
    operation: () => Promise<T>,
    options: { timeout?: number } = {}
  ): Promise<T> {
    const startTime = Date.now();
    this.metrics.totalLockRequests++;
    
    // Wait for any existing operation on this resource
    const existingLock = this.locks.get(resource);
    if (existingLock) {
      this.metrics.concurrentWaits++;
      const shortResource = path.basename(resource);
      logger.debug(`Lock contention on: ${shortResource}`, { resource });
      this.logListener?.('debug', 'Detect lock contention', { resource });
      
      try {
        await existingLock;
      } catch {
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
      
      // Only log locks that actually waited (>5ms indicates real contention)
      if (waitTime > 5) {
        const shortResource = path.basename(resource);
        logger.debug(`Slow lock: ${shortResource} (${waitTime}ms)`);
      }
      return result;
    } finally {
      // Clean up lock - unconditional delete is safe and race-free
      // This operation completed, so remove its lock from the map
      this.locks.delete(resource);
    }
  }

  /**
   * Execute operation with timeout protection
   */
  private async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    resource: string
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        this.metrics.lockTimeouts++;
        this.logListener?.('warn', 'Lock acquisition times out', { resource, timeoutMs });
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
  async atomicWriteFile(
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
  async atomicReadFile(
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
  private async getTempFilePath(originalPath: string): Promise<string> {
    const dir = path.dirname(originalPath);
    const basename = path.basename(originalPath);
    const random = randomBytes(8).toString('hex');
    return path.join(dir, this.TEMP_DIR, `${basename}.${random}.tmp`);
  }

  /**
   * Get lock metrics for monitoring
   */
  getMetrics() {
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
  clearAllLocks(): void {
    this.locks.clear();
    logger.warn('All file locks cleared - use only for testing/recovery');
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      totalLockRequests: 0,
      lockWaitTime: new Map<string, number[]>(),
      lockTimeouts: 0,
      concurrentWaits: 0
    };
  }
}