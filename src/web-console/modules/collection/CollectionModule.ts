import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import {
  projectCollectionElementDetail,
  projectCollectionElementList,
} from './CollectionPrivacyProjectors.js';
import { CollectionService, type CollectionServiceOptions } from './CollectionService.js';

const SELF_CAPABILITY = 'console:self';

export type CollectionModuleOptions = CollectionServiceOptions;

/**
 * Read-only browse/search/detail surface over the public DollhouseMCP
 * collection catalog. The catalog is global public data, but the routes stay
 * session-gated: every request can drive server-funded outbound GitHub
 * traffic, so anonymous access would hand that budget to the internet.
 * Registration is operator-gated by DOLLHOUSE_WEB_CONSOLE_COLLECTION_ENABLED
 * (wired in WebConsoleRegistrar); install lands in a later slice.
 */
export function createCollectionModule(options: CollectionModuleOptions): ConsoleModuleDescriptor {
  const service = new CollectionService(options);
  return {
    id: 'collection',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    events: [],
    routes: [
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
    ],
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
