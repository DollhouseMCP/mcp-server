/**
 * Server-owned console discovery metadata.
 *
 * Route availability is deployment-specific: modules and write surfaces may be
 * absent behind feature flags. The manifest answers whether a route exists; it
 * does not replace actor-specific authorization, which remains server enforced.
 */

import { get } from './api.js';

const API_PREFIX = '/api/v1';

/** Fail-closed route predicate used until server metadata is injected. */
export function noConsoleRoute() {
  return false;
}

/**
 * Normalize manifest and caller paths to the same query-free /api/v1 form.
 * Feature modules may use `/me/foo`, `me/foo`, or the fully-qualified API path.
 */
export function canonicalConsolePath(path) {
  const withoutQuery = String(path || '').split(/[?#]/, 1)[0];
  if (!withoutQuery.startsWith('/')) return `${API_PREFIX}/${withoutQuery}`;
  return withoutQuery.startsWith(`${API_PREFIX}/`) || withoutQuery === API_PREFIX
    ? withoutQuery
    : `${API_PREFIX}${withoutQuery}`;
}

function routeKey(method, path) {
  return `${String(method || '').toUpperCase()} ${canonicalConsolePath(path)}`;
}

function isRoleCatalog(value) {
  return value && typeof value === 'object'
    && Array.isArray(value.roles)
    && Array.isArray(value.capabilities)
    && value.grants && typeof value.grants === 'object';
}

export async function loadConsoleMetadata() {
  const [manifestResponse, roleCatalogResponse] = await Promise.all([
    get('/me/manifest'),
    get('/me/role-catalog'),
  ]);

  const routes = manifestResponse.body?.routes;
  if (manifestResponse.status !== 200 || !Array.isArray(routes)) {
    throw new Error('Console route manifest is unavailable or invalid.');
  }
  if (roleCatalogResponse.status !== 200 || !isRoleCatalog(roleCatalogResponse.body)) {
    throw new Error('Console role catalog is unavailable or invalid.');
  }

  const routeKeys = new Set(routes.map(route => routeKey(route.method, route.path)));
  return Object.freeze({
    manifest: manifestResponse.body,
    roleCatalog: roleCatalogResponse.body,
    hasRoute: (method, path) => routeKeys.has(routeKey(method, path)),
    hasRoutes: requiredRoutes => requiredRoutes.every(([method, path]) => routeKeys.has(routeKey(method, path))),
  });
}
