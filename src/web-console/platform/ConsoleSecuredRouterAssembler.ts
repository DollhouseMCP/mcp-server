import { Router } from 'express';
import type { ErrorRequestHandler, RequestHandler } from 'express';

import type { IConsoleIdentityResolver } from '../identity/IConsoleIdentityResolver.js';
import {
  createConsoleAuthenticationMiddleware,
  createConsoleAuthorizationMiddleware,
  createConsoleCsrfProtectionMiddleware,
  createConsoleSecurityHeadersMiddleware,
} from '../middleware/index.js';
import type { IConsoleOpaqueValueService } from '../security/ConsoleOpaqueValues.js';
import type { IConsoleSessionStore } from '../stores/IConsoleSessionStore.js';
import type { ConsoleHttpMethod, ConsoleRouteDefinition } from './ConsolePlatformTypes.js';
import type { ConsoleModuleRegistry } from './ConsoleModuleRegistry.js';
import { createConsoleRequestContextMiddleware, requireConsoleRequestContext } from './ConsoleRequestContext.js';
import { sendProblemResponse } from './ProblemResponses.js';
import type { ConsoleRequest } from './ConsolePlatformTypes.js';

export interface SecuredConsoleRouterOptions {
  readonly sessionStore: IConsoleSessionStore;
  readonly identityResolver: IConsoleIdentityResolver;
  readonly opaqueValues: IConsoleOpaqueValueService;
  readonly consoleOrigin: string;
  readonly idleTimeoutMs: number;
  readonly now?: () => Date;
}

export function assembleSecuredConsoleRouter(
  registry: ConsoleModuleRegistry,
  options: SecuredConsoleRouterOptions,
): Router {
  const router = Router();
  router.use(createConsoleRequestContextMiddleware());
  router.use(createConsoleSecurityHeadersMiddleware());
  const authenticate = createConsoleAuthenticationMiddleware(options);
  const csrf = createConsoleCsrfProtectionMiddleware(options);

  for (const module of registry.getModules()) {
    for (const route of module.routes) {
      registerSecuredRoute(router, route, [
        authenticate,
        csrf,
        createConsoleAuthorizationMiddleware(route, options),
        route.handler as RequestHandler,
      ]);
    }
  }
  const sendInternalProblem: ErrorRequestHandler = (_error, request, response, next): void => {
    if (response.headersSent) {
      next(_error);
      return;
    }
    sendProblemResponse(response, {
      status: 500,
      code: 'internal_error',
      title: 'Internal error',
      detail: 'The console request could not be completed.',
    }, requireConsoleRequestContext(request as ConsoleRequest).correlationId);
  };
  router.use(sendInternalProblem);
  return router;
}

function registerSecuredRoute(
  router: Router,
  route: ConsoleRouteDefinition,
  handlers: readonly RequestHandler[],
): void {
  const method: ConsoleHttpMethod = route.method;
  switch (method) {
    case 'GET':
      router.get(route.path, ...handlers);
      return;
    case 'POST':
      router.post(route.path, ...handlers);
      return;
    case 'PUT':
      router.put(route.path, ...handlers);
      return;
    case 'PATCH':
      router.patch(route.path, ...handlers);
      return;
    case 'DELETE':
      router.delete(route.path, ...handlers);
      return;
  }
}
