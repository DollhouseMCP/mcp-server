import type { ConsoleModuleDescriptor } from '../../platform/ConsolePlatformTypes.js';
import type { IUserIntegrationStore } from '../../stores/IUserIntegrationStore.js';
import { IntegrationService } from './IntegrationService.js';
import {
  projectGitHubIntegrationStatus,
  projectIntegrationList,
} from './IntegrationPrivacyProjectors.js';

const SELF_CAPABILITY = 'console:self';

export interface IntegrationModuleOptions {
  readonly integrationStore: IUserIntegrationStore;
}

export function createIntegrationModule(options: IntegrationModuleOptions): ConsoleModuleDescriptor {
  const service = new IntegrationService(options.integrationStore);
  return {
    id: 'integrations',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    events: [
      { type: 'integration.connected.v1', schemaId: 'integration.connected.v1' },
      { type: 'integration.disconnected.v1', schemaId: 'integration.disconnected.v1' },
    ],
    routes: [
      {
        method: 'GET',
        path: '/api/v1/me/integrations',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectIntegrationList,
        handler: req => service.list(req),
      },
      {
        method: 'GET',
        path: '/api/v1/me/integrations/github',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectGitHubIntegrationStatus,
        handler: req => service.getGitHub(req),
      },
    ],
  };
}
