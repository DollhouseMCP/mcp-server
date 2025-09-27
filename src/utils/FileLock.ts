/**
 * File locking utility for preventing race conditions
 *
 * Uses advisory locks with timeout and retry logic
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './logger.js';

export interface LockOptions {
  timeout?: number;        // Max time to wait for lock (ms)
  retryInterval?: number;  // Time between retries (ms)
  stale?: number;         // Consider lock stale after this time (ms)
}

export class FileLock {
  private lockPath: string;
  private acquired: boolean = false;
  private lockId: string;

  constructor(filePath: string) {
    this.lockPath = `${filePath}.lock`;
    this.lockId = `${process.pid}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Acquire a lock on the file
   */
  public async acquire(options: LockOptions = {}): Promise<boolean> {
    const {
      timeout = 5000,
      retryInterval = 100,
      stale = 30000  // 30 seconds
    } = options;

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        // Try to create lock file exclusively
        const handle = await fs.open(this.lockPath, 'wx');

        // Write lock info
        await handle.write(JSON.stringify({
          pid: process.pid,
          id: this.lockId,
          timestamp: Date.now(),
          hostname: process.env.HOSTNAME || 'unknown'
        }));

        await handle.close();
        this.acquired = true;

        logger.debug('File lock acquired', {
          lock: this.lockPath,
          id: this.lockId
        });

        return true;
      } catch (error) {
        if ((error as any).code === 'EEXIST') {
          // Lock file exists, check if it's stale
          try {
            const lockData = await fs.readFile(this.lockPath, 'utf-8');
            const lock = JSON.parse(lockData);

            if (Date.now() - lock.timestamp > stale) {
              // Lock is stale, remove it
              logger.warn('Removing stale lock', {
                lock: this.lockPath,
                age: Date.now() - lock.timestamp
              });

              await this.forceRelease();
              // Continue to try acquiring
            } else {
              // Lock is held by another process
              await this.sleep(retryInterval);
            }
          } catch (readError) {
            // Can't read lock file, wait and retry
            await this.sleep(retryInterval);
          }
        } else {
          // Some other error
          logger.error('Failed to acquire lock', { error });
          return false;
        }
      }
    }

    logger.warn('Lock acquisition timeout', {
      lock: this.lockPath,
      timeout
    });

    return false;
  }

  /**
   * Release the lock
   */
  public async release(): Promise<void> {
    if (!this.acquired) {
      return;
    }

    try {
      // Verify we still own the lock
      const lockData = await fs.readFile(this.lockPath, 'utf-8');
      const lock = JSON.parse(lockData);

      if (lock.id === this.lockId) {
        await fs.unlink(this.lockPath);
        this.acquired = false;

        logger.debug('File lock released', {
          lock: this.lockPath,
          id: this.lockId
        });
      } else {
        logger.warn('Lock owned by different process', {
          lock: this.lockPath,
          ourId: this.lockId,
          theirId: lock.id
        });
      }
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        logger.error('Failed to release lock', { error });
      }
      this.acquired = false;
    }
  }

  /**
   * Force release (use with caution)
   */
  public async forceRelease(): Promise<void> {
    try {
      await fs.unlink(this.lockPath);
      this.acquired = false;
      logger.warn('Lock forcibly released', { lock: this.lockPath });
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        logger.error('Failed to force release lock', { error });
      }
    }
  }

  /**
   * Check if lock is held
   */
  public async isLocked(): Promise<boolean> {
    try {
      await fs.access(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute a function with lock protection
   */
  public async withLock<T>(
    fn: () => Promise<T>,
    options: LockOptions = {}
  ): Promise<T | null> {
    const acquired = await this.acquire(options);

    if (!acquired) {
      logger.error('Failed to acquire lock for operation');
      return null;
    }

    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}