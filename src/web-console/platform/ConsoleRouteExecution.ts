import type { Response } from 'express';

import type {
  ConsoleHandlerResult,
  ConsoleRequest,
  ConsoleRouteDefinition,
} from './ConsolePlatformTypes.js';

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
}
