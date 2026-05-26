import { Router } from 'express';
import type { ErrorRequestHandler, RequestHandler } from 'express';

import type { IAdminAuditWriter } from '../audit/IAdminAuditWriter.js';
import type { IConsoleIdentityResolver } from '../identity/IConsoleIdentityResolver.js';
import {
  createConsoleAuthenticationMiddleware,
  createConsoleAuthorizationMiddleware,
  createConsoleCsrfProtectionMiddleware,
  createConsoleSecurityHeadersMiddleware,
  writeConsoleAdminAudit,
} from '../middleware/index.js';
import type { IConsoleOpaqueValueService } from '../security/ConsoleOpaqueValues.js';
import type { IConsoleSessionStore } from '../stores/IConsoleSessionStore.js';
import type { ConsoleHttpMethod, ConsoleRouteDefinition } from './ConsolePlatformTypes.js';
import type { ConsoleModuleRegistry } from './ConsoleModuleRegistry.js';
import { createConsoleRequestContextMiddleware, requireConsoleRequestContext } from './ConsoleRequestContext.js';
import { executeConsoleRoute, sendConsoleHandlerResult } from './ConsoleRouteExecution.js';
import { sendProblemResponse } from './ProblemResponses.js';
import type { ConsoleRequest } from './ConsolePlatformTypes.js';

export interface SecuredConsoleRouterOptions {
  readonly sessionStore: IConsoleSessionStore;
  readonly identityResolver: IConsoleIdentityResolver;
  readonly opaqueValues: IConsoleOpaqueValueService;
  readonly consoleOrigin: string;
  readonly adminAuditWriter: IAdminAuditWriter;
  readonly idleTimeoutMs: number;
  readonly now?: () => Date;
  readonly reportInternalError?: (error: unknown, correlationId: string) => void;
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
        createSecuredHandler(route, options),
      ]);
    }
  }
  const sendInternalProblem: ErrorRequestHandler = (error, request, response, next): void => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const correlationId = requireConsoleRequestContext(request as ConsoleRequest).correlationId;
    try {
      options.reportInternalError?.(error, correlationId);
    } catch {
      // Diagnostic reporting cannot replace the stable problem response.
    }
    sendProblemResponse(response, {
      status: 500,
      code: 'internal_error',
      title: 'Internal error',
      detail: 'The console request could not be completed.',
    }, correlationId);
  };
  router.use(sendInternalProblem);
  return router;
}

/**
 * This executes privacy-projected routes and audit-writes authorized attempts.
 * Administrative mutations remain unmounted until their domain write and
 * mandatory durable audit append can share an atomic application transaction.
 */
function createSecuredHandler(
  route: ConsoleRouteDefinition,
  options: SecuredConsoleRouterOptions,
): RequestHandler {
  return (request, response, next): void => {
    const req = request as ConsoleRequest;
    const occurredAt = options.now?.() ?? new Date();
    void (async (): Promise<void> => {
      let result;
      try {
        result = await executeConsoleRoute(route, req);
      } catch (error) {
        try {
          await writeConsoleAdminAudit(options.adminAuditWriter, route, req, 'failed', 'internal_error', occurredAt);
        } catch (auditError) {
          next(new AggregateError(
            [error, auditError],
            'Console route execution and required administrative audit write both failed',
          ));
          return;
        }
        next(error);
        return;
      }
      try {
        await writeConsoleAdminAudit(options.adminAuditWriter, route, req, 'approved', null, occurredAt);
        sendConsoleHandlerResult(response, result);
      } catch (error) {
        next(error);
      }
    })();
  };
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
