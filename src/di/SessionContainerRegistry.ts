/**
 * SessionContainerRegistry
 *
 * Root-scoped registry for HTTP session child containers. Long-lived root
 * services use this registry to resolve the active session container from
 * ContextTracker without capturing session-scoped services at startup.
 */

import type { SessionContext } from '../context/SessionContext.js';
import type { ContextTracker } from '../security/encryption/ContextTracker.js';
import { logger } from '../utils/logger.js';
import type { SessionContainer } from './SessionContainer.js';

type ContextTrackerProvider = () => ContextTracker | undefined;

export class SessionContainerRegistry {
  private readonly containers = new Map<string, SessionContainer>();

  constructor(private readonly getContextTracker: ContextTrackerProvider) {}

  register(sessionId: string, container: SessionContainer): void {
    this.containers.set(sessionId, container);
  }

  get(sessionId: string): SessionContainer | undefined {
    return this.containers.get(sessionId);
  }

  unregister(sessionId: string): void {
    this.containers.delete(sessionId);
  }

  getActiveContainer(): SessionContainer | undefined {
    const session = this.getActiveSession();
    if (!session) return undefined;

    const container = this.get(session.sessionId);
    if (!container) {
      logger.debug('[SessionContainerRegistry] No active container registered for session', {
        sessionId: session.sessionId,
      });
    }
    return container;
  }

  private getActiveSession(): SessionContext | undefined {
    try {
      return this.getContextTracker()?.getSessionContext();
    } catch (error) {
      logger.debug('[SessionContainerRegistry] Failed to read active session context', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}
