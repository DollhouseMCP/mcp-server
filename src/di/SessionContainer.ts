/**
 * Session-Scoped DI Container
 *
 * Lightweight child container that owns per-session services.
 * Delegates to the parent DollhouseContainer for anything it doesn't own.
 * Disposal cleans up only session-scoped services and orchestrates
 * cleanup of session-keyed state on shared root services.
 *
 * Issue #1948: Formalizes the per-session object creation that was
 * previously ad-hoc in createServerForHttpSession().
 *
 * @since v2.1.0
 */

import { logger } from '../utils/logger.js';
import type { SessionActivationRegistry } from '../state/SessionActivationState.js';

// Forward declaration — avoids circular import with Container.ts
interface ParentContainer {
  resolve<T>(name: string): T;
}

/**
 * Service record for session-scoped services.
 * All session services are singletons within their session scope.
 */
interface SessionServiceRecord<T = unknown> {
  factory: () => T;
  instance: T | null;
}

/**
 * Services that must remain in the root container (they bear timers
 * or hold process-wide state). Attempting to register them in a
 * SessionContainer throws immediately.
 */
const ROOT_ONLY_SERVICES = new Set([
  // Timer-bearing services
  'LogManager',
  'MetricsManager',
  'FileLogSink',
  'BackgroundValidator',
  'PerformanceMonitor',
  'FileWatchService',
  // Process-wide state holders
  'SecurityMonitor',
  'LifecycleService',
  'OperationalTelemetry',
  'SecurityTelemetry',
  'RetentionPolicyService',
  'ConfigManager',
]);

export class SessionContainer {
  private readonly parent: ParentContainer;
  private readonly services = new Map<string, SessionServiceRecord>();
  public readonly sessionId: string;

  constructor(parent: ParentContainer, sessionId: string) {
    this.parent = parent;
    this.sessionId = sessionId;
  }

  /**
   * Register a session-scoped service.
   * All session services are singletons within their session scope
   * (created once per session, cached for the session's lifetime).
   *
   * @throws Error if attempting to register a root-only service
   */
  register<T>(name: string, factory: () => T): void {
    if (ROOT_ONLY_SERVICES.has(name)) {
      throw new Error(
        `Service '${name}' is a root-only singleton (bears timers or process-wide state). ` +
        `Register it in DollhouseContainer, not SessionContainer.`
      );
    }
    this.services.set(name, { factory: factory as () => unknown, instance: null });
  }

  /**
   * Resolve a service. Checks own session-scoped services first,
   * then transparently delegates to the parent container.
   */
  resolve<T>(name: string): T {
    const service = this.services.get(name);
    if (service) {
      if (!service.instance) {
        service.instance = service.factory();
      }
      return service.instance as T;
    }
    // Transparent delegation to parent
    return this.parent.resolve<T>(name);
  }

  /**
   * Dispose all session-scoped services and orchestrate cleanup
   * of session-keyed state on shared root services.
   *
   * DOES NOT dispose parent container services.
   */
  async dispose(): Promise<void> {
    // 1. Dispose session-scoped service instances
    const disposalPromises: Array<{ name: string; promise: Promise<void> }> = [];
    for (const [name, service] of this.services) {
      if (!service.instance) continue;
      const instance = service.instance as Record<string, unknown>;
      if (typeof instance.dispose === 'function') {
        disposalPromises.push({ name, promise: Promise.resolve().then(() => (instance.dispose as () => Promise<void>)()) });
      } else if (typeof instance.close === 'function') {
        disposalPromises.push({ name, promise: Promise.resolve().then(() => (instance.close as () => Promise<void>)()) });
      } else if (typeof instance.destroy === 'function') {
        disposalPromises.push({ name, promise: Promise.resolve().then(() => (instance.destroy as () => Promise<void>)()) });
      }
    }

    const results = await Promise.allSettled(disposalPromises.map(d => d.promise));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        logger.warn(`[SessionContainer] Failed to dispose '${disposalPromises[index].name}'`, {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          sessionId: this.sessionId,
        });
      }
    }

    // 2. Cleanup session-keyed state on shared root services
    try {
      const activationRegistry = this.parent.resolve<SessionActivationRegistry>('SessionActivationRegistry');
      activationRegistry.dispose(this.sessionId);
    } catch (error) {
      logger.warn('[SessionContainer] Failed to clean up activation registry', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const gatekeeper = this.parent.resolve<{ disposeSession(id: string): void }>('gatekeeper');
      gatekeeper.disposeSession(this.sessionId);
    } catch (error) {
      logger.warn('[SessionContainer] Failed to clean up Gatekeeper session', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const mcpAqlHandler = this.parent.resolve<{ cleanupSession(id: string): void }>('mcpAqlHandler');
      mcpAqlHandler.cleanupSession(this.sessionId);
    } catch (error) {
      logger.warn('[SessionContainer] Failed to clean up MCPAQLHandler session', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.debug(`[SessionContainer] Disposed session '${this.sessionId}'`);
  }
}
