/**
 * Console bootstrap metadata: static, non-per-user data the SPA needs to
 * feature-detect and render RBAC affordances without hard-coding server truth.
 *
 * - `GET /api/v1/me/manifest` — the registered route/capability manifest, so the UI
 *   knows which routes exist (flag-gated modules are simply absent) instead of
 *   probing for 404s.
 * - `GET /api/v1/me/role-catalog` — the administrative role set, the capability set,
 *   and the role→capability grant map, so a permissions UI stops hard-coding them.
 *
 * Both are `self`-audience reads (any authenticated console user) carrying no per-user
 * data; capabilities still gate the actual operations the manifest advertises.
 */
import {
  CONSOLE_CAPABILITIES,
  type ConsoleCapability,
  type ConsoleModuleDescriptor,
  type ConsoleRouteManifest,
  type ConsoleRouteManifestEntry,
} from '../../platform/ConsolePlatformTypes.js';
import { CONSOLE_ADMIN_ROLES, type ConsoleAdminRole } from '../../stores/IConsoleAccountAdminStore.js';
import { ROLE_GRANT_CAPABILITIES } from '../account-admin/AccountAdminRoleAuthority.js';

const SELF_CAPABILITY = 'console:self';

export interface RoleCatalogDto {
  readonly roles: readonly ConsoleAdminRole[];
  readonly capabilities: readonly ConsoleCapability[];
  readonly grants: Readonly<Record<ConsoleAdminRole, readonly ConsoleCapability[]>>;
}

export interface ConsoleMetaModuleOptions {
  /** Resolved lazily at request time, after every module has registered. */
  readonly getRouteManifest: () => ConsoleRouteManifest;
}

export function createConsoleMetaModule(options: ConsoleMetaModuleOptions): ConsoleModuleDescriptor {
  return {
    id: 'consoleMeta',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    routes: [
      {
        method: 'GET',
        path: '/api/v1/me/manifest',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectRouteManifest,
        handler: () => Promise.resolve({ status: 200, body: options.getRouteManifest() }),
      },
      {
        method: 'GET',
        path: '/api/v1/me/role-catalog',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectRoleCatalog,
        handler: () => Promise.resolve({ status: 200, body: buildRoleCatalog() }),
      },
    ],
  };
}

function buildRoleCatalog(): RoleCatalogDto {
  return {
    roles: [...CONSOLE_ADMIN_ROLES],
    capabilities: [...CONSOLE_CAPABILITIES],
    grants: ROLE_GRANT_CAPABILITIES,
  };
}

export function projectRouteManifest(value: unknown): ConsoleRouteManifest {
  const manifest = value as ConsoleRouteManifest;
  return {
    apiVersion: 'v1',
    routes: (Array.isArray(manifest.routes) ? manifest.routes : []).map(projectManifestEntry),
  };
}

function projectManifestEntry(entry: ConsoleRouteManifestEntry): ConsoleRouteManifestEntry {
  return {
    moduleId: entry.moduleId,
    method: entry.method,
    path: entry.path,
    audience: entry.audience,
    requiredCapability: entry.requiredCapability,
    ownership: entry.ownership,
    elevation: entry.elevation,
    privacyClass: entry.privacyClass,
    idempotency: entry.idempotency,
    ...(entry.rateLimit ? { rateLimit: entry.rateLimit } : {}),
    ...(entry.auditOperation ? { auditOperation: entry.auditOperation } : {}),
    ...(entry.responseKind ? { responseKind: entry.responseKind } : {}),
  };
}

// The catalog is entirely server-owned static data, so the projector re-derives it
// from the constants rather than trusting the value it is handed.
export function projectRoleCatalog(_value: unknown): RoleCatalogDto {
  return buildRoleCatalog();
}
