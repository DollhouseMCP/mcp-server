import type { Response } from 'express';

import type {
  ConsoleHandlerResult,
  ConsoleRequest,
  ConsoleRouteDefinition,
} from './ConsolePlatformTypes.js';
import { serializeConsoleCookie, validateConsoleCookieDirectives } from '../middleware/ConsoleCookies.js';

export async function executeConsoleRoute(
  route: ConsoleRouteDefinition,
  req: ConsoleRequest,
): Promise<ConsoleHandlerResult> {
  const result = await route.handler(req);
  validateResult(result);
  if (route.audience !== 'admin') return result;
  if (!route.privacyProjector) {
    throw new Error('Validated administrative route is missing its privacy projector');
  }
  return {
    ...result,
    body: route.privacyProjector(result.body),
  };
}

export function sendConsoleHandlerResult(response: Response, result: ConsoleHandlerResult): void {
  validateResult(result);
  for (const cookie of result.cookies ?? []) {
    response.append('Set-Cookie', serializeConsoleCookie(cookie));
  }
  if (result.redirectTo) {
    response.location(result.redirectTo);
  }
  if (result.body === undefined) {
    response.status(result.status).end();
    return;
  }
  response.status(result.status).json(result.body);
}

function validateResult(result: ConsoleHandlerResult): void {
  if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) {
    throw new Error('Console route handler returned an invalid HTTP status');
  }
  if (result.cookies && !Array.isArray(result.cookies)) {
    throw new Error('Console route handler returned invalid cookie directives');
  }
  validateConsoleCookieDirectives(result.cookies);
  if (result.redirectTo !== undefined) {
    if (typeof result.redirectTo !== 'string' || result.redirectTo.trim() === '') {
      throw new Error('Console route handler returned an invalid redirect target');
    }
    if (/[\r\n]/.test(result.redirectTo)) {
      throw new Error('Console route handler returned an invalid redirect target');
    }
    if (result.status < 300 || result.status > 399) {
      throw new Error('Console route handler returned a redirect target with a non-redirect status');
    }
  }
}
