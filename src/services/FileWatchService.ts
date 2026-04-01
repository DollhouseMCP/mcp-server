import * as path from 'node:path';
import { watch, FSWatcher, accessSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { logger } from '../utils/logger.js';

export type FileChangeHandler = (relativePath: string) => void;

interface WatchEntry {
  watcher: FSWatcher | PollingWatcher;
  handlers: Set<FileChangeHandler>;
}

class PollingWatcher {
  private readonly interval: NodeJS.Timeout;

  constructor(interval: NodeJS.Timeout) {
    this.interval = interval;
  }

  close(): void {
    clearInterval(this.interval);
  }

  // Match the fs.FSWatcher shape well enough for internal use.
  on(_event: string, _listener: (...args: unknown[]) => void): this {
    return this;
  }
}

/**
 * Type guard to check if an error is a Node.js system error with an error code
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Thin wrapper over fs.watch that fan-outs change events to interested managers.
 *
 * This service is managed as a singleton by the DI container.
 * Inject it via constructor injection rather than using a static getInstance() method.
 */
export class FileWatchService {
  private readonly watchers = new Map<string, WatchEntry>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Watch a directory for changes. If the directory doesn't exist, it will be created.
   *
   * @param dirPath - Path to directory to watch
   * @param handler - Callback function invoked when files change
   * @returns Cleanup function to stop watching
   *
   * @remarks
   * This method ensures the directory exists before setting up the watcher.
   * fs.watch throws ENOENT if the directory doesn't exist, so we create it
   * with recursive:true to handle test scenarios and edge cases gracefully.
   *
   * File watching is optional functionality. If fs.watch() fails due to permission
   * restrictions or platform limitations, a no-op cleanup function is returned and
   * the application continues without file watching for that directory.
   */
  watchDirectory(dirPath: string, handler: FileChangeHandler): () => void {
    const absoluteDir = path.resolve(dirPath);
    const existing = this.watchers.get(absoluteDir);

    if (existing) {
      existing.handlers.add(handler);
      return () => this.detachHandler(absoluteDir, handler);
    }

    // Ensure directory exists before watching
    // fs.watch throws ENOENT if directory doesn't exist, so we create it first
    try {
      accessSync(absoluteDir);
    } catch (_error) {
      // Directory doesn't exist - create it
      try {
        mkdirSync(absoluteDir, { recursive: true });
        logger.debug('Created directory for watching', { directory: absoluteDir });
      } catch (mkdirError) {
        // Failed to create directory - log and return no-op cleanup
        logger.warn('Failed to create directory for watching - watcher will not be set up', {
          directory: absoluteDir,
          error: mkdirError instanceof Error ? mkdirError.message : String(mkdirError)
        });
        // Return a no-op cleanup function since watcher was not created
        return () => {};
      }
    }

    const handlers = new Set<FileChangeHandler>([handler]);

    const startPollingWatcher = (reason: { error: unknown; phase: 'setup' | 'runtime' } | undefined): PollingWatcher | undefined => {
      const snapshot = (): Map<string, number> => {
        const next = new Map<string, number>();
        for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
          if (!entry.isFile()) {
            continue;
          }
          try {
            const stats = statSync(path.join(absoluteDir, entry.name));
            next.set(entry.name, stats.mtimeMs);
          } catch {
            // Ignore races (file removed between readdir and stat, etc.)
          }
        }
        return next;
      };

      let previous: Map<string, number>;
      try {
        previous = snapshot();
      } catch (pollSetupError) {
        logger.warn('Failed to initialize polling directory watcher', {
          directory: absoluteDir,
          phase: reason?.phase,
          originalError: reason?.error instanceof Error ? reason.error.message : reason?.error,
          error: pollSetupError instanceof Error ? pollSetupError.message : String(pollSetupError),
        });
        return undefined;
      }

      // Adaptive polling interval: scale with directory size to prevent
      // scan-overlaps on large portfolios (Issue #1687).
      // Base: 2s, +2ms per file, capped at 10s.
      const baseIntervalMs = 2000;
      const perFileMs = 2;
      const maxIntervalMs = 10_000;
      const adaptiveInterval = Math.min(
        baseIntervalMs + previous.size * perFileMs,
        maxIntervalMs,
      );

      // Guard: skip poll if a previous scan is still being processed
      let scanInProgress = false;

      // Debounce: batch changed files and notify handlers once per cycle
      const interval = setInterval(() => {
        if (scanInProgress) return;
        scanInProgress = true;

        try {
          let next: Map<string, number>;
          try {
            next = snapshot();
          } catch {
            return;
          }

          // Collect all changed files before notifying handlers
          const changedFiles: string[] = [];

          for (const [filename, mtimeMs] of next) {
            const priorMtime = previous.get(filename);
            if (priorMtime === undefined || priorMtime !== mtimeMs) {
              changedFiles.push(filename);
            }
          }

          // Deletions
          for (const filename of previous.keys()) {
            if (!next.has(filename)) {
              changedFiles.push(filename);
            }
          }

          // Notify handlers once per changed file (deduplicated)
          if (changedFiles.length > 0) {
            const uniqueChanges = [...new Set(changedFiles)];
            for (const filename of uniqueChanges) {
              for (const h of handlers) {
                try {
                  h(filename);
                } catch (error) {
                  logger.warn('FileWatchService polling handler failed', {
                    directory: absoluteDir,
                    error: error instanceof Error ? error.message : error
                  });
                }
              }
            }
          }

          previous = next;
        } finally {
          scanInProgress = false;
        }
      }, adaptiveInterval);

      logger.warn('Falling back to polling directory watcher', {
        directory: absoluteDir,
        phase: reason?.phase,
        originalError: reason?.error instanceof Error ? reason.error.message : reason?.error,
        code: reason?.error && isNodeError(reason.error) ? reason.error.code : undefined
      });

      return new PollingWatcher(interval);
    };

    // Try to set up file watcher - may fail due to permission restrictions or platform limitations
    let watcher: FSWatcher | PollingWatcher | undefined;
    try {
      // Debounce fs.watch events — coalesce rapid-fire notifications into
      // a single handler call per file within a 500ms window (Issue #1687).
      const pendingChanges = new Set<string>();

      watcher = watch(absoluteDir, { recursive: false }, (_eventType, filename) => {
        if (!filename) {
          return;
        }
        pendingChanges.add(filename.toString());

        const existingTimer = this.debounceTimers.get(absoluteDir);
        if (existingTimer) clearTimeout(existingTimer);
        this.debounceTimers.set(absoluteDir, setTimeout(() => {
          this.debounceTimers.delete(absoluteDir);
          const files = [...pendingChanges];
          pendingChanges.clear();
          for (const relative of files) {
            for (const h of handlers) {
              try {
                h(relative);
              } catch (error) {
                logger.warn('FileWatchService handler failed', {
                  directory: absoluteDir,
                  error: error instanceof Error ? error.message : error
                });
              }
            }
          }
        }, 500));
      });
    } catch (watchError) {
      // File watching failed - fall back to polling (or no-op if polling also fails).
      // Common on platforms with watch limits (EMFILE/ENOSPC) or restricted permissions.
      logger.warn('Failed to set up file watcher', {
        directory: absoluteDir,
        error: watchError instanceof Error ? watchError.message : String(watchError),
        code: isNodeError(watchError) ? watchError.code : undefined
      });

      const pollingWatcher = startPollingWatcher({ error: watchError, phase: 'setup' });
      if (!pollingWatcher) {
        // Return a no-op cleanup function since watcher was not created
        return () => {};
      }

      this.watchers.set(absoluteDir, { watcher: pollingWatcher, handlers });
      return () => this.detachHandler(absoluteDir, handler);
    }

    // Handle error events from the watcher (required for Windows)
    // On Windows, fs.watch emits error events for permission issues (EPERM)
    // Without this handler, Node.js throws "Unhandled 'error' event"
    let earlyWatchError: unknown | undefined;
    watcher.on('error', (error) => {
      // If the watcher errors immediately (before we store it), record and handle after setup.
      if (!this.watchers.has(absoluteDir)) {
        earlyWatchError = error;
        watcher.close();
        return;
      }

      logger.warn('File watcher error - closing watcher', {
        directory: absoluteDir,
        error: error instanceof Error ? error.message : String(error),
        code: isNodeError(error) ? error.code : undefined
      });

      // Close the watcher as recommended in Node.js documentation.
      // If the watcher is failing (e.g., EMFILE/ENOSPC), fall back to polling so the app can still react.
      const current = this.watchers.get(absoluteDir);
      const isCurrentWatcher = current?.watcher === watcher;

      watcher.close();

      if (isCurrentWatcher) {
        const pollingWatcher = startPollingWatcher({ error, phase: 'runtime' });
        if (pollingWatcher) {
          this.watchers.set(absoluteDir, { watcher: pollingWatcher, handlers });
        } else {
          this.watchers.delete(absoluteDir);
        }
      }
    });

    this.watchers.set(absoluteDir, { watcher, handlers });
    logger.debug('Started directory watcher', { directory: absoluteDir });

    if (earlyWatchError) {
      logger.warn('File watcher error during initialization - switching to polling', {
        directory: absoluteDir,
        error: earlyWatchError instanceof Error ? earlyWatchError.message : String(earlyWatchError),
        code: isNodeError(earlyWatchError) ? earlyWatchError.code : undefined
      });
      const pollingWatcher = startPollingWatcher({ error: earlyWatchError, phase: 'runtime' });
      if (pollingWatcher) {
        this.watchers.set(absoluteDir, { watcher: pollingWatcher, handlers });
      } else {
        this.watchers.delete(absoluteDir);
      }
    }

    return () => this.detachHandler(absoluteDir, handler);
  }

  private detachHandler(dir: string, handler: FileChangeHandler): void {
    const entry = this.watchers.get(dir);
    if (!entry) {
      return;
    }
    entry.handlers.delete(handler);
    if (entry.handlers.size === 0) {
      entry.watcher.close();
      this.watchers.delete(dir);
      logger.debug('Stopped directory watcher', { directory: dir });
    }
  }

  /**
   * Dispose of all file watchers. Called during graceful shutdown.
   * This method is invoked by the DI container's dispose() method.
   */
  dispose(): void {
    // Clear all pending debounce timers to prevent post-dispose handler calls
    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const [dir, entry] of this.watchers) {
      try {
        entry.watcher.close();
        logger.debug('Closed directory watcher during dispose', { directory: dir });
      } catch (error) {
        logger.warn('Error closing watcher during dispose', {
          directory: dir,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    this.watchers.clear();
    logger.debug('FileWatchService disposed', { watchersClosed: this.watchers.size === 0 });
  }
}
