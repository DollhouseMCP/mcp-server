import { describe, expect, it, jest } from '@jest/globals';
import type { Response } from 'express';

import {
  executeConsoleRoute,
  InMemoryAdminAuditWriter,
  sendConsoleHandlerResult,
  type ConsoleAdminAuditEvent,
  type ConsoleRouteDefinition,
  type ConsoleSseEvent,
} from '../../../../src/web-console/index.js';
import {
  CONSOLE_CSRF_COOKIE,
  CONSOLE_INTEGRATION_STATE_COOKIE,
  CONSOLE_LOGIN_STATE_COOKIE,
  CONSOLE_SESSION_COOKIE,
  serializeConsoleCookie,
} from '../../../../src/web-console/middleware/ConsoleCookies.js';

function route(overrides: Partial<ConsoleRouteDefinition> = {}): ConsoleRouteDefinition {
  return {
    method: 'GET',
    path: '/api/v1/me/result',
    audience: 'self',
    requiredCapability: 'console:self',
    ownership: 'authenticated_user',
    elevation: 'none',
    privacyClass: 'self_private',
    idempotency: 'not_applicable',
    handler: () => ({ status: 200, body: { visible: true } }),
    ...overrides,
  };
}

function auditEvent(): ConsoleAdminAuditEvent {
  return {
    occurredAt: new Date('2026-05-26T12:00:00.000Z'),
    actorUserId: '018f3d47-73ae-7f10-a0de-0742618d4fb1',
    actorSub: 'github_user-7',
    actorRole: null,
    actorCapabilityRole: 'auditor',
    actorConsoleSessionHash: Buffer.alloc(32, 7),
    capability: 'console:admin:audit',
    elevationAcr: 'urn:dollhouse:acr:admin-stepup',
    elevationAmr: ['otp'],
    elevationAuthTime: new Date('2026-05-26T11:55:00.000Z'),
    correlationId: 'ac2422b8-243f-4a67-9df6-87643c7a77a4',
    endpoint: 'GET /api/v1/admin/audit',
    operation: 'admin.audit.read',
    resourceKind: null,
    resourceId: null,
    targetUserId: null,
    argsRedacted: { filter: 'metadata-only' },
    result: 'approved',
    errorCode: null,
    resultDetailRedacted: { count: 1 },
    clientIp: '192.0.2.10',
    userAgent: 'console-test',
  };
}

describe('console route policy execution', () => {
  it('applies administrative privacy projection before returning a route result', async () => {
    const result = await executeConsoleRoute(route({
      path: '/api/v1/admin/audit',
      audience: 'admin',
      requiredCapability: 'console:admin:audit',
      elevation: 'admin_30m',
      privacyClass: 'admin_audit',
      auditOperation: 'admin.audit.read',
      privacyProjector: value => ({ visible: (value as { visible: boolean }).visible }),
      handler: () => ({ status: 200, body: { visible: true, rawPrivate: 'hidden' } }),
    }), {} as never);

    expect(result).toEqual({ status: 200, body: { visible: true } });
  });

  it('leaves administrative problem bodies unprojected', async () => {
    const projector = jest.fn(value => ({ visible: (value as { visible: boolean }).visible }));
    const problem = {
      type: 'about:blank',
      title: 'Not found',
      status: 404,
      code: 'not_found',
      detail: 'The requested resource was not found.',
    };

    const result = await executeConsoleRoute(route({
      path: '/api/v1/admin/audit/missing',
      audience: 'admin',
      requiredCapability: 'console:admin:audit',
      elevation: 'admin_30m',
      privacyClass: 'admin_audit',
      auditOperation: 'admin.audit.read',
      privacyProjector: projector,
      handler: () => ({ status: 404, body: problem }),
    }), {} as never);

    expect(result).toEqual({ status: 404, body: problem });
    expect(projector).not.toHaveBeenCalled();
  });

  it('applies self-service privacy projection before returning a route result', async () => {
    const projector = jest.fn(value => ({ visible: (value as { visible: boolean }).visible }));

    const result = await executeConsoleRoute(route({
      privacyProjector: projector,
      handler: () => ({ status: 200, body: { visible: true, rawPrivate: 'hidden' } }),
    }), {} as never);

    expect(result.body).toEqual({ visible: true });
    expect(projector).toHaveBeenCalledTimes(1);
  });

  it('leaves self-service problem bodies unprojected', async () => {
    const projector = jest.fn(value => ({ visible: (value as { visible: boolean }).visible }));
    const problem = {
      type: 'about:blank',
      title: 'Validation failed',
      status: 422,
      code: 'validation_failed',
      detail: 'goal_id is invalid',
    };

    const result = await executeConsoleRoute(route({
      privacyProjector: projector,
      handler: () => ({ status: 422, body: problem }),
    }), {} as never);

    expect(result).toEqual({ status: 422, body: problem });
    expect(projector).not.toHaveBeenCalled();
  });

  it('leaves public non-stream route results unprojected', async () => {
    const projector = jest.fn(value => value);

    const result = await executeConsoleRoute(route({
      audience: 'public',
      requiredCapability: 'none',
      ownership: 'none',
      privacyProjector: projector,
      handler: () => ({ status: 200, body: { visible: true, publicValue: 'kept' } }),
    }), {} as never);

    expect(result.body).toEqual({ visible: true, publicValue: 'kept' });
    expect(projector).not.toHaveBeenCalled();
  });

  it('projects self-service streams by SSE event name when a projector is declared', async () => {
    const result = await executeConsoleRoute(route({
      responseKind: 'sse',
      streamPolicy: {
        lastEventId: 'unsupported',
        heartbeatMs: 15_000,
        revalidateMs: 15_000,
        maxLifetimeMs: 15 * 60_000,
        backpressureDrainTimeoutMs: 30_000,
        maxEventBytes: 65_536,
        maxLastEventIdBytes: 512,
      },
      privacyProjector: value => ({ fallback_visible: (value as { visible: boolean }).visible }),
      streamEventProjectors: {
        init: value => ({ init_visible: (value as { visible: boolean }).visible }),
        update: value => ({ update_visible: (value as { visible: boolean }).visible }),
      },
      handler: () => ({
        status: 200,
        stream: {
          init: { visible: true, rawPrivate: 'hidden' },
          events: emptySseEvents(),
        },
      }),
    }), {} as never);

    expect(result.stream?.projectEvent?.({
      event: 'update',
      data: { visible: true, rawPrivate: 'hidden' },
    })).toEqual({
      event: 'update',
      data: { update_visible: true },
    });
    expect(result.stream?.projectEvent?.({
      event: 'custom',
      data: { visible: true, rawPrivate: 'hidden' },
    })).toEqual({
      event: 'custom',
      data: { fallback_visible: true },
    });
  });

  it.each([Number.NaN, -1, 600])('rejects invalid route status %s', async status => {
    await expect(executeConsoleRoute(route({
      handler: () => ({ status }),
    }), {} as never)).rejects.toThrow('invalid HTTP status');
  });

  it('propagates failures from an administrative privacy projector', async () => {
    await expect(executeConsoleRoute(route({
      audience: 'admin',
      requiredCapability: 'console:admin:audit',
      elevation: 'admin_30m',
      privacyClass: 'admin_audit',
      auditOperation: 'admin.audit.read',
      privacyProjector: () => {
        throw new Error('projection rejected input');
      },
    }), {} as never)).rejects.toThrow('projection rejected input');
  });

  it('projects administrative streams by SSE event name before serialization', async () => {
    const result = await executeConsoleRoute(route({
      path: '/api/v1/admin/operate/logs/stream',
      audience: 'admin',
      requiredCapability: 'console:admin:operate',
      elevation: 'admin_30m',
      privacyClass: 'operational_allowlist',
      auditOperation: 'operate.logs.stream',
      responseKind: 'sse',
      streamPolicy: {
        lastEventId: 'bounded',
        heartbeatMs: 15_000,
        revalidateMs: 15_000,
        maxLifetimeMs: 15 * 60_000,
        backpressureDrainTimeoutMs: 30_000,
        maxEventBytes: 65_536,
        maxLastEventIdBytes: 512,
      },
      privacyProjector: value => ({ fallback_visible: (value as { visible: boolean }).visible }),
      streamEventProjectors: {
        init: value => ({ init_visible: (value as { visible: boolean }).visible }),
        update: value => ({ update_visible: (value as { visible: boolean }).visible }),
        end: value => ({ end_status: (value as { status: string }).status }),
      },
      handler: () => ({
        status: 200,
        stream: {
          init: { visible: true, rawPrivate: 'hidden' },
          events: emptySseEvents(),
        },
      }),
    }), {} as never);

    const projector = result.stream?.projectEvent;
    expect(projector?.({
      event: 'update',
      data: { visible: true, rawPrivate: 'hidden' },
    })).toEqual({
      event: 'update',
      data: { update_visible: true },
    });
    expect(projector?.({
      event: 'init',
      data: { visible: true, rawPrivate: 'hidden' },
    })).toEqual({
      event: 'init',
      data: { init_visible: true },
    });
    expect(projector?.({
      event: 'end',
      data: { status: 'complete', rawPrivate: 'hidden' },
    })).toEqual({
      event: 'end',
      data: { end_status: 'complete' },
    });
    expect(projector?.({
      event: 'custom',
      data: { visible: true, rawPrivate: 'hidden' },
    })).toEqual({
      event: 'custom',
      data: { fallback_visible: true },
    });
  });

  it('serializes body results as JSON and completes bodyless results without JSON output', () => {
    const json = jest.fn();
    const end = jest.fn();
    const response = {
      status: jest.fn().mockReturnThis(),
      json,
      end,
    } as unknown as Response;

    sendConsoleHandlerResult(response, { status: 204 });
    expect(response.status).toHaveBeenCalledWith(204);
    expect(end).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();

    sendConsoleHandlerResult(response, { status: 200, body: { ok: true } });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ok: true });
  });

  it('emits platform-controlled cookie directives before completing a response', () => {
    const response = {
      append: jest.fn(),
      status: jest.fn().mockReturnThis(),
      end: jest.fn(),
    } as unknown as Response;

    sendConsoleHandlerResult(response, {
      status: 204,
      cookies: [
        { operation: 'set', name: CONSOLE_SESSION_COOKIE, value: 'opaque session' },
        { operation: 'clear', name: CONSOLE_CSRF_COOKIE },
      ],
    });

    expect(response.append).toHaveBeenCalledWith(
      'Set-Cookie',
      'dh_session=opaque%20session; Path=/; Secure; SameSite=Lax; HttpOnly',
    );
    expect(response.append).toHaveBeenCalledWith(
      'Set-Cookie',
      'dh_csrf=; Path=/; Max-Age=0; Secure; SameSite=Lax',
    );
    expect(response.status).toHaveBeenCalledWith(204);
  });

  it('validates cookie directives even when serializing a fabricated result directly', () => {
    const response = {
      append: jest.fn(),
      status: jest.fn().mockReturnThis(),
      end: jest.fn(),
    } as unknown as Response;

    expect(() => sendConsoleHandlerResult(response, {
      status: 204,
      cookies: { operation: 'clear', name: CONSOLE_SESSION_COOKIE } as never,
    })).toThrow('invalid cookie directives');
    expect(() => sendConsoleHandlerResult(response, {
      status: 204,
      cookies: [{ operation: 'set', name: CONSOLE_SESSION_COOKIE, value: '' }],
    })).toThrow('non-empty value');
    expect(response.append).not.toHaveBeenCalled();
  });

  it('rejects invalid redirect targets before writing response headers', () => {
    const response = {
      location: jest.fn(),
      status: jest.fn().mockReturnThis(),
      end: jest.fn(),
    } as unknown as Response;

    expect(() => sendConsoleHandlerResult(response, {
      status: 302,
      redirectTo: '/safe\r\nSet-Cookie: injected=1',
    })).toThrow('invalid redirect target');
    expect(() => sendConsoleHandlerResult(response, {
      status: 200,
      redirectTo: '/not-a-redirect',
    })).toThrow('non-redirect status');
    expect(response.location).not.toHaveBeenCalled();
  });

  it('rejects invalid SSE result shapes before writing response headers', () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      end: jest.fn(),
    } as unknown as Response;

    expect(() => sendConsoleHandlerResult(response, {
      status: 204,
      stream: { events: emptySseEvents() },
    })).toThrow('invalid SSE result');
    expect(() => sendConsoleHandlerResult(response, {
      status: 200,
      body: { ok: true },
      stream: { events: emptySseEvents() },
    })).toThrow('invalid SSE result');
    expect(() => sendConsoleHandlerResult(response, {
      status: 302,
      redirectTo: '/elsewhere',
      stream: { events: emptySseEvents() },
    })).toThrow('invalid SSE result');
    expect(response.status).not.toHaveBeenCalled();
  });
});

const EMPTY_SSE_EVENTS: AsyncIterable<ConsoleSseEvent> = {
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined as never }),
  }),
};

function emptySseEvents(): AsyncIterable<ConsoleSseEvent> {
  return EMPTY_SSE_EVENTS;
}

describe('console cookie directives', () => {
  it('serializes fixed BFF cookie policies from the API contract', () => {
    expect(serializeConsoleCookie({
      operation: 'set',
      name: CONSOLE_LOGIN_STATE_COOKIE,
      value: 'login-state',
    })).toBe('dh_login_state=login-state; Path=/api/v1/auth; Max-Age=600; Secure; SameSite=Lax; HttpOnly');
    expect(serializeConsoleCookie({
      operation: 'set',
      name: CONSOLE_INTEGRATION_STATE_COOKIE,
      value: 'integration-state',
    })).toBe('dh_integration_state=integration-state; Path=/api/v1/me/integrations; Max-Age=600; Secure; SameSite=Lax; HttpOnly');
    expect(serializeConsoleCookie({
      operation: 'set',
      name: CONSOLE_CSRF_COOKIE,
      value: 'csrf-token',
    })).toBe('dh_csrf=csrf-token; Path=/; Secure; SameSite=Lax');
  });

  it('uses the cookie-specific path and HttpOnly policy when clearing values', () => {
    expect(serializeConsoleCookie({
      operation: 'clear',
      name: CONSOLE_LOGIN_STATE_COOKIE,
    })).toBe('dh_login_state=; Path=/api/v1/auth; Max-Age=0; Secure; SameSite=Lax; HttpOnly');
    expect(serializeConsoleCookie({
      operation: 'clear',
      name: CONSOLE_SESSION_COOKIE,
    })).toBe('dh_session=; Path=/; Max-Age=0; Secure; SameSite=Lax; HttpOnly');
  });

  it('rejects invalid cookie directives at the kernel boundary', () => {
    expect(() => serializeConsoleCookie({
      operation: 'set',
      name: CONSOLE_SESSION_COOKIE,
      value: '',
    })).toThrow('non-empty value');
    expect(() => serializeConsoleCookie({
      operation: 'set',
      name: CONSOLE_SESSION_COOKIE,
      value: 'x'.repeat(3501),
    })).toThrow('maximum supported size');
    expect(() => serializeConsoleCookie({
      operation: 'set',
      name: CONSOLE_SESSION_COOKIE,
      value: Buffer.from('opaque') as never,
    })).toThrow('must be a string');
    expect(() => serializeConsoleCookie({
      operation: 'set',
      name: 'dh_unknown' as never,
      value: 'opaque',
    })).toThrow('Unknown console cookie name');
  });
});

describe('InMemoryAdminAuditWriter', () => {
  it('isolates retained audit state from input and returned-value mutation', async () => {
    const writer = new InMemoryAdminAuditWriter();
    const event = auditEvent();
    await writer.write(event);

    event.actorConsoleSessionHash[0] = 0;
    (event.elevationAmr as string[]).push('mutated-input');
    event.occurredAt.setUTCFullYear(2000);
    (event.argsRedacted as Record<string, unknown>).filter = 'mutated-input';

    const returned = writer.getEvents()[0];
    returned.actorConsoleSessionHash[1] = 0;
    (returned.elevationAmr as string[]).push('mutated-output');
    returned.elevationAuthTime?.setUTCFullYear(2000);
    (returned.resultDetailRedacted as Record<string, unknown>).count = 99;

    const retained = writer.getEvents()[0];
    expect(retained.actorConsoleSessionHash).toEqual(Buffer.alloc(32, 7));
    expect(retained.elevationAmr).toEqual(['otp']);
    expect(retained.occurredAt).toEqual(new Date('2026-05-26T12:00:00.000Z'));
    expect(retained.elevationAuthTime).toEqual(new Date('2026-05-26T11:55:00.000Z'));
    expect(retained.argsRedacted).toEqual({ filter: 'metadata-only' });
    expect(retained.resultDetailRedacted).toEqual({ count: 1 });
  });

  it('uses the shared audit event validation contract', async () => {
    const writer = new InMemoryAdminAuditWriter();

    await expect(writer.write({
      ...auditEvent(),
      actorConsoleSessionHash: Buffer.alloc(31, 7),
    })).rejects.toThrow('actor session hash');
  });
});
