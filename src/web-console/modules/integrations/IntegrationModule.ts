import type { ConsoleModuleDescriptor } from '../../platform/ConsolePlatformTypes.js';
import type { IConsoleOpaqueValueService } from '../../security/ConsoleOpaqueValues.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type { ILoginTransactionStore } from '../../stores/ILoginTransactionStore.js';
import type { IUserIntegrationStore } from '../../stores/IUserIntegrationStore.js';
import type { IGitHubIntegrationProvider } from './GitHubIntegrationProvider.js';
import {
  createGitHubIntegrationProvider,
  createUnavailableGitHubIntegrationProvider,
} from './IntegrationProvider.js';
import { IntegrationProviderRegistry } from './IntegrationProviderRegistry.js';
import type { IIntegrationSecurityEventSink } from './IntegrationSecurityEvents.js';
import { IntegrationService } from './IntegrationService.js';
import { serializeGitHubIntegrationStatus } from './IntegrationDtos.js';
import {
  projectGitHubIntegrationStatus,
  projectIntegrationConnect,
  projectIntegrationList,
} from './IntegrationPrivacyProjectors.js';

const SELF_CAPABILITY = 'console:self';

export interface IntegrationModuleOptions {
  readonly integrationStore: IUserIntegrationStore;
  readonly loginTransactions?: ILoginTransactionStore | null;
  readonly opaqueValues?: IConsoleOpaqueValueService | null;
  readonly secretEncryption?: ISecretEncryptionService | null;
  readonly githubProvider?: IGitHubIntegrationProvider | null;
  readonly publicBaseUrl?: string | null;
  readonly securityEventSink?: IIntegrationSecurityEventSink | null;
  readonly now?: () => Date;
}

export function createIntegrationModule(options: IntegrationModuleOptions): ConsoleModuleDescriptor {
  const providers = new IntegrationProviderRegistry([
    options.githubProvider
      ? createGitHubIntegrationProvider(options.githubProvider, serializeGitHubIntegrationStatus)
      : createUnavailableGitHubIntegrationProvider(serializeGitHubIntegrationStatus),
  ]);
  const service = new IntegrationService({
    store: options.integrationStore,
    providers,
    loginTransactions: options.loginTransactions,
    opaqueValues: options.opaqueValues,
    secretEncryption: options.secretEncryption,
    publicBaseUrl: options.publicBaseUrl,
    securityEventSink: options.securityEventSink,
    now: options.now,
  });
  return {
    id: 'integrations',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    events: [
      { type: 'integration.connected.v1', schemaId: 'integration.connected.v1' },
      { type: 'integration.disconnected.v1', schemaId: 'integration.disconnected.v1' },
      {
        type: 'console.auth.integration_callback_rejected.v1',
        schemaId: 'console.auth.integration_callback_rejected.v1',
      },
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
      {
        method: 'POST',
        path: '/api/v1/me/integrations/github/connect',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        // GitHub's authorization UI is the consent gate for requested
        // repository permissions; add local step-up here if product policy
        // later requires console-side reauthentication before provider consent.
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'required',
        privacyProjector: projectIntegrationConnect,
        handler: req => service.connectGitHub(req),
      },
      {
        method: 'GET',
        path: '/api/v1/me/integrations/github/callback',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'flow_transaction',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        handler: req => service.completeGitHubCallback(req),
      },
      {
        method: 'DELETE',
        path: '/api/v1/me/integrations/github',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        // Disconnect is scoped to the authenticated user's provider grant and
        // remains ordinary self-service unless policy later requires step-up.
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'required',
        privacyProjector: projectGitHubIntegrationStatus,
        handler: req => service.disconnectGitHub(req),
      },
    ],
  };
}
