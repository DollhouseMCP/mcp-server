import type { RequestHandler } from 'express';

import { requireConsoleRequestContext } from '../platform/ConsoleRequestContext.js';
import { sendProblemResponse } from '../platform/ProblemResponses.js';
import type {
  ConsoleElevationPolicy,
  ConsoleRequest,
  ConsoleRouteDefinition,
} from '../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from './ConsoleAuthentication.js';

const ADMIN_ACR = 'urn:dollhouse:acr:admin-stepup';

export interface ConsoleAuthorizationOptions {
  readonly now?: () => Date;
}

export function createConsoleAuthorizationMiddleware(
  route: ConsoleRouteDefinition,
  options: ConsoleAuthorizationOptions = {},
): RequestHandler {
  return (request, response, next): void => {
    const req = request as ConsoleRequest;
    const authentication = requireConsoleAuthentication(req);
    const now = options.now?.() ?? new Date();
    if (route.audience === 'admin' && !hasValidElevation(authentication, route, now)) {
      sendStepUpRequired(req, response, route);
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
  };
}

function hasValidElevation(
  authentication: ReturnType<typeof requireConsoleAuthentication>,
  route: ConsoleRouteDefinition,
  now: Date,
): boolean {
  const elevation = authentication.elevation;
  const freshnessSeconds = elevationPolicySeconds(route.elevation);
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
): void {
  const maxAuthAgeSeconds = elevationPolicySeconds(route.elevation);
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

function elevationPolicySeconds(policy: ConsoleElevationPolicy | undefined): number {
  return policy === 'admin_5m' ? 300 : 1800;
}
