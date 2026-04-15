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
    await this.disposeSessionServices();
    this.cleanupSharedState();
    logger.debug(`[SessionContainer] Disposed session '${this.sessionId}'`);
  }

  /** Dispose all session-scoped service instances that have a cleanup method. */
  private async disposeSessionServices(): Promise<void> {
    const disposalPromises: Array<{ name: string; promise: Promise<void> }> = [];
    for (const [name, service] of this.services) {
      if (!service.instance) continue;
      const teardown = this.findTeardownMethod(service.instance);
      if (teardown) {
        disposalPromises.push({ name, promise: Promise.resolve().then(teardown) });
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
  }

  /** Find a dispose/close/destroy method on a service instance. */
  private findTeardownMethod(instance: unknown): (() => Promise<void>) | null {
    const obj = instance as Record<string, unknown>;
    if (typeof obj.dispose === 'function') return () => (obj.dispose as () => Promise<void>)();
    if (typeof obj.close === 'function') return () => (obj.close as () => Promise<void>)();
    if (typeof obj.destroy === 'function') return () => (obj.destroy as () => Promise<void>)();
    return null;
  }

  /** Clean up session-keyed state on shared root services. */
  private cleanupSharedState(): void {
    this.safeCleanup('SessionActivationRegistry', (svc: SessionActivationRegistry) => svc.dispose(this.sessionId));
    this.safeCleanup('gatekeeper', (svc: { disposeSession(id: string): void }) => svc.disposeSession(this.sessionId));
    this.safeCleanup('mcpAqlHandler', (svc: { cleanupSession(id: string): void }) => svc.cleanupSession(this.sessionId));
  }

  /** Resolve a parent service and run cleanup, logging on failure. */
  private safeCleanup<T>(serviceName: string, cleanup: (svc: T) => void): void {
    try {
      cleanup(this.parent.resolve<T>(serviceName));
    } catch (error) {
      logger.warn(`[SessionContainer] Failed to clean up ${serviceName}`, {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
