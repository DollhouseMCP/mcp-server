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
}
