import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRouteDefinition,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import { projectPortfolioElementDetail } from '../portfolio/PortfolioPrivacyProjectors.js';
import {
  projectCollectionElementDetail,
  projectCollectionElementList,
} from './CollectionPrivacyProjectors.js';
import { CollectionService, type CollectionServiceOptions } from './CollectionService.js';
import { CollectionInstallService, type CollectionInstallServiceOptions } from './CollectionInstallService.js';

const SELF_CAPABILITY = 'console:self';

export interface CollectionModuleOptions extends CollectionServiceOptions {
  /**
   * When present, registers the install route (POST
   * /api/v1/me/portfolio/from-collection). The registrar supplies this only
   * when BOTH the collection surface and portfolio write routes are enabled —
   * install is a portfolio mutation sourced from the public catalog.
   */
  readonly install?: CollectionInstallServiceOptions;
}

/**
 * Read-only browse/search/detail surface over the public DollhouseMCP
 * collection catalog. The catalog is global public data, but the routes stay
 * session-gated: every request can drive server-funded outbound GitHub
 * traffic, so anonymous access would hand that budget to the internet.
 * Registration is operator-gated by DOLLHOUSE_WEB_CONSOLE_COLLECTION_ENABLED
 * (wired in WebConsoleRegistrar); install lands in a later slice.
 */
export function createCollectionModule(options: CollectionModuleOptions): ConsoleModuleDescriptor {
  const service = new CollectionService({ ...options, installEnabled: options.install !== undefined });
  const routes: ConsoleRouteDefinition[] = [
    {
      method: 'GET',
      path: '/api/v1/collection/elements',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'public_catalog',
      idempotency: 'not_applicable',
      rateLimit: 'collection_fetch',
      privacyProjector: projectCollectionElementList,
      handler: req => service.listElements(req),
    },
    {
      method: 'GET',
      path: '/api/v1/collection/elements/:type/:name',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'public_catalog',
      idempotency: 'not_applicable',
      rateLimit: 'collection_fetch',
      privacyProjector: projectCollectionElementDetail,
      handler: req => withElementParams(req, (type, name) => service.getElement(req, type, name)),
    },
  ];

  if (options.install) {
    const installService = new CollectionInstallService(options.install);
    // Install writes into the user's portfolio, so it lives under the portfolio
    // path with a self_private response (not the public_catalog catalog space).
    // It still carries the collection_fetch limit because it drives an outbound
    // GitHub fetch, and idempotency so a retried install is not duplicated.
    routes.push({
      method: 'POST',
      path: '/api/v1/me/portfolio/from-collection',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      rateLimit: 'collection_fetch',
      privacyProjector: projectPortfolioElementDetail,
      handler: req => installService.install(req),
    });
  }

  return {
    id: 'collection',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    events: [],
    routes,
  };
}

function withElementParams(
  req: ConsoleRequest,
  next: (type: string, name: string) => Promise<ConsoleHandlerResult>,
): Promise<ConsoleHandlerResult> | ConsoleHandlerResult {
  const type = req.params.type;
  const name = req.params.name;
  if (typeof type !== 'string' || typeof name !== 'string') {
    return {
      status: 400,
      body: {
        type: 'about:blank',
        title: 'Invalid request',
        status: 400,
        code: 'invalid_request',
        detail: 'type and name path parameters are required.',
      },
    };
  }
  return next(type, name);
}
