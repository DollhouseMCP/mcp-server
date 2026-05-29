import { describe, expect, it } from '@jest/globals';

import {
  createHealthModule,
  type ConsoleRouteDefinition,
  type HealthReadinessChecks,
} from '../../../../src/web-console/index.js';

const NOW = new Date('2026-05-28T12:00:00.000Z');

const READY_INPUTS: HealthReadinessChecks = {
  sessionStorageAvailable: () => true,
  identityResolutionAvailable: () => true,
  securityInvalidationReady: () => true,
  runtimeControlAvailable: () => true,
  databaseAvailable: () => true,
  authServerAvailable: () => true,
  apiV1Mounted: () => true,
};

function findRoute(routes: readonly ConsoleRouteDefinition[], path: string): ConsoleRouteDefinition {
  const route = routes.find(candidate => candidate.path === path && candidate.method === 'GET');
  if (!route) throw new Error(`missing route GET ${path}`);
  return route;
}

describe('HealthModule', () => {
  it('declares public health and readiness descriptors', () => {
    const module = createHealthModule({
      readiness: READY_INPUTS,
      now: () => NOW,
    });

    expect(module).toMatchObject({
      id: 'health',
      apiVersion: 'v1',
      capabilities: [],
    });
    expect(module.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/health',
        audience: 'public',
        requiredCapability: 'none',
        ownership: 'none',
        elevation: 'none',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/health/ready',
        audience: 'public',
        requiredCapability: 'none',
        ownership: 'none',
        elevation: 'none',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
      }),
    ]));
  });

  it('returns a bounded public liveness body', async () => {
    const module = createHealthModule({
      readiness: READY_INPUTS,
      now: () => NOW,
    });

    const result = await findRoute(module.routes, '/api/v1/health').handler({} as never);

    expect(result).toEqual({
      status: 200,
      body: {
        status: 'ok',
        checked_at: NOW.toISOString(),
      },
    });
  });

  it('returns ready when every production gate input is satisfied', async () => {
    const module = createHealthModule({
      readiness: READY_INPUTS,
      now: () => NOW,
    });

    const result = await findRoute(module.routes, '/api/v1/health/ready').handler({} as never);

    expect(result).toEqual({
      status: 200,
      body: {
        status: 'ok',
        ready: true,
        checked_at: NOW.toISOString(),
      },
    });
  });

  it('fails readiness with generic public failure codes while production gates are missing', async () => {
    const module = createHealthModule({
      readiness: {
        ...READY_INPUTS,
        securityInvalidationReady: () => false,
        databaseAvailable: () => false,
        authServerAvailable: () => false,
        apiV1Mounted: () => false,
      },
      now: () => NOW,
    });

    const result = await findRoute(module.routes, '/api/v1/health/ready').handler({} as never);

    expect(result).toEqual({
      status: 503,
      body: {
        status: 'not_ready',
        ready: false,
        checked_at: NOW.toISOString(),
      },
    });
  });

  it('evaluates readiness checks for every request', async () => {
    let databaseAvailable = true;
    const module = createHealthModule({
      readiness: {
        ...READY_INPUTS,
        databaseAvailable: () => databaseAvailable,
      },
      now: () => NOW,
    });
    const readyRoute = findRoute(module.routes, '/api/v1/health/ready');

    await expect(readyRoute.handler({} as never)).resolves.toMatchObject({
      status: 200,
      body: { status: 'ok', ready: true },
    });

    databaseAvailable = false;

    await expect(readyRoute.handler({} as never)).resolves.toMatchObject({
      status: 503,
      body: { status: 'not_ready', ready: false },
    });
  });
});
