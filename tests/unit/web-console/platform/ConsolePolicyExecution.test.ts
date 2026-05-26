import { describe, expect, it, jest } from '@jest/globals';
import type { Response } from 'express';

import {
  executeConsoleRoute,
  InMemoryAdminAuditWriter,
  sendConsoleHandlerResult,
  type ConsoleAdminAuditEvent,
  type ConsoleRouteDefinition,
} from '../../../../src/web-console/index.js';

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
    actorConsoleSessionHash: Buffer.alloc(32, 7),
    capability: 'console:admin:audit',
    elevationAcr: 'urn:dollhouse:acr:admin-stepup',
    elevationAmr: ['otp'],
    elevationAuthTime: new Date('2026-05-26T11:55:00.000Z'),
    correlationId: 'ac2422b8-243f-4a67-9df6-87643c7a77a4',
    endpoint: 'GET /api/v1/admin/audit',
    operation: 'admin.audit.read',
    argsRedacted: {},
    result: 'approved',
    errorCode: null,
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

  it('does not apply administrative projection to self-service results', async () => {
    const projector = jest.fn(value => value);

    const result = await executeConsoleRoute(route({ privacyProjector: projector }), {} as never);

    expect(result.body).toEqual({ visible: true });
    expect(projector).not.toHaveBeenCalled();
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
});

describe('InMemoryAdminAuditWriter', () => {
  it('isolates retained audit state from input and returned-value mutation', async () => {
    const writer = new InMemoryAdminAuditWriter();
    const event = auditEvent();
    await writer.write(event);

    event.actorConsoleSessionHash[0] = 0;
    (event.elevationAmr as string[]).push('mutated-input');
    event.occurredAt.setUTCFullYear(2000);

    const returned = writer.getEvents()[0];
    returned.actorConsoleSessionHash[1] = 0;
    (returned.elevationAmr as string[]).push('mutated-output');
    returned.elevationAuthTime?.setUTCFullYear(2000);

    const retained = writer.getEvents()[0];
    expect(retained.actorConsoleSessionHash).toEqual(Buffer.alloc(32, 7));
    expect(retained.elevationAmr).toEqual(['otp']);
    expect(retained.occurredAt).toEqual(new Date('2026-05-26T12:00:00.000Z'));
    expect(retained.elevationAuthTime).toEqual(new Date('2026-05-26T11:55:00.000Z'));
  });
});
