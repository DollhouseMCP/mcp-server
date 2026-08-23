import { describe, expect, it } from '@jest/globals';

import type { ConsoleRequest, ConsoleRouteManifest } from '../../../../src/web-console/platform/ConsolePlatformTypes.js';
import { CONSOLE_CAPABILITIES } from '../../../../src/web-console/platform/ConsolePlatformTypes.js';
import { ConsoleModuleRegistry } from '../../../../src/web-console/platform/ConsoleModuleRegistry.js';
import {
  createConsoleMetaModule,
  projectRoleCatalog,
  projectRouteManifest,
} from '../../../../src/web-console/modules/console-meta/ConsoleMetaModule.js';
import { CONSOLE_ADMIN_ROLES } from '../../../../src/web-console/stores/IConsoleAccountAdminStore.js';
import { ROLE_GRANT_CAPABILITIES } from '../../../../src/web-console/modules/account-admin/AccountAdminRoleAuthority.js';

const EMPTY_MANIFEST: ConsoleRouteManifest = { apiVersion: 'v1', routes: [] };
const FAKE_REQUEST = {} as ConsoleRequest;

function metaModule(getRouteManifest: () => ConsoleRouteManifest = () => EMPTY_MANIFEST) {
  return createConsoleMetaModule({ getRouteManifest });
}

describe('ConsoleMetaModule', () => {
  it('registers only self-audience manifest and role-catalog routes under /api/v1/me', () => {
    const registry = new ConsoleModuleRegistry();
    registry.register(metaModule());
    const routes = registry.createRouteManifest().routes;
    expect(routes.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /api/v1/me/manifest',
      'GET /api/v1/me/role-catalog',
    ]);
    expect(routes.every(route => route.audience === 'self' && route.requiredCapability === 'console:self')).toBe(true);
  });

  it('serves the route manifest lazily so it reflects modules registered later', async () => {
    let calls = 0;
    const route = metaModule(() => {
      calls += 1;
      return EMPTY_MANIFEST;
    }).routes.find(candidate => candidate.path === '/api/v1/me/manifest');
    expect(calls).toBe(0);
    const result = await route?.handler(FAKE_REQUEST);
    expect(result).toEqual({ status: 200, body: EMPTY_MANIFEST });
    expect(calls).toBe(1);
  });

  it('serves the role/capability catalog with the role→capability grant map', async () => {
    const route = metaModule().routes.find(candidate => candidate.path === '/api/v1/me/role-catalog');
    const result = await route?.handler(FAKE_REQUEST);
    expect(result?.body).toEqual({
      roles: [...CONSOLE_ADMIN_ROLES],
      capabilities: [...CONSOLE_CAPABILITIES],
      grants: ROLE_GRANT_CAPABILITIES,
    });
  });

  it('manifest projector strips producer-added fields from entries', () => {
    const projected = projectRouteManifest({
      apiVersion: 'v1',
      routes: [{
        moduleId: 'x',
        method: 'GET',
        path: '/api/v1/x',
        audience: 'self',
        requiredCapability: 'console:self',
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        leaked_secret: 'nope',
      }],
    });
    expect(projected.routes[0]).not.toHaveProperty('leaked_secret');
    expect(projected.routes[0]).toMatchObject({ moduleId: 'x', method: 'GET', path: '/api/v1/x' });
  });

  it('role-catalog projector re-derives from the server-owned constants, ignoring foreign input', () => {
    const catalog = projectRoleCatalog({ roles: ['forged'], capabilities: ['forged'], grants: { admin: ['forged'] } });
    expect(catalog.roles).toEqual([...CONSOLE_ADMIN_ROLES]);
    expect(catalog.capabilities).toEqual([...CONSOLE_CAPABILITIES]);
    expect(catalog.grants.admin).toEqual([...ROLE_GRANT_CAPABILITIES.admin]);
  });
});
