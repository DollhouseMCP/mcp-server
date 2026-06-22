import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import type { IPortfolioElementStore } from '../../stores/IPortfolioElementStore.js';
import type { IUserIntegrationStore } from '../../stores/IUserIntegrationStore.js';
import type { IPortfolioSyncJobStore } from '../../stores/IPortfolioSyncJobStore.js';
import {
  projectPortfolioElementDelete,
  projectPortfolioElementDetail,
  projectPortfolioElementList,
  projectPortfolioElementRender,
  projectPortfolioElementValidation,
  projectPortfolioSyncJob,
  projectPortfolioSummary,
} from './PortfolioPrivacyProjectors.js';
import { PortfolioService } from './PortfolioService.js';

const SELF_CAPABILITY = 'console:self';

export interface PortfolioModuleOptions {
  readonly portfolioStore: IPortfolioElementStore;
  readonly integrationStore: IUserIntegrationStore;
  readonly syncJobStore: IPortfolioSyncJobStore;
  readonly enablePortfolioWriteRoutes?: boolean;
  readonly now?: () => Date;
}

export function createPortfolioModule(options: PortfolioModuleOptions): ConsoleModuleDescriptor {
  const service = new PortfolioService(options.portfolioStore, options.integrationStore, options.syncJobStore, options.now);
  const routes: ConsoleModuleDescriptor['routes'] = [
    ...(options.enablePortfolioWriteRoutes === true ? writeRoutes(service) : []),
    {
      method: 'GET',
      path: '/api/v1/me/portfolio/sync/:job_id',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      privacyProjector: projectPortfolioSyncJob,
      handler: req => withJobIdParam(req, jobId => service.getSyncJob(req, jobId)),
    },
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
      pathParamValueNormalization: { name: 'nfc' },
      handler: req => withElementParams(req, (type, name) => service.getElement(req, type, name)),
    },
  ];
  return {
    id: 'portfolio',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    events: [],
    routes,
  };
}

function writeRoutes(service: PortfolioService): ConsoleModuleDescriptor['routes'] {
  return [
    {
      method: 'POST',
      path: '/api/v1/me/portfolio/sync',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      privacyProjector: projectPortfolioSyncJob,
      handler: req => service.startSync(req),
    },
    {
      method: 'POST',
      path: '/api/v1/me/portfolio/elements/:type',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      privacyProjector: projectPortfolioElementDetail,
      handler: req => withTypeParam(req, type => service.createElement(req, type)),
    },
    {
      method: 'PATCH',
      path: '/api/v1/me/portfolio/elements/:type/:name',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      privacyProjector: projectPortfolioElementDetail,
      pathParamValueNormalization: { name: 'nfc' },
      handler: req => withElementParams(req, (type, name) => service.updateElement(req, type, name)),
    },
    {
      method: 'DELETE',
      path: '/api/v1/me/portfolio/elements/:type/:name',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      privacyProjector: projectPortfolioElementDelete,
      pathParamValueNormalization: { name: 'nfc' },
      handler: req => withElementParams(req, (type, name) => service.deleteElement(req, type, name)),
    },
    {
      method: 'POST',
      path: '/api/v1/me/portfolio/elements/:type/:name/validate',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      // The v1 checklist requires Idempotency-Key coverage for these side-effect-free POSTs.
      idempotency: 'required',
      privacyProjector: projectPortfolioElementValidation,
      pathParamValueNormalization: { name: 'nfc' },
      handler: req => withElementParams(req, (type, name) => service.validateElement(req, type, name)),
    },
    {
      method: 'POST',
      path: '/api/v1/me/portfolio/elements/:type/:name/render',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      // The v1 checklist requires Idempotency-Key coverage for these side-effect-free POSTs.
      idempotency: 'required',
      privacyProjector: projectPortfolioElementRender,
      pathParamValueNormalization: { name: 'nfc' },
      handler: req => withElementParams(req, (type, name) => service.renderElement(req, type, name)),
    },
  ];
}

function withJobIdParam(
  req: ConsoleRequest,
  action: (jobId: string) => Promise<ConsoleHandlerResult>,
): Promise<ConsoleHandlerResult> | ConsoleHandlerResult {
  const jobId = req.params.job_id;
  if (typeof jobId !== 'string' || jobId.trim() === '') {
    return {
      status: 400,
      body: {
        type: 'about:blank',
        title: 'Invalid request',
        status: 400,
        code: 'invalid_request',
        detail: 'job_id path parameter is required.',
      },
    };
  }
  return action(jobId);
}

function withTypeParam(
  req: ConsoleRequest,
  action: (type: string) => Promise<ConsoleHandlerResult>,
): Promise<ConsoleHandlerResult> | ConsoleHandlerResult {
  const type = req.params.type;
  if (typeof type !== 'string' || type.trim() === '') {
    return {
      status: 400,
      body: {
        type: 'about:blank',
        title: 'Invalid request',
        status: 400,
        code: 'invalid_request',
        detail: 'type path parameter is required.',
      },
    };
  }
  return action(type);
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
