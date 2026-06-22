import { Router } from 'express';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { createConsoleRequestContextMiddleware , requireConsoleRequestContext } from './ConsoleRequestContext.js';
import { executeConsoleRoute, sendConsoleHandlerResult } from './ConsoleRouteExecution.js';
import { createConsoleUnicodeNormalizationMiddleware } from './ConsoleUnicodeNormalization.js';
import type { ConsoleHttpMethod, ConsoleRequest, ConsoleRouteDefinition } from './ConsolePlatformTypes.js';
import type { ConsoleModuleRegistry } from './ConsoleModuleRegistry.js';
import { problemForConsoleError, sendProblemResponse } from './ProblemResponses.js';

function registerRoute(router: Router, route: ConsoleRouteDefinition): void {
  const normalizeUnicode = createConsoleUnicodeNormalizationMiddleware({
    pathParamValueNormalization: route.pathParamValueNormalization,
  });
  const handler: RequestHandler = (request, response, next): void => {
    const consoleRequest = request as ConsoleRequest;
    void executeConsoleRoute(route, consoleRequest)
      .then(result => sendConsoleHandlerResult(response, result, consoleRequest))
      .catch(next);
  };
  const method: ConsoleHttpMethod = route.method;

  switch (method) {
    case 'GET':
      router.get(route.path, normalizeUnicode, handler);
      return;
    case 'POST':
      router.post(route.path, normalizeUnicode, handler);
      return;
    case 'PUT':
      router.put(route.path, normalizeUnicode, handler);
      return;
    case 'PATCH':
      router.patch(route.path, normalizeUnicode, handler);
      return;
    case 'DELETE':
      router.delete(route.path, normalizeUnicode, handler);
      return;
  }
}

/**
 * Creates the unmounted v1 API router. Authentication and policy middleware
 * will be inserted here once the BFF/session services exist.
 */
export function assembleConsoleRouter(registry: ConsoleModuleRegistry): Router {
  const router = Router();
  router.use(createConsoleRequestContextMiddleware());

  for (const module of registry.getModules()) {
    for (const route of module.routes) {
      registerRoute(router, route);
    }
  }
  const sendKnownProblem: ErrorRequestHandler = (error, request, response, next): void => {
    const problem = problemForConsoleError(error);
    if (!problem || response.headersSent) {
      next(error);
      return;
    }
    sendProblemResponse(response, problem, requireConsoleRequestContext(request as ConsoleRequest).correlationId);
  };
  router.use(sendKnownProblem);
  return router;
}
