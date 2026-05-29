import type { RequestHandler } from 'express';

import { requireConsoleRequestContext } from '../platform/ConsoleRequestContext.js';
import { sendProblemResponse } from '../platform/ProblemResponses.js';
import type {
  ConsoleElevationPolicy,
  ConsoleRequest,
  ConsoleRouteDefinition,
} from '../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from './ConsoleAuthentication.js';
import type { IConsoleAuthPolicyStore } from '../stores/IConsoleAuthPolicyStore.js';

const ADMIN_ACR = 'urn:dollhouse:acr:admin-stepup';

export interface ConsoleAuthorizationOptions {
  readonly now?: () => Date;
  readonly authPolicyStore?: IConsoleAuthPolicyStore;
}

export function createConsoleAuthorizationMiddleware(
  route: ConsoleRouteDefinition,
  options: ConsoleAuthorizationOptions = {},
): RequestHandler {
  return (request, response, next): void => {
    const req = request as ConsoleRequest;
    void (async (): Promise<void> => {
      const authentication = requireConsoleAuthentication(req);
      const now = options.now?.() ?? new Date();
      const authPolicy = options.authPolicyStore ? await options.authPolicyStore.load() : null;
      if (route.audience === 'admin' && !hasValidElevation(authentication, route, now, authPolicy?.maxAdminElevationSeconds)) {
        sendStepUpRequired(req, response, route, authPolicy?.maxAdminElevationSeconds);
        return;
      }
      if (route.requiredCapability === 'none') {
        sendProblemResponse(response, {
          status: 500,
          code: 'internal_error',
          title: 'Internal error',
          detail: 'Public routes must not use the authenticated authorization middleware.',
        }, requireConsoleRequestContext(req).correlationId);
        return;
      }
      if (!authentication.grantedCapabilities.includes(route.requiredCapability)) {
        sendProblemResponse(response, {
          status: 403,
          code: 'forbidden',
          title: 'Forbidden',
          detail: 'The console session does not have the required capability.',
        }, requireConsoleRequestContext(req).correlationId);
        return;
      }
      next();
    })().catch(next);
  };
}

function hasValidElevation(
  authentication: ReturnType<typeof requireConsoleAuthentication>,
  route: ConsoleRouteDefinition,
  now: Date,
  maxAdminElevationSeconds?: number,
): boolean {
  if (route.requiredCapability === 'none') return false;
  const elevation = authentication.elevation;
  const freshnessSeconds = elevationPolicySeconds(route.elevation, maxAdminElevationSeconds);
  return !!elevation
    && elevation.capabilities.includes(route.requiredCapability)
    && elevation.expiresAt > now
    && elevation.acr === ADMIN_ACR
    && elevation.amr.includes('otp')
    && elevation.authTime.getTime() + freshnessSeconds * 1000 > now.getTime();
}

function sendStepUpRequired(
  req: ConsoleRequest,
  response: Parameters<typeof sendProblemResponse>[0],
  route: ConsoleRouteDefinition,
  maxAdminElevationSeconds?: number,
): void {
  const maxAuthAgeSeconds = elevationPolicySeconds(route.elevation, maxAdminElevationSeconds);
  sendProblemResponse(response, {
    status: 401,
    code: 'step_up_required',
    title: 'Step-up elevation required',
    detail: 'This endpoint requires fresh admin elevation. Use /api/v1/auth/step-up to elevate.',
    extensions: {
      required_capability: route.requiredCapability,
      required_acr: ADMIN_ACR,
      max_auth_age_seconds: maxAuthAgeSeconds,
      step_up_url: `/api/v1/auth/step-up?capability=${encodeURIComponent(route.requiredCapability)}`,
    },
  }, requireConsoleRequestContext(req).correlationId);
}

function elevationPolicySeconds(policy: ConsoleElevationPolicy | undefined, maxAdminElevationSeconds = 300): number {
  const boundedMax = Math.max(60, Math.min(300, Math.trunc(maxAdminElevationSeconds)));
  return policy === 'admin_5m' ? Math.min(300, boundedMax) : 1800;
}
