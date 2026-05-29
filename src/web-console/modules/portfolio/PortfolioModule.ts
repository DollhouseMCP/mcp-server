import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import type { IPortfolioElementStore } from '../../stores/IPortfolioElementStore.js';
import {
  projectPortfolioElementDetail,
  projectPortfolioElementList,
  projectPortfolioSummary,
} from './PortfolioPrivacyProjectors.js';
import { PortfolioService } from './PortfolioService.js';

const SELF_CAPABILITY = 'console:self';

export interface PortfolioModuleOptions {
  readonly portfolioStore: IPortfolioElementStore;
}

export function createPortfolioModule(options: PortfolioModuleOptions): ConsoleModuleDescriptor {
  const service = new PortfolioService(options.portfolioStore);
  return {
    id: 'portfolio',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    events: [],
    routes: [
      {
        method: 'GET',
        path: '/api/v1/me/portfolio',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectPortfolioSummary,
        handler: req => service.getSummary(req),
      },
      {
        method: 'GET',
        path: '/api/v1/me/portfolio/elements',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectPortfolioElementList,
        handler: req => service.listElements(req),
      },
      {
        method: 'GET',
        path: '/api/v1/me/portfolio/elements/:type/:name',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectPortfolioElementDetail,
        handler: req => withElementParams(req, (type, name) => service.getElement(req, type, name)),
      },
    ],
  };
}

function withElementParams(
  req: ConsoleRequest,
  action: (type: string, name: string) => Promise<ConsoleHandlerResult>,
): Promise<ConsoleHandlerResult> | ConsoleHandlerResult {
  const type = req.params.type;
  const name = req.params.name;
  if (typeof type !== 'string' || type.trim() === '' ||
      typeof name !== 'string' || name.trim() === '') {
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
  return action(type, name);
}
