import type { RequestHandler } from 'express';

import { requireConsoleRequestContext } from '../platform/ConsoleRequestContext.js';
import {
  type ConsoleRequest,
  type ConsoleRouteDefinition,
} from '../platform/ConsolePlatformTypes.js';
import { sendProblemResponse } from '../platform/ProblemResponses.js';
import type { IRuntimeSessionControlStore } from '../services/runtime/IRuntimeSessionControlStore.js';
import { requireConsoleAuthentication } from './ConsoleAuthentication.js';

export interface ConsoleOwnershipOptions {
  readonly runtimeStore: IRuntimeSessionControlStore;
  readonly now?: () => Date;
}

export function createConsoleOwnershipMiddleware(
  route: ConsoleRouteDefinition,
  options: ConsoleOwnershipOptions,
): RequestHandler {
  return (request, response, next): void => {
    const req = request as ConsoleRequest;
    void (async (): Promise<void> => {
      const policy = route.ownership ?? 'none';
      if (policy === 'none' || policy === 'flow_transaction') {
        next();
        return;
      }

      const authentication = requireConsoleAuthentication(req);
      if (policy === 'authenticated_user') {
        next();
        return;
      }

      const sessionId = req.params.session_id;
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        sendProblemResponse(response, notFoundProblem(), requireConsoleRequestContext(req).correlationId);
        return;
      }
      const presence = await options.runtimeStore.findPresence(sessionId, options.now?.() ?? new Date());
      if (presence?.userId !== authentication.userId) {
        sendProblemResponse(response, notFoundProblem(), requireConsoleRequestContext(req).correlationId);
        return;
      }
      next();
    })().catch(next);
  };
}

function notFoundProblem(): {
  readonly status: 404;
  readonly code: 'not_found';
  readonly title: 'Not found';
  readonly detail: string;
} {
  return {
    status: 404,
    code: 'not_found',
    title: 'Not found',
    detail: 'Runtime session was not found.',
  };
}
