import type { RequestHandler } from 'express';

import type { IConsoleIdentityResolver } from '../identity/IConsoleIdentityResolver.js';
import { requireConsoleRequestContext } from '../platform/ConsoleRequestContext.js';
import { sendProblemResponse } from '../platform/ProblemResponses.js';
import type { ConsoleAuthenticatedContext, ConsoleRequest } from '../platform/ConsolePlatformTypes.js';
import type { IConsoleOpaqueValueService } from '../security/ConsoleOpaqueValues.js';
import type { IConsoleSessionStore, ConsoleSessionRecord } from '../stores/IConsoleSessionStore.js';
import { cloneBuffer } from '../stores/ConsoleStoreValidation.js';
import { CONSOLE_SESSION_COOKIE, readCookie } from './ConsoleCookies.js';

const csrfHashesByRequest = new WeakMap<ConsoleRequest, Buffer>();

export interface ConsoleAuthenticationOptions {
  readonly sessionStore: IConsoleSessionStore;
  readonly identityResolver: IConsoleIdentityResolver;
  readonly opaqueValues: IConsoleOpaqueValueService;
  readonly idleTimeoutMs: number;
  readonly now?: () => Date;
}

export class ConsoleAuthenticationDependencyUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConsoleAuthenticationDependencyUnavailableError';
  }
}

export function createConsoleAuthenticationMiddleware(
  options: ConsoleAuthenticationOptions,
): RequestHandler {
  if (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs <= 0) {
    throw new Error('Console authentication idle timeout must be a positive integer');
  }
  return async (request, response, next): Promise<void> => {
    const req = request as ConsoleRequest;
    const now = options.now?.() ?? new Date();
    const rawSession = readCookie(req.headers.cookie, CONSOLE_SESSION_COOKIE);
    if (!rawSession) {
      sendUnauthenticated(req, response);
      return;
    }

    try {
      const idHash = options.opaqueValues.hashOpaqueValue(rawSession);
      const session = await options.sessionStore.findActiveByIdHash(idHash, now);
      if (!session) {
        sendUnauthenticated(req, response);
        return;
      }
      const principal = await options.identityResolver.resolveEnabledPrincipal(session.authSub);
      if (principal?.userId !== session.userId) {
        sendUnauthenticated(req, response);
        return;
      }

      const touched = await options.sessionStore.touch(idHash, {
        lastUsedAt: now,
        idleExpiresAt: slidingIdleExpiry(session, now, options.idleTimeoutMs),
      }, now);
      if (!touched && !await options.sessionStore.findActiveByIdHash(idHash, now)) {
        sendUnauthenticated(req, response);
        return;
      }

      req.consoleAuthentication = createAuthenticationContext(session, principal.authzVersion);
      csrfHashesByRequest.set(req, cloneBuffer(session.csrfTokenHash));
      next();
    } catch (error) {
      if (error instanceof ConsoleAuthenticationDependencyUnavailableError) {
        sendProblemResponse(response, {
          status: 503,
          code: 'service_unavailable',
          title: 'Service unavailable',
          detail: 'Console session validation is temporarily unavailable.',
        }, requireConsoleRequestContext(req).correlationId);
        return;
      }
      next(error);
    }
  };
}

export function requireConsoleAuthentication(req: ConsoleRequest): ConsoleAuthenticatedContext {
  if (!req.consoleAuthentication) {
    throw new Error('Console authentication middleware has not run');
  }
  return req.consoleAuthentication;
}

export function sessionCsrfHashMatches(
  req: ConsoleRequest,
  rawCsrfToken: string,
  opaqueValues: IConsoleOpaqueValueService,
): boolean {
  const expectedHash = csrfHashesByRequest.get(req);
  return !!expectedHash && opaqueValues.matchesHash(rawCsrfToken, expectedHash);
}

function createAuthenticationContext(
  session: ConsoleSessionRecord,
  authzVersion: number,
): ConsoleAuthenticatedContext {
  return {
    sessionIdHash: cloneBuffer(session.idHash),
    userId: session.userId,
    authSub: session.authSub,
    authzVersion,
    grantedCapabilities: [...session.grantedCapabilities],
    elevation: session.elevation ? {
      capabilities: [...session.elevation.capabilities],
      expiresAt: new Date(session.elevation.expiresAt),
      acr: session.elevation.acr,
      amr: [...session.elevation.amr],
      authTime: new Date(session.elevation.authTime),
    } : null,
  };
}

function slidingIdleExpiry(
  session: ConsoleSessionRecord,
  now: Date,
  idleTimeoutMs: number,
): Date {
  const proposed = now.getTime() + idleTimeoutMs;
  return new Date(Math.min(proposed, session.absoluteExpiresAt.getTime()));
}

function sendUnauthenticated(req: ConsoleRequest, response: Parameters<typeof sendProblemResponse>[0]): void {
  sendProblemResponse(response, {
    status: 401,
    code: 'unauthenticated',
    title: 'Authentication required',
    detail: 'A valid console session is required.',
  }, requireConsoleRequestContext(req).correlationId);
}
