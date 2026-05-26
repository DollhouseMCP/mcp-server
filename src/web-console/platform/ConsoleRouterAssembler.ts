import { Router } from 'express';
import type { RequestHandler } from 'express';
import { createConsoleRequestContextMiddleware } from './ConsoleRequestContext.js';
import type { ConsoleHttpMethod, ConsoleRouteDefinition } from './ConsolePlatformTypes.js';
import type { ConsoleModuleRegistry } from './ConsoleModuleRegistry.js';

function registerRoute(router: Router, route: ConsoleRouteDefinition): void {
  const handler = route.handler as RequestHandler;
  const method: ConsoleHttpMethod = route.method;

  switch (method) {
    case 'GET':
      router.get(route.path, handler);
      return;
    case 'POST':
      router.post(route.path, handler);
      return;
    case 'PUT':
      router.put(route.path, handler);
      return;
    case 'PATCH':
      router.patch(route.path, handler);
      return;
    case 'DELETE':
      router.delete(route.path, handler);
      return;
  }
}

/**
 * Creates the unmounted v1 API router. Authentication and policy middleware
 * will be inserted here once the BFF/session services exist.
 */
export function assembleConsoleRouter(registry: ConsoleModuleRegistry): Router {
  const router = Router();
  router.use(createConsoleRequestContextMiddleware());

  for (const module of registry.getModules()) {
    for (const route of module.routes) {
      registerRoute(router, route);
    }
  }
  return router;
}
