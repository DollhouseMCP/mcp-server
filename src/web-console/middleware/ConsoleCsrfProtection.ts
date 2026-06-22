import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

import { requireConsoleRequestContext } from '../platform/ConsoleRequestContext.js';
import { sendProblemResponse } from '../platform/ProblemResponses.js';
import type { ConsoleRequest } from '../platform/ConsolePlatformTypes.js';
import type { IConsoleOpaqueValueService } from '../security/ConsoleOpaqueValues.js';
import { requireConsoleAuthentication, sessionCsrfHashMatches } from './ConsoleAuthentication.js';
import { CONSOLE_CSRF_COOKIE, readCookie } from './ConsoleCookies.js';

const MUTATING_METHODS = new Set<string>(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface ConsoleCsrfProtectionOptions {
  readonly consoleOrigin: string;
  readonly opaqueValues: IConsoleOpaqueValueService;
}

/**
 * Must run after console authentication, which owns the stored CSRF binding.
 */
export function createConsoleCsrfProtectionMiddleware(
  options: ConsoleCsrfProtectionOptions,
): RequestHandler {
  return (request, response, next): void => {
    const req = request as ConsoleRequest;
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }
    requireConsoleAuthentication(req);
    const csrfCookie = readCookie(req.headers.cookie, CONSOLE_CSRF_COOKIE);
    const csrfHeader = singleHeader(req.headers['x-csrf-token']);
    const origin = singleHeader(req.headers.origin);
    const fetchSite = singleHeader(req.headers['sec-fetch-site']);
    const customRequestHeader = singleHeader(req.headers['x-console-request']);

    if (!csrfCookie || !csrfValuesEqual(csrfCookie, csrfHeader)
        || !sessionCsrfHashMatches(req, csrfCookie, options.opaqueValues)
        || (origin !== options.consoleOrigin && !(origin === undefined && fetchSite === 'same-origin'))
        || customRequestHeader !== '1') {
      sendProblemResponse(response, {
        status: 403,
        code: 'csrf_failed',
        title: 'CSRF validation failed',
        detail: 'The request did not satisfy browser request protections.',
      }, requireConsoleRequestContext(req).correlationId);
      return;
    }
    next();
  };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function csrfValuesEqual(cookie: string, header: string | undefined): boolean {
  if (header === undefined) return false;
  const cookieBytes = Buffer.from(cookie, 'utf8');
  const headerBytes = Buffer.from(header, 'utf8');
  return cookieBytes.length === headerBytes.length && timingSafeEqual(cookieBytes, headerBytes);
}
