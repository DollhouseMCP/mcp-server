import type { Response } from 'express';

import type {
  ConsoleHandlerResult,
  ConsoleRequest,
  ConsoleResponseHeaders,
  ConsoleRouteDefinition,
  ConsoleSseEvent,
} from './ConsolePlatformTypes.js';
import { serializeConsoleCookie, validateConsoleCookieDirectives } from '../middleware/ConsoleCookies.js';
import { sendConsoleSseStream } from './ConsoleSseStream.js';

const ALLOWED_HANDLER_HEADERS = new Set<keyof ConsoleResponseHeaders>([
  'ETag',
  'Cache-Control',
  'Vary',
  'Last-Modified',
]);

export async function executeConsoleRoute(
  route: ConsoleRouteDefinition,
  req: ConsoleRequest,
): Promise<ConsoleHandlerResult> {
  const result = await route.handler(req);
  validateResult(result);
  if (route.audience !== 'admin') return attachSelfRoutePolicy(result, route);
  if (!route.privacyProjector) {
    throw new Error('Validated administrative route is missing its privacy projector');
  }
  if (result.stream) {
    return {
      ...result,
      stream: {
        ...result.stream,
        policy: route.streamPolicy,
        projectEvent: projectStreamEvent(route.privacyProjector, route.streamEventProjectors),
      },
    };
  }
  return {
    ...result,
    body: route.privacyProjector(result.body),
  };
}

function attachSelfRoutePolicy(
  result: ConsoleHandlerResult,
  route: ConsoleRouteDefinition,
): ConsoleHandlerResult {
  if (!result.stream) return result;
  if (!route.privacyProjector) {
    return {
      ...result,
      stream: {
        ...result.stream,
        policy: route.streamPolicy,
      },
    };
  }
  return {
    ...result,
    stream: {
      ...result.stream,
      policy: route.streamPolicy,
      projectEvent: projectStreamEvent(route.privacyProjector, route.streamEventProjectors),
    },
  };
}

export function sendConsoleHandlerResult(response: Response, result: ConsoleHandlerResult, request?: ConsoleRequest): void {
  validateResult(result);
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    response.setHeader(name, value);
  }
  for (const cookie of result.cookies ?? []) {
    response.append('Set-Cookie', serializeConsoleCookie(cookie));
  }
  if (result.redirectTo) {
    response.location(result.redirectTo);
  }
  if (result.stream) {
    void sendConsoleSseStream(response, result.stream.events, result.stream.init, {
      request,
      policy: result.stream.policy,
      projectEvent: result.stream.projectEvent,
      revalidate: result.stream.revalidate,
      reportStreamError: result.stream.reportStreamError,
    })
      .catch(() => {
        if (!response.writableEnded) response.end();
      });
    return;
  }
  if (result.body === undefined) {
    response.status(result.status).end();
    return;
  }
  response.status(result.status).json(result.body);
}

function projectStreamEvent(
  projector: NonNullable<ConsoleRouteDefinition['privacyProjector']>,
  eventProjectors: ConsoleRouteDefinition['streamEventProjectors'] = {},
): (event: ConsoleSseEvent) => ConsoleSseEvent {
  return event => {
    if (event.data === undefined || event.event === 'error') return event;
    const selectedProjector = eventProjectors[event.event] ?? projector;
    return {
      ...event,
      data: selectedProjector(event.data),
    };
  };
}

function validateResult(result: ConsoleHandlerResult): void {
  if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) {
    throw new Error('Console route handler returned an invalid HTTP status');
  }
  if (result.cookies && !Array.isArray(result.cookies)) {
    throw new Error('Console route handler returned invalid cookie directives');
  }
  if (result.stream && (result.status !== 200 || result.body !== undefined || result.redirectTo !== undefined)) {
    throw new Error('Console route handler returned an invalid SSE result');
  }
  validateHeaders(result.headers);
  validateConsoleCookieDirectives(result.cookies);
  validateRedirect(result);
}

function validateHeaders(headers: ConsoleHandlerResult['headers']): void {
  if (headers === undefined) return;
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('Console route handler returned invalid headers');
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!ALLOWED_HANDLER_HEADERS.has(name as keyof ConsoleResponseHeaders) || !isPrintableAsciiHeaderValue(value)) {
      throw new Error('Console route handler returned invalid headers');
    }
  }
}

function isPrintableAsciiHeaderValue(value: string): boolean {
  return typeof value === 'string' && /^[\t\x20-\x7E]*$/.test(value);
}

function validateRedirect(result: ConsoleHandlerResult): void {
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
