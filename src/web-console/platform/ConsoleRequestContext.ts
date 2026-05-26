import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { ConsoleRequest, ConsoleRequestContext } from './ConsolePlatformTypes.js';

// The API contract accepts client UUIDs as opaque correlation values; only
// server-generated values are constrained by randomUUID() to UUIDv4.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

function incomingCorrelationId(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return UUID_PATTERN.test(value) ? value : undefined;
}

export function createConsoleRequestContextMiddleware(): RequestHandler {
  return (request, response, next): void => {
    const req = request as ConsoleRequest;
    const correlationId = incomingCorrelationId(req.headers['x-correlation-id']) ?? randomUUID();

    req.consoleContext = {
      correlationId,
      receivedAt: new Date(),
    };
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    next();
  };
}

export function requireConsoleRequestContext(req: ConsoleRequest): ConsoleRequestContext {
  if (!req.consoleContext) {
    throw new Error('Console request context middleware has not run');
  }
  return req.consoleContext;
}
