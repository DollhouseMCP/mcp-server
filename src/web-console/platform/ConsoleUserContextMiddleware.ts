import type { RequestHandler } from 'express';

import type { SessionContext } from '../../context/SessionContext.js';
import type { ContextTracker } from '../../security/encryption/ContextTracker.js';
import type { SessionActivationRegistry, SessionActivationState } from '../../state/SessionActivationState.js';
import { requireConsoleAuthentication } from '../middleware/ConsoleAuthentication.js';
import { isBridgeOnlySessionActivationState, restoreSessionDbUserId } from './ConsoleSessionActivationBridgeState.js';
import type { ConsoleRequest } from './ConsolePlatformTypes.js';

export interface ConsoleUserContextOptions {
  readonly contextTracker: ContextTracker;
  readonly sessionActivationRegistry: SessionActivationRegistry;
}

interface BridgeSessionState {
  readonly activationState: SessionActivationState;
  readonly createdByBridge: boolean;
  readonly previousDbUserId: string | undefined;
  activeRequests: number;
}

const bridgeSessionsByRegistry = new WeakMap<SessionActivationRegistry, Map<string, BridgeSessionState>>();

export function createConsoleUserContextMiddleware(
  options: ConsoleUserContextOptions,
): RequestHandler {
  return (request, response, next): void => {
    const req = request as ConsoleRequest;
    const auth = requireConsoleAuthentication(req);
    const sessionId = consoleSessionContextId(auth.sessionIdHash);
    let bridgeSession: BridgeSessionState;
    try {
      bridgeSession = acquireBridgeSession(options.sessionActivationRegistry, sessionId, auth.userId);
    } catch (error) {
      next(error);
      return;
    }

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      releaseBridgeSession(options.sessionActivationRegistry, sessionId, bridgeSession);
    };
    response.once('finish', cleanup);
    response.once('close', cleanup);

    const sessionContext: SessionContext = {
      userId: auth.userId,
      sessionId,
      tenantId: auth.userId,
      transport: 'http',
      createdAt: Date.now(),
      roles: auth.grantedCapabilities,
    };
    const context = options.contextTracker.createSessionContext('llm-request', sessionContext, {
      route: req.route?.path,
      method: req.method,
    });
    options.contextTracker.run(context, () => next());
  };
}

export function consoleSessionContextId(sessionIdHash: Buffer): string {
  return `web-console:${sessionIdHash.toString('base64url')}`;
}

function acquireBridgeSession(
  registry: SessionActivationRegistry,
  sessionId: string,
  userId: string,
): BridgeSessionState {
  const bridgeSessions = bridgeSessionsFor(registry);
  const existingBridgeSession = bridgeSessions.get(sessionId);
  if (existingBridgeSession) {
    assertBridgeUser(existingBridgeSession.activationState, userId);
    existingBridgeSession.activeRequests += 1;
    return existingBridgeSession;
  }

  const existingState = registry.get(sessionId);
  const activationState = existingState ?? registry.getOrCreate(sessionId);
  assertBridgeUser(activationState, userId);
  const bridgeSession: BridgeSessionState = {
    activationState,
    createdByBridge: existingState === undefined,
    previousDbUserId: activationState.dbUserId,
    activeRequests: 1,
  };
  activationState.dbUserId = userId;
  bridgeSessions.set(sessionId, bridgeSession);
  return bridgeSession;
}

function releaseBridgeSession(
  registry: SessionActivationRegistry,
  sessionId: string,
  bridgeSession: BridgeSessionState,
): void {
  bridgeSession.activeRequests -= 1;
  if (bridgeSession.activeRequests > 0) return;

  restoreSessionDbUserId(bridgeSession.activationState, bridgeSession.previousDbUserId);
  bridgeSessionsFor(registry).delete(sessionId);
  if (bridgeSession.createdByBridge && isBridgeOnlySessionActivationState(bridgeSession.activationState)) {
    registry.dispose(sessionId);
  }
}

function bridgeSessionsFor(registry: SessionActivationRegistry): Map<string, BridgeSessionState> {
  let bridgeSessions = bridgeSessionsByRegistry.get(registry);
  if (!bridgeSessions) {
    bridgeSessions = new Map();
    bridgeSessionsByRegistry.set(registry, bridgeSessions);
  }
  return bridgeSessions;
}

function assertBridgeUser(state: SessionActivationState, userId: string): void {
  if (state.dbUserId !== undefined && state.dbUserId !== userId) {
    throw new Error('Console session database user identity does not match authenticated console user');
  }
}
