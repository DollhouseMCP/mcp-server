import { describe, expect, it } from '@jest/globals';
import {
  ConsoleModuleRegistry,
  ConsoleModuleRegistrationError,
  type ConsoleModuleDescriptor,
  type ConsoleRouteDefinition,
} from '../../../../src/web-console/index.js';

const ADMIN_AUDIT_OPERATION = 'operations.health.read';
const PROFILE_UPDATED_EVENT = 'profile.updated.v1';

function selfRoute(overrides: Partial<ConsoleRouteDefinition> = {}): ConsoleRouteDefinition {
  return {
    method: 'GET',
    path: '/api/v1/me/example',
    audience: 'self',
    requiredCapability: 'console:self',
    ownership: 'authenticated_user',
    elevation: 'none',
    privacyClass: 'self_private',
    idempotency: 'not_applicable',
    handler: () => ({ status: 200, body: { ok: true } }),
    ...overrides,
  };
}

function selfModule(overrides: Partial<ConsoleModuleDescriptor> = {}): ConsoleModuleDescriptor {
  return {
    id: 'example',
    apiVersion: 'v1',
    capabilities: ['console:self'],
    routes: [selfRoute()],
    ...overrides,
  };
}

function adminModule(routeOverrides: Partial<ConsoleRouteDefinition> = {}): ConsoleModuleDescriptor {
  return {
    id: 'operations',
    apiVersion: 'v1',
    capabilities: ['console:admin:operate'],
    auditOperations: [{ id: ADMIN_AUDIT_OPERATION }],
    routes: [{
      method: 'GET',
      path: '/api/v1/admin/operate/health',
      audience: 'admin',
      requiredCapability: 'console:admin:operate',
      elevation: 'admin_30m',
      privacyClass: 'operational_allowlist',
      idempotency: 'not_applicable',
      auditOperation: ADMIN_AUDIT_OPERATION,
      privacyProjector: value => value,
      handler: () => ({ status: 200, body: { status: 'ok' } }),
      ...routeOverrides,
    }],
  };
}

describe('ConsoleModuleRegistry', () => {
  it('registers a valid self-service fixture and produces its manifest', () => {
    const registry = new ConsoleModuleRegistry();

    registry.register(selfModule());

    expect(registry.createRouteManifest()).toEqual({
      apiVersion: 'v1',
      routes: [{
        moduleId: 'example',
        method: 'GET',
        path: '/api/v1/me/example',
        audience: 'self',
        requiredCapability: 'console:self',
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
      }],
    });
  });

  it('registers an admin descriptor only with its platform declarations', () => {
    const registry = new ConsoleModuleRegistry();

    registry.register(adminModule());

    expect(registry.createRouteManifest().routes[0]).toEqual(expect.objectContaining({
      moduleId: 'operations',
      requiredCapability: 'console:admin:operate',
      elevation: 'admin_30m',
      privacyClass: 'operational_allowlist',
      auditOperation: ADMIN_AUDIT_OPERATION,
    }));
  });

  it.each([
    ['an unsupported API version', selfModule({
      apiVersion: 'v2' as never,
    }), /unsupported API version/],
    ['an invalid module identifier', selfModule({
      id: 'Invalid module id',
    }), /invalid identifier/],
    ['an unknown capability', selfModule({
      capabilities: ['console:made-up' as never],
      routes: [selfRoute({ requiredCapability: 'console:made-up' as never })],
    }), /unknown capability/],
    ['an undeclared route capability', selfModule({
      capabilities: [],
    }), /uses undeclared capability/],
    ['an invalid HTTP method', selfModule({
      routes: [selfRoute({ method: 'OPTIONS' as never })],
    }), /invalid method/],
    ['a path outside the API namespace', selfModule({
      routes: [selfRoute({ path: '/api/v2/me/example' })],
    }), /must be under \/api\/v1/],
    ['a missing privacy class', selfModule({
      routes: [selfRoute({ privacyClass: undefined })],
    }), /missing a valid privacy class/],
    ['a missing elevation policy', adminModule({ elevation: undefined }), /missing a valid elevation policy/],
    ['an invalid ownership policy', selfModule({
      routes: [selfRoute({ ownership: 'other_user' as never })],
    }), /invalid ownership policy/],
    ['an admin route without audit', adminModule({ auditOperation: undefined }), /missing a declared audit operation/],
    ['an admin route without privacy projection', adminModule({ privacyProjector: undefined }), /missing a privacy projector/],
    ['an admin route without elevation', adminModule({ elevation: 'none' }), /requires administrative elevation/],
    ['an admin route with a self audience', adminModule({ audience: 'self' }), /inconsistent admin policy/],
    ['a mutating route without idempotency decision', selfModule({
      routes: [selfRoute({ method: 'POST', idempotency: undefined })],
    }), /missing an idempotency decision/],
    ['an invalid idempotency decision', selfModule({
      routes: [selfRoute({ idempotency: 'sometimes' as never })],
    }), /invalid idempotency decision/],
    ['a private self-service route without ownership', selfModule({
      routes: [selfRoute({ ownership: undefined })],
    }), /missing an ownership policy/],
    ['a self-service route with administrative elevation', selfModule({
      routes: [selfRoute({ elevation: 'admin_30m' })],
    }), /cannot require admin elevation/],
    ['a self-service route with administrative privacy', selfModule({
      routes: [selfRoute({ privacyClass: 'account_metadata' })],
    }), /invalid privacy class/],
    ['a self-service route outside me or auth', selfModule({
      routes: [selfRoute({ path: '/api/v1/profile' })],
    }), /inconsistent self-service policy/],
  ])('rejects %s', (_label, descriptor, expected) => {
    const registry = new ConsoleModuleRegistry();

    expect(() => registry.register(descriptor)).toThrow(expected);
  });

  it('rejects duplicate module IDs', () => {
    const registry = new ConsoleModuleRegistry();
    registry.register(selfModule());

    expect(() => registry.register(selfModule())).toThrow(ConsoleModuleRegistrationError);
    expect(() => registry.register(selfModule())).toThrow(/Duplicate console module id/);
  });

  it('rejects route collisions across modules', () => {
    const registry = new ConsoleModuleRegistry();
    registry.register(selfModule());

    expect(() => registry.register(selfModule({
      id: 'otherExample',
    }))).toThrow(/collides between modules/);
  });

  it('rejects duplicated declarations inside one module', () => {
    const registry = new ConsoleModuleRegistry();

    expect(() => registry.register(selfModule({
      routes: [selfRoute(), selfRoute()],
    }))).toThrow(/duplicates route/);

    expect(() => registry.register({
      ...adminModule(),
      auditOperations: [{ id: ADMIN_AUDIT_OPERATION }, { id: ADMIN_AUDIT_OPERATION }],
    })).toThrow(/duplicates audit operation/);

    expect(() => registry.register(selfModule({
      events: [
        { type: PROFILE_UPDATED_EVENT, schemaId: PROFILE_UPDATED_EVENT },
        { type: PROFILE_UPDATED_EVENT, schemaId: 'profile.updated.other.v1' },
      ],
    }))).toThrow(/duplicates event/);

    expect(() => registry.register(selfModule({
      schemas: [{ id: 'profile.v1' }, { id: 'profile.v1' }],
    }))).toThrow(/duplicates schema/);

    expect(() => registry.register(selfModule({
      events: [{ type: PROFILE_UPDATED_EVENT, schemaId: 'profile.v1' }],
      schemas: [{ id: 'profile.v1' }],
    }))).toThrow(/duplicates schema/);
  });

  it('rejects event and schema identifier collisions across modules', () => {
    const registry = new ConsoleModuleRegistry();
    registry.register(selfModule({
      events: [{ type: PROFILE_UPDATED_EVENT, schemaId: PROFILE_UPDATED_EVENT }],
    }));

    expect(() => registry.register(selfModule({
      id: 'otherExample',
      routes: [selfRoute({ path: '/api/v1/me/other-example' })],
      events: [{ type: PROFILE_UPDATED_EVENT, schemaId: 'other.schema.v1' }],
    }))).toThrow(/Event "profile.updated.v1" collides/);

    expect(() => registry.register(selfModule({
      id: 'thirdExample',
      routes: [selfRoute({ path: '/api/v1/me/third-example' })],
      schemas: [{ id: PROFILE_UPDATED_EVENT }],
    }))).toThrow(/Schema "profile.updated.v1" collides/);
  });

  it('rejects a schema used by a subsequently registered event', () => {
    const registry = new ConsoleModuleRegistry();
    registry.register(selfModule({
      schemas: [{ id: 'profile.projection.v1' }],
    }));

    expect(() => registry.register(selfModule({
      id: 'otherExample',
      routes: [selfRoute({ path: '/api/v1/me/other-example' })],
      events: [{ type: 'profile.projected.v1', schemaId: 'profile.projection.v1' }],
    }))).toThrow(/Schema "profile.projection.v1" collides/);
  });

  it('stores immutable descriptor snapshots after registration', () => {
    const registry = new ConsoleModuleRegistry();
    const descriptor = selfModule();
    registry.register(descriptor);

    (descriptor.routes[0] as unknown as { path: string }).path = '/api/v1/me/mutated';

    expect(registry.createRouteManifest().routes[0]?.path).toBe('/api/v1/me/example');
    expect(Object.isFrozen(registry.getModules()[0])).toBe(true);
    expect(Object.isFrozen(registry.getModules()[0]?.routes)).toBe(true);
    expect(Object.isFrozen(registry.getModules()[0]?.routes[0])).toBe(true);
  });
});
