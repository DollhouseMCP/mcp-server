/**
 * Lifecycle Service
 *
 * Manages process-level lifecycle concerns: transport mode detection,
 * error handler behavior, and signal handler registration.
 *
 * In stdio mode (default), unhandled errors exit the process (the process IS the session).
 * In HTTP mode, unhandled errors are logged but the server continues (one session's error
 * must not kill the server for all connected clients).
 *
 * Issue #1948: Extracted from index.ts to a DI-managed singleton.
 *
 * @since v2.1.0
 */

import { logger } from '../utils/logger.js';

export class LifecycleService {
  private _httpModeActive = false;
  private _handlersInstalled = false;
  private readonly _periodicTimers = new Set<NodeJS.Timeout>();

  /** Check if HTTP mode error handling is active. */
  isHttpModeActive(): boolean {
    return this._httpModeActive;
  }

  /** Activate or deactivate HTTP mode error handling. */
  setHttpModeActive(active: boolean): void {
    this._httpModeActive = active;
  }

  /**
   * Install process-level error handlers.
   * In stdio mode: exit on unhandled errors.
   * In HTTP mode: log and continue.
   *
   * Should be called once during container initialization.
   */
  installErrorHandlers(): void {
    if (this._handlersInstalled) {
      logger.warn('[LifecycleService] Error handlers already installed — skipping duplicate registration');
      return;
    }
    this._handlersInstalled = true;

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        transport: this._httpModeActive ? 'http' : 'stdio',
      });

      if (this._httpModeActive) {
        logger.error('[Lifecycle] Uncaught exception in HTTP mode — server continues serving');
        return;
      }

      console.error('[DollhouseMCP] Fatal error');
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, _promise) => {
      logger.error('Unhandled promise rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
        transport: this._httpModeActive ? 'http' : 'stdio',
      });

      if (this._httpModeActive) {
        logger.error('[Lifecycle] Unhandled rejection in HTTP mode — server continues serving');
        return;
      }

      console.error('[DollhouseMCP] Fatal error');
      process.exit(1);
    });
  }

  // Note: Signal handlers (SIGINT, SIGTERM, SIGHUP) remain in index.ts and
  // StreamableHttpServer.ts where they're tied to the specific transport lifecycle.
  // A future LifecycleService.registerSignalHandlers() may consolidate them,
  // but that requires the service to hold a container reference for disposal.

  /**
   * Phase 4.5 / Phase J: register a periodic background task. Used by
   * the storage layer registrars to schedule sweepers — `sharedCacheStore.sweepExpired`
   * (every 1h) and `signingKeyStore.pruneRotatedBefore` (every 6h).
   *
   * The task is wrapped in try/catch so a single failure doesn't crash
   * the timer chain. All registered timers are cleared during `dispose()`
   * so they don't leak across container teardown (test isolation,
   * graceful shutdown).
   *
   * @param intervalMs   How often to run the task, in milliseconds.
   * @param task         The async task to run; errors are caught + logged.
   * @param label        Short label used in log output for diagnostics.
   * @returns the underlying timer handle (mostly for tests).
   */
  registerPeriodicTask(intervalMs: number, task: () => Promise<void>, label: string): NodeJS.Timeout {
    const timer = setInterval(() => {
      task().catch((err) => {
        logger.error(`[LifecycleService] periodic task '${label}' threw`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);
    // Detach from the event loop's keep-alive ref-count — periodic
    // sweepers shouldn't prevent the process from exiting on shutdown
    // (signal handlers + dispose() handle cleanup explicitly).
    timer.unref();
    this._periodicTimers.add(timer);
    logger.debug(`[LifecycleService] registered periodic task '${label}'`, { intervalMs });
    return timer;
  }

  /**
   * Stop all periodic tasks. Called by container.dispose() so test
   * containers don't leak setInterval handles between suites.
   */
  dispose(): void {
    for (const timer of this._periodicTimers) {
      clearInterval(timer);
    }
    this._periodicTimers.clear();
  }
}
