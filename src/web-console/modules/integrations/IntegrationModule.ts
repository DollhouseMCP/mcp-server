import type { ConsoleModuleDescriptor, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import type { IConsoleOpaqueValueService } from '../../security/ConsoleOpaqueValues.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type { IIntegrationDescriptorStore } from '../../stores/IIntegrationDescriptorStore.js';
import type { IIntegrationOpenApiSpecStore } from '../../stores/IIntegrationOpenApiSpecStore.js';
import type { ILoginTransactionStore } from '../../stores/ILoginTransactionStore.js';
import type { IUserIntegrationStore, UserIntegrationProvider } from '../../stores/IUserIntegrationStore.js';
import type { IGitHubIntegrationProvider } from './GitHubIntegrationProvider.js';
import {
  createStoreIntegrationProviderResolver,
  createStoreIntegrationCleanupProviderResolver,
  type CuratedProviderOutboundOptions,
  type IntegrationProviderResolver,
} from './CuratedIntegrationProviders.js';
import {
  createGitHubIntegrationProvider,
  createUnavailableGitHubIntegrationProvider,
  type IIntegrationProvider,
} from './IntegrationProvider.js';
import { IntegrationProviderRegistry } from './IntegrationProviderRegistry.js';
import type { IIntegrationSecurityEventSink } from './IntegrationSecurityEvents.js';
import { IntegrationDescriptorAuthoringService } from './IntegrationDescriptorAuthoringService.js';
import { IntegrationService } from './IntegrationService.js';
import { serializeGitHubIntegrationStatus } from './IntegrationDtos.js';
import {
  projectGitHubIntegrationStatus,
  projectConfiguredIntegrationStatus,
  projectIntegrationConnect,
  projectIntegrationConnectOrStatus,
  projectIntegrationDescriptor,
  projectIntegrationDescriptorList,
  projectIntegrationList,
  projectIntegrationOpenApiSpecMetadata,
  projectIntegrationSpecOperations,
} from './IntegrationPrivacyProjectors.js';
import { attachSharedInMemoryTransactionGate } from '../../../utils/InMemoryTransactionGate.js';

const SELF_CAPABILITY = 'console:self';

export interface IntegrationModuleOptions {
  readonly integrationStore: IUserIntegrationStore;
  readonly descriptorStore?: IIntegrationDescriptorStore | null;
  readonly openApiSpecStore?: IIntegrationOpenApiSpecStore | null;
  readonly loginTransactions?: ILoginTransactionStore | null;
  readonly opaqueValues?: IConsoleOpaqueValueService | null;
  readonly secretEncryption?: ISecretEncryptionService | null;
  readonly githubProvider?: IGitHubIntegrationProvider | null;
  readonly configuredProviders?: readonly IIntegrationProvider[];
  /** Outbound-transport seams threaded into per-request-built providers. */
  readonly providerOutbound?: CuratedProviderOutboundOptions;
  readonly publicBaseUrl?: string | null;
  readonly securityEventSink?: IIntegrationSecurityEventSink | null;
  readonly now?: () => Date;
}

export function createIntegrationModule(options: IntegrationModuleOptions): ConsoleModuleDescriptor {
  const providers = new IntegrationProviderRegistry([
    options.githubProvider
      ? createGitHubIntegrationProvider(options.githubProvider, serializeGitHubIntegrationStatus)
      : createUnavailableGitHubIntegrationProvider(serializeGitHubIntegrationStatus),
    ...(options.configuredProviders ?? []),
  ]);
  configureInMemoryDescriptorFences(options);
  const resolveProvider: IntegrationProviderResolver | null =
    options.descriptorStore && options.secretEncryption
      ? createStoreIntegrationProviderResolver({
        descriptorStore: options.descriptorStore,
        secretEncryption: options.secretEncryption,
        outbound: options.providerOutbound,
      })
      : null;
  const resolveCleanupProvider = options.descriptorStore && options.secretEncryption
    ? createStoreIntegrationCleanupProviderResolver({
        descriptorStore: options.descriptorStore,
        secretEncryption: options.secretEncryption,
        outbound: options.providerOutbound,
      })
    : null;
  const service = new IntegrationService({
    store: options.integrationStore,
    providers,
    resolveProvider,
    resolveCleanupProvider,
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
      ...byoDescriptorRoutes(options, new Set(providers.listDescriptors().map(entry => entry.id))),
      ...configuredProviderRoutes(options.configuredProviders ?? [], service),
      // Parameterized routes MUST register last: every literal route above
      // (github, descriptors, boot-time curated providers) wins the match
      // first, so these only serve providers resolved per-request.
      ...perRequestProviderRoutes(options, service, resolveProvider !== null),
    ],
  };
}

function configureInMemoryDescriptorFences(options: IntegrationModuleOptions): void {
  attachSharedInMemoryTransactionGate([
    options.integrationStore,
    options.descriptorStore,
    options.loginTransactions,
  ]);
  const fencePendingCallbacks = options.loginTransactions
    ?.fenceIntegrationAuthorizationsByDescriptor;
  const configureCredentialMutationFence = options.descriptorStore
    ?.configureCredentialMutationFence;
  if (configureCredentialMutationFence) {
    if (options.loginTransactions && !fencePendingCallbacks) {
      throw new Error('login transaction store must support descriptor callback fencing');
    }
    configureCredentialMutationFence.call(options.descriptorStore, {
      hasCredentialMaterial: integrationDescriptorId =>
        options.integrationStore.hasCredentialMaterialByDescriptor(integrationDescriptorId),
      hasExecutableCredentialMaterial: integrationDescriptorId =>
        options.integrationStore.hasExecutableCredentialMaterialByDescriptor(integrationDescriptorId),
      revokeCredentiallessBindings: async (integrationDescriptorId, revokedAt) => {
        await options.integrationStore.revokeAllByDescriptor(integrationDescriptorId, revokedAt);
      },
      ...(fencePendingCallbacks ? {
        fencePendingCallbacks: (integrationDescriptorId: string) =>
          fencePendingCallbacks.call(options.loginTransactions, integrationDescriptorId),
      } : {}),
    });
  }
  const configure = options.integrationStore.configureDescriptorCallbackFence;
  if (configure && options.descriptorStore?.runIfCurrent) {
    configure.call(options.integrationStore, {
      runIfCurrent: options.descriptorStore.runIfCurrent.bind(options.descriptorStore),
    });
  } else if (configure) {
    const configuredFingerprints = new Map(
      (options.configuredProviders ?? []).flatMap(provider => {
        const id = provider.integrationDescriptorId;
        const fingerprint = provider.integrationDescriptorFingerprint;
        return id && fingerprint ? [[id, fingerprint] as const] : [];
      }),
    );
    configure.call(options.integrationStore, {
      async runIfCurrent(descriptorId, descriptorFingerprint, operation) {
        return configuredFingerprints.get(descriptorId) === descriptorFingerprint
          ? operation()
          : null;
      },
    });
  }
  const freshness = options.loginTransactions?.hasNewerIntegrationAuthorization;
  const completionCurrent = options.loginTransactions?.isIntegrationAuthorizationCompletionCurrent;
  if (freshness && completionCurrent && options.integrationStore.configureAuthorizationFreshnessFence) {
    options.integrationStore.configureAuthorizationFreshnessFence({
      hasNewerAuthorization: freshness.bind(options.loginTransactions),
      isCompletionCurrent: completionCurrent.bind(options.loginTransactions),
    });
  }
}

/**
 * Segments under /api/v1/me/integrations/ that are fixed routes, never
 * provider ids. The descriptor store also reserves `descriptors`; this guard
 * is belt-and-braces for the parameterized fallback routes.
 */
const RESERVED_PROVIDER_SEGMENTS = new Set(['github', 'descriptors']);
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

/**
 * Always-on parameterized connect/status/callback/disconnect routes serving
 * providers the boot-time registry does not know — above all BYO descriptors
 * authored at runtime, resolved from the store per-request (issue #2321).
 */
function perRequestProviderRoutes(
  options: IntegrationModuleOptions,
  service: IntegrationService,
  enabled: boolean,
): ConsoleModuleDescriptor['routes'] {
  if (!enabled) return [];
  const basePath = '/api/v1/me/integrations/:provider';
  const withProvider = (
    handle: (
      req: Parameters<ConsoleRouteDefinition['handler']>[0],
      providerId: UserIntegrationProvider,
    ) => ReturnType<ConsoleRouteDefinition['handler']>,
  ): ConsoleRouteDefinition['handler'] => req => {
    const raw = req.params.provider;
    const providerId = (typeof raw === 'string' ? raw : '') as UserIntegrationProvider;
    if (!PROVIDER_ID_PATTERN.test(providerId) || RESERVED_PROVIDER_SEGMENTS.has(providerId)) {
      return {
        status: 404,
        body: {
          type: 'about:blank',
          title: 'Not found',
          status: 404,
          code: 'integration_provider_not_found',
          detail: `Integration provider '${providerId}' is not registered.`,
        },
      };
    }
    return handle(req, providerId);
  };
  return [
    {
      method: 'GET',
      path: basePath,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      privacyProjector: projectConfiguredIntegrationStatus,
      handler: withProvider((req, providerId) => service.getProvider(req, providerId)),
    },
    {
      method: 'POST',
      path: `${basePath}/connect`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      // The strategy is unknown until the descriptor resolves, so the
      // projector accepts both connect shapes (OAuth authorize_url vs
      // static-key status).
      privacyProjector: projectIntegrationConnectOrStatus,
      handler: withProvider((req, providerId) => service.connectProvider(req, providerId)),
    },
    {
      method: 'GET',
      path: `${basePath}/callback`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'flow_transaction',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      handler: withProvider((req, providerId) => service.completeProviderCallback(req, providerId)),
    },
    {
      method: 'DELETE',
      path: basePath,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      privacyProjector: projectConfiguredIntegrationStatus,
      handler: withProvider((req, providerId) => service.disconnectProvider(req, providerId)),
    },
  ];
}

/**
 * Self-service BYO descriptor authoring (issue #2321). The literal
 * `descriptors` segment cannot collide with a provider route: the store
 * reserves that provider id, and configured-provider routes are generated
 * from validated descriptors only.
 */
function byoDescriptorRoutes(
  options: IntegrationModuleOptions,
  reservedProviderIds: ReadonlySet<string>,
): ConsoleModuleDescriptor['routes'] {
  if (!options.descriptorStore || !options.openApiSpecStore) return [];
  const authoring = new IntegrationDescriptorAuthoringService({
    descriptorStore: options.descriptorStore,
    specStore: options.openApiSpecStore,
    integrationStore: options.integrationStore,
    secretEncryption: options.secretEncryption,
    reservedProviderIds,
    now: options.now,
  });
  const basePath = '/api/v1/me/integrations/descriptors';
  return [
    {
      method: 'GET',
      path: basePath,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      privacyProjector: projectIntegrationDescriptorList,
      handler: req => authoring.list(req),
    },
    {
      method: 'POST',
      path: basePath,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      privacyProjector: projectIntegrationDescriptor,
      handler: req => authoring.create(req),
    },
    {
      method: 'GET',
      path: `${basePath}/:id`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      privacyProjector: projectIntegrationDescriptor,
      handler: req => authoring.get(req),
    },
    {
      method: 'PATCH',
      path: `${basePath}/:id`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      privacyProjector: projectIntegrationDescriptor,
      handler: req => authoring.update(req),
    },
    {
      method: 'DELETE',
      path: `${basePath}/:id`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      handler: req => authoring.remove(req),
    },
    {
      method: 'PUT',
      path: `${basePath}/:id/spec`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      privacyProjector: projectIntegrationOpenApiSpecMetadata,
      handler: req => authoring.putSpec(req),
    },
    {
      method: 'GET',
      path: `${basePath}/:id/spec`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      privacyProjector: projectIntegrationOpenApiSpecMetadata,
      handler: req => authoring.getSpec(req),
    },
    {
      method: 'GET',
      path: `${basePath}/:id/spec/operations`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      privacyProjector: projectIntegrationSpecOperations,
      handler: req => authoring.listSpecOperations(req),
    },
  ];
}

function configuredProviderRoutes(
  providers: readonly IIntegrationProvider[],
  service: IntegrationService,
): ConsoleModuleDescriptor['routes'] {
  return providers.flatMap(provider => {
    const basePath = `/api/v1/me/integrations/${provider.descriptor.id}`;
    const routes: ConsoleRouteDefinition[] = [
      {
        method: 'GET',
        path: basePath,
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectConfiguredIntegrationStatus,
        handler: req => service.getProvider(req, provider.descriptor.id),
      },
      {
        method: 'POST',
        path: `${basePath}/connect`,
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'required',
        privacyProjector: provider.credentialStrategy === 'static_api_key'
          ? projectConfiguredIntegrationStatus
          : projectIntegrationConnect,
        handler: req => service.connectProvider(req, provider.descriptor.id),
      },
      {
        method: 'DELETE',
        path: basePath,
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'required',
        privacyProjector: projectConfiguredIntegrationStatus,
        handler: req => service.disconnectProvider(req, provider.descriptor.id),
      },
    ];
    if (provider.credentialStrategy === 'oauth2_authorization_code') {
      routes.push({
        method: 'GET',
        path: `${basePath}/callback`,
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'flow_transaction',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        handler: req => service.completeProviderCallback(req, provider.descriptor.id),
      });
    }
    return routes;
  });
}
