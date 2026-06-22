import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
  assembleConsoleRouter,
  ConsoleModuleRegistry,
  createConsoleRequestContextMiddleware,
  createProblemDetails,
  requireConsoleRequestContext,
  sendProblemResponse,
  type ConsoleModuleDescriptor,
} from '../../../../src/web-console/index.js';

const CLIENT_CORRELATION_ID = 'ac2422b8-243f-4a67-9df6-87643c7a77a4';
const CLIENT_UUID_V7_CORRELATION_ID = '0193501a-8e68-7d4c-a4f5-35c1716e91af';
const CORRELATION_REQUEST_HEADER = 'X-Correlation-Id';
const CORRELATION_RESPONSE_HEADER = 'x-correlation-id';
const PROFILE_PATH = '/api/v1/me/profile';
const SELF_CAPABILITY = 'console:self';

function contextFixtureModule(): ConsoleModuleDescriptor {
  return {
    id: 'profile',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    routes: [{
      method: 'GET',
      path: PROFILE_PATH,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      handler: req => {
        const context = requireConsoleRequestContext(req);
        return {
          status: 200,
          body: {
            correlationId: context.correlationId,
            hasReceivedAt: context.receivedAt instanceof Date,
          },
        };
      },
    }],
  };
}

function buildApp(): express.Express {
  const registry = new ConsoleModuleRegistry();
  registry.register(contextFixtureModule());

  const app = express();
  app.use(assembleConsoleRouter(registry));
  return app;
}

describe('console platform HTTP foundations', () => {
  it('assembles a fixture module and adopts a valid incoming correlation ID', async () => {
    const response = await request(buildApp())
      .get(PROFILE_PATH)
      .set(CORRELATION_REQUEST_HEADER, CLIENT_CORRELATION_ID);

    expect(response.status).toBe(200);
    expect(response.headers[CORRELATION_RESPONSE_HEADER]).toBe(CLIENT_CORRELATION_ID);
    expect(response.body).toEqual({
      correlationId: CLIENT_CORRELATION_ID,
      hasReceivedAt: true,
    });
  });

  it('generates a UUID correlation ID when the client value is invalid', async () => {
    const response = await request(buildApp())
      .get(PROFILE_PATH)
      .set(CORRELATION_REQUEST_HEADER, 'not-a-uuid');

    expect(response.status).toBe(200);
    expect(response.headers[CORRELATION_RESPONSE_HEADER]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.body.correlationId).toBe(response.headers[CORRELATION_RESPONSE_HEADER]);
  });

  it('adopts newer valid UUID versions supplied by a client', async () => {
    const response = await request(buildApp())
      .get(PROFILE_PATH)
      .set(CORRELATION_REQUEST_HEADER, CLIENT_UUID_V7_CORRELATION_ID);

    expect(response.headers[CORRELATION_RESPONSE_HEADER]).toBe(CLIENT_UUID_V7_CORRELATION_ID);
    expect(response.body.correlationId).toBe(CLIENT_UUID_V7_CORRELATION_ID);
  });

  it('treats folded multiple client correlation IDs as invalid input', async () => {
    const response = await request(buildApp())
      .get(PROFILE_PATH)
      .set(CORRELATION_REQUEST_HEADER, [CLIENT_CORRELATION_ID, CLIENT_UUID_V7_CORRELATION_ID] as unknown as string);

    expect(response.headers[CORRELATION_RESPONSE_HEADER]).not.toBe(CLIENT_CORRELATION_ID);
    expect(response.headers[CORRELATION_RESPONSE_HEADER]).not.toBe(CLIENT_UUID_V7_CORRELATION_ID);
    expect(response.headers[CORRELATION_RESPONSE_HEADER]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('constructs an RFC 9457 body with extension members', () => {
    expect(createProblemDetails({
      status: 401,
      code: 'step_up_required',
      title: 'Step-up elevation required',
      detail: 'Fresh elevation is required.',
      extensions: {
        required_capability: 'console:admin:accounts',
        max_auth_age_seconds: 300,
      },
    }, CLIENT_CORRELATION_ID)).toEqual({
      type: 'https://dollhousemcp.com/errors/step_up_required',
      title: 'Step-up elevation required',
      status: 401,
      detail: 'Fresh elevation is required.',
      instance: CLIENT_CORRELATION_ID,
      code: 'step_up_required',
      required_capability: 'console:admin:accounts',
      max_auth_age_seconds: 300,
    });
  });

  it('constructs an RFC 9457 body when no extension members are supplied', () => {
    expect(createProblemDetails({
      status: 500,
      code: 'internal_error',
      title: 'Internal error',
      detail: 'The request failed.',
    }, CLIENT_CORRELATION_ID)).toEqual({
      type: 'https://dollhousemcp.com/errors/internal_error',
      title: 'Internal error',
      status: 500,
      detail: 'The request failed.',
      instance: CLIENT_CORRELATION_ID,
      code: 'internal_error',
    });
  });

  it('rejects extension members that would replace RFC 9457 platform members', () => {
    expect(() => createProblemDetails({
      status: 404,
      code: 'not_found',
      title: 'Not found',
      detail: 'The requested item is not available.',
      extensions: { status: 200 },
    }, CLIENT_CORRELATION_ID)).toThrow(/extension member "status" is reserved/);
  });

  it('throws when a handler requires context before middleware initialization', () => {
    expect(() => requireConsoleRequestContext({} as never)).toThrow(
      /request context middleware has not run/,
    );
  });

  it('assembles an empty registry without exposing any route', async () => {
    const app = express();
    app.use(assembleConsoleRouter(new ConsoleModuleRegistry()));

    const response = await request(app).get(PROFILE_PATH);

    expect(response.status).toBe(404);
    expect(response.headers[CORRELATION_RESPONSE_HEADER]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('assembles multiple independent module routes in registration order', async () => {
    const registry = new ConsoleModuleRegistry();
    registry.register(contextFixtureModule());
    registry.register({
      id: 'settings',
      apiVersion: 'v1',
      capabilities: [SELF_CAPABILITY],
      routes: [{
        method: 'GET',
        path: '/api/v1/me/settings',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        handler: () => ({ status: 200, body: { route: 'settings' } }),
      }],
    });
    const app = express();
    app.use(assembleConsoleRouter(registry));

    const response = await request(app).get('/api/v1/me/settings');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ route: 'settings' });
    expect(registry.createRouteManifest().routes.map(route => route.moduleId)).toEqual(['profile', 'settings']);
  });

  it('normalizes route params, query values, and JSON body keys while preserving body strings', async () => {
    const registry = new ConsoleModuleRegistry();
    registry.register({
      id: 'unicode',
      apiVersion: 'v1',
      capabilities: [SELF_CAPABILITY],
      routes: [{
        method: 'POST',
        path: '/api/v1/me/unicode/:name',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        handler: req => ({
          status: 200,
          body: {
            param: req.params.name,
            query: req.query.q,
            keyed: (req.body as Record<string, unknown>)['café'],
            nested: (req.body as { nested: { label: string } }).nested.label,
            content: (req.body as { content: string }).content,
          },
        }),
      }],
    });
    const app = express();
    app.use(express.json());
    app.use(assembleConsoleRouter(registry));

    const decomposedCafe = 'cafe\u0301';
    const familyEmoji = 'family: 👨‍👩‍👧‍👦';
    const response = await request(app)
      .post(`/api/v1/me/unicode/${encodeURIComponent(decomposedCafe)}?q=${encodeURIComponent(decomposedCafe)}`)
      .send({
        [decomposedCafe]: 'body-key-normalized',
        nested: { label: decomposedCafe },
        content: familyEmoji,
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      param: 'café',
      query: 'café',
      keyed: 'body-key-normalized',
      nested: decomposedCafe,
      content: familyEmoji,
    });
  });

  it('normalizes JSON bodies without invoking prototype setters', async () => {
    const registry = new ConsoleModuleRegistry();
    registry.register({
      id: 'prototype-guard',
      apiVersion: 'v1',
      capabilities: [SELF_CAPABILITY],
      routes: [{
        method: 'POST',
        path: '/api/v1/me/prototype-guard',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        handler: req => {
          const body = req.body as Record<string, unknown>;
          const nested = body.nested as Record<string, unknown>;
          const bodyPrototype = Object.getPrototypeOf(body) as { readonly role?: unknown } | null;
          const nestedPrototype = Object.getPrototypeOf(nested) as { readonly role?: unknown } | null;
          const cleanObject = {} as { readonly role?: unknown };

          return {
            status: 200,
            body: {
              bodyOwnProto: Object.prototype.hasOwnProperty.call(body, '__proto__'),
              bodyPrototypeIsNull: bodyPrototype === null,
              bodyPrototypeRole: typeof bodyPrototype?.role === 'string' ? bodyPrototype.role : null,
              nestedOwnProto: Object.prototype.hasOwnProperty.call(nested, '__proto__'),
              nestedPrototypeIsNull: nestedPrototype === null,
              nestedPrototypeRole: typeof nestedPrototype?.role === 'string' ? nestedPrototype.role : null,
              globalPrototypeRole: typeof cleanObject.role === 'string' ? cleanObject.role : null,
              label: nested.label,
            },
          };
        },
      }],
    });
    const app = express();
    app.use(express.json());
    app.use(assembleConsoleRouter(registry));

    const response = await request(app)
      .post('/api/v1/me/prototype-guard')
      .set('Content-Type', 'application/json')
      .send('{"__proto__":{"role":"admin"},"nested":{"label":"cafe\\u0301","__proto__":{"role":"nested-admin"}}}');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      bodyOwnProto: true,
      bodyPrototypeIsNull: true,
      bodyPrototypeRole: null,
      nestedOwnProto: true,
      nestedPrototypeIsNull: true,
      nestedPrototypeRole: null,
      globalPrototypeRole: null,
      label: 'cafe\u0301',
    });
  });

  it('sends allowlisted handler headers', async () => {
    const registry = new ConsoleModuleRegistry();
    registry.register({
      id: 'settings',
      apiVersion: 'v1',
      capabilities: [SELF_CAPABILITY],
      routes: [{
        method: 'GET',
        path: '/api/v1/me/settings',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        handler: () => ({
          status: 200,
          headers: { ETag: '"settings-1"' },
          body: { route: 'settings' },
        }),
      }],
    });
    const app = express();
    app.use(assembleConsoleRouter(registry));

    const response = await request(app).get('/api/v1/me/settings');

    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe('"settings-1"');
    expect(response.body).toEqual({ route: 'settings' });
  });

  it('rejects invalid or reserved handler headers', async () => {
    const { sendConsoleHandlerResult } = await import('../../../../src/web-console/index.js');
    const response = {
      setHeader: jest.fn(),
      append: jest.fn(),
      status: jest.fn(() => response),
      json: jest.fn(),
      end: jest.fn(),
      location: jest.fn(),
    };

    expect(() => sendConsoleHandlerResult(response as never, {
      status: 200,
      headers: { 'Content-Security-Policy': 'default-src *' } as never,
      body: {},
    })).toThrow('invalid headers');
    expect(() => sendConsoleHandlerResult(response as never, {
      status: 200,
      headers: { ETag: '"ok"\r\nX-Test: bad' },
      body: {},
    })).toThrow('invalid headers');
    expect(() => sendConsoleHandlerResult(response as never, {
      status: 200,
      headers: [] as never,
      body: {},
    })).toThrow('invalid headers');
    expect(() => sendConsoleHandlerResult(response as never, {
      status: 200,
      headers: { ETag: 'W/"caf\u00e9"' },
      body: {},
    })).toThrow('invalid headers');
  });

  it('sends RFC 9457 responses with the problem media type and request instance', async () => {
    const app = express();
    app.use(createConsoleRequestContextMiddleware());
    app.get('/api/v1/me/problem', (req, res) => {
      sendProblemResponse(res, {
        status: 404,
        code: 'not_found',
        title: 'Not found',
        detail: 'The requested item is not available.',
      }, requireConsoleRequestContext(req).correlationId);
    });
    const response = await request(app)
      .get('/api/v1/me/problem')
      .set(CORRELATION_REQUEST_HEADER, CLIENT_CORRELATION_ID);

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body.instance).toBe(CLIENT_CORRELATION_ID);
    expect(response.body.code).toBe('not_found');
  });
});
