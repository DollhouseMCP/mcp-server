import { Router } from 'express';
import type { ErrorRequestHandler, RequestHandler } from 'express';

import { logger } from '../../utils/logger.js';

import type { IAdminAuditWriter } from '../audit/IAdminAuditWriter.js';
import type { IConsoleIdentityResolver } from '../identity/IConsoleIdentityResolver.js';
import {
  createConsoleAuthenticationMiddleware,
  createConsoleAuthorizationMiddleware,
  createConsoleCsrfProtectionMiddleware,
  createConsoleOwnershipMiddleware,
  createConsoleRateLimitMiddleware,
  createConsoleSecurityHeadersMiddleware,
  executeWithConsoleIdempotency,
  writeConsoleAdminAudit,
} from '../middleware/index.js';
import type { IConsoleOpaqueValueService } from '../security/ConsoleOpaqueValues.js';
import type { IConsoleSessionStore } from '../stores/IConsoleSessionStore.js';
import type { IConsoleAuthPolicyStore } from '../stores/IConsoleAuthPolicyStore.js';
import type { IIdempotencyStore } from '../stores/IIdempotencyStore.js';
import type { IRuntimeSessionControlStore } from '../services/runtime/IRuntimeSessionControlStore.js';
import type { ConsoleProtectedCorrelationRateLimiter } from '../services/rate-limit/ConsoleProtectedCorrelationRateLimiter.js';
import type { ConsoleHttpMethod, ConsoleRouteDefinition , ConsoleRequest } from './ConsolePlatformTypes.js';
import { isElevationValidForRoute } from './ConsolePlatformTypes.js';
import type { ConsoleModuleRegistry } from './ConsoleModuleRegistry.js';
import { createConsoleRequestContextMiddleware, requireConsoleRequestContext } from './ConsoleRequestContext.js';
import { createConsoleUnicodeNormalizationMiddleware } from './ConsoleUnicodeNormalization.js';
import { executeConsoleRoute, sendConsoleHandlerResult } from './ConsoleRouteExecution.js';
import {
  createConsoleUserContextMiddleware,
  type ConsoleUserContextOptions,
} from './ConsoleUserContextMiddleware.js';
import { problemForConsoleError, sendProblemResponse } from './ProblemResponses.js';
import { requireConsoleAuthentication } from '../middleware/ConsoleAuthentication.js';

export interface SecuredConsoleRouterOptions {
  readonly sessionStore: IConsoleSessionStore;
  readonly identityResolver: IConsoleIdentityResolver;
  readonly opaqueValues: IConsoleOpaqueValueService;
  readonly consoleOrigin: string;
  readonly adminAuditWriter: IAdminAuditWriter;
  readonly idempotencyStore: IIdempotencyStore;
  readonly runtimeStore: IRuntimeSessionControlStore;
  readonly authPolicyStore?: IConsoleAuthPolicyStore;
  readonly protectedCorrelationRateLimiter?: ConsoleProtectedCorrelationRateLimiter | null;
  readonly idleTimeoutMs: number;
  readonly now?: () => Date;
  readonly reportInternalError?: (error: unknown, correlationId: string) => void;
  readonly userContext?: ConsoleUserContextOptions;
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
  const normalizeBody = createConsoleUnicodeNormalizationMiddleware({ params: false, query: false, body: 'keys' });
  const userContext = options.userContext
    ? createConsoleUserContextMiddleware(options.userContext)
    : null;

  for (const module of registry.getModules()) {
    for (const route of module.routes) {
      registerSecuredRoute(router, route, middlewareForRoute({
        route,
        options,
        normalizeBody,
        authenticate,
        userContext,
        csrf,
      }));
    }
  }
  const sendInternalProblem: ErrorRequestHandler = (error, request, response, next): void => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const correlationId = requireConsoleRequestContext(request as ConsoleRequest).correlationId;
    const knownProblem = problemForConsoleError(error);
    if (knownProblem) {
      sendProblemResponse(response, knownProblem, correlationId);
      return;
    }
    // Log the unhandled error so a 500 is never silent (otherwise the only
    // signal is an opaque problem+JSON, which makes prod incidents undebuggable).
    {
      const cause = (error as { cause?: unknown }).cause;
      logger.error(
        `[ConsoleSecuredRouter] unhandled handler error corr=${correlationId}: ` +
        (error instanceof Error ? error.message : String(error)) +
        ' | cause: ' + (cause instanceof Error ? cause.message : JSON.stringify(cause)),
      );
    }
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

function middlewareForRoute(input: {
  readonly route: ConsoleRouteDefinition;
  readonly options: SecuredConsoleRouterOptions;
  readonly normalizeBody: RequestHandler;
  readonly authenticate: RequestHandler;
  readonly userContext: RequestHandler | null;
  readonly csrf: RequestHandler;
}): readonly RequestHandler[] {
  const normalizeRequestTarget = createConsoleUnicodeNormalizationMiddleware({
    body: 'off',
    pathParamValueNormalization: input.route.pathParamValueNormalization,
    queryParamValueNormalization: input.route.queryParamValueNormalization,
  });
  if (input.route.audience === 'public') {
    // Current public console routes are GET-only health/auth redirects and do
    // not consume JSON bodies. Avoid recursive body walking before any auth
    // boundary; future public body routes must validate their own payloads.
    return [normalizeRequestTarget, createSecuredHandler(input.route, input.options)];
  }
  return [
    normalizeRequestTarget,
    ...(input.route.responseKind === 'sse' ? [createConsoleStreamRequestProtectionMiddleware(input.route, input.options)] : []),
    input.authenticate,
    input.normalizeBody,
    ...(input.userContext ? [input.userContext] : []),
    input.csrf,
    createConsoleAuthorizationMiddleware(input.route, input.options),
    createConsoleOwnershipMiddleware(input.route, input.options),
    createConsoleRateLimitMiddleware(input.route, input.options),
    createSecuredHandler(input.route, input.options),
  ];
}

function createConsoleStreamRequestProtectionMiddleware(
  route: ConsoleRouteDefinition,
  options: SecuredConsoleRouterOptions,
): RequestHandler {
  return (request, response, next): void => {
    const req = request as ConsoleRequest;
    if (!streamOriginAllowed(req, options.consoleOrigin) || hasForbiddenStreamCredential(req)) {
      sendProblemResponse(response, {
        status: 403,
        code: 'csrf_failed',
        title: 'CSRF validation failed',
        detail: 'The stream request did not satisfy browser request protections.',
      }, requireConsoleRequestContext(req).correlationId);
      return;
    }
    if (route.method !== 'GET') {
      sendProblemResponse(response, {
        status: 500,
        code: 'internal_error',
        title: 'Internal error',
        detail: 'Stream routes must use GET.',
      }, requireConsoleRequestContext(req).correlationId);
      return;
    }
    next();
  };
}

function streamOriginAllowed(req: ConsoleRequest, consoleOrigin: string): boolean {
  const rawOrigin = req.headers.origin;
  if (rawOrigin !== undefined && typeof rawOrigin !== 'string') return false;
  if (rawOrigin === consoleOrigin) return true;
  if (rawOrigin !== undefined) return false;
  return singleHeader(req.headers['sec-fetch-site']) === 'same-origin';
}

function hasForbiddenStreamCredential(req: ConsoleRequest): boolean {
  return firstQueryString(req.query.token) !== null ||
    firstQueryString(req.query.access_token) !== null ||
    firstQueryString(req.query.bearer) !== null;
}

function firstQueryString(value: ConsoleRequest['query'][string]): string | null {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null;
  return typeof value === 'string' ? value : null;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
      try {
        const execution = await executeWithConsoleIdempotency(
          route,
          req,
          options.idempotencyStore,
          () => executeAuditedConsoleRoute(route, req, options, occurredAt),
          occurredAt,
        );
        if (execution.interceptedAuditResult) {
          await writeConsoleAdminAudit(
            options.adminAuditWriter,
            route,
            req,
            execution.interceptedAuditResult,
            execution.kind === 'problem' ? execution.problem.code : null,
            occurredAt,
          );
        }
        if (execution.kind === 'problem') {
          sendProblemResponse(
            response,
            execution.problem,
            requireConsoleRequestContext(req).correlationId,
          );
          return;
        }
        sendConsoleHandlerResult(response, execution.result, req);
      } catch (error) {
        next(error);
      }
    })();
  };
}

async function executeAuditedConsoleRoute(
  route: ConsoleRouteDefinition,
  req: ConsoleRequest,
  options: SecuredConsoleRouterOptions,
  occurredAt: Date,
) {
  let result;
  try {
    result = await executeConsoleRoute(route, req);
  } catch (error) {
    if (route.audience !== 'admin') throw error;
    const problem = problemForConsoleError(error);
    try {
      await writeConsoleAdminAudit(
        options.adminAuditWriter,
        route,
        req,
        'failed',
        problem?.code ?? 'internal_error',
        occurredAt,
      );
    } catch (auditError) {
      throw new AggregateError(
        [error, auditError],
        'Console route execution and required administrative audit write both failed',
      );
    }
    throw error;
  }
  if (route.audience === 'admin' && route.auditExecution !== 'handler_transaction') {
    await writeConsoleAdminAudit(options.adminAuditWriter, route, req, 'approved', null, occurredAt);
  }
  if (!result.stream || !route.streamPolicy) return result;
  const correlationId = requireConsoleRequestContext(req).correlationId;
  const routeRevalidate = result.stream.revalidate;
  return {
    ...result,
    stream: {
      ...result.stream,
      revalidate: async () =>
        await revalidateConsoleStream(route, req, options) &&
        (routeRevalidate ? await routeRevalidate() : true),
      reportStreamError: (error: unknown) => options.reportInternalError?.(error, correlationId),
    },
  };
}

async function revalidateConsoleStream(
  route: ConsoleRouteDefinition,
  req: ConsoleRequest,
  options: SecuredConsoleRouterOptions,
): Promise<boolean> {
  const authentication = requireConsoleAuthentication(req);
  const now = options.now?.() ?? new Date();
  const session = await options.sessionStore.findActiveByIdHash(authentication.sessionIdHash, now);
  if (session === null) return false;
  if (session.userId !== authentication.userId || session.authSub !== authentication.authSub) return false;
  const principal = await options.identityResolver.resolveEnabledPrincipal(session.authSub);
  if (principal?.userId !== session.userId || principal.authzVersion !== authentication.authzVersion) return false;
  if (route.requiredCapability === 'none') return false;
  const requiredCapability = route.requiredCapability;
  if (!session.grantedCapabilities.includes(requiredCapability)) return false;
  if (!authentication.grantedCapabilities.includes(requiredCapability)) return false;
  if (route.audience !== 'admin') return true;
  const authPolicy = options.authPolicyStore ? await options.authPolicyStore.load() : null;
  return isElevationValidForRoute(authentication, route, now, authPolicy?.maxAdminElevationSeconds);
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
