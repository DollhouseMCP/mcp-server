/**
 * CuratedIntegrationProviders
 *
 * Composition glue for curated (data-driven) integrations: loads curated
 * descriptor seed files into the descriptor store, then builds the
 * connect/callback `IIntegrationProvider` instances from the loaded records so
 * they can be handed to `createIntegrationModule` as `configuredProviders`.
 *
 * Provider definitions are DATA (seed files) + deployment credentials (env);
 * there is no per-provider code here — one OAuth interpreter and one
 * static-API-key interpreter cover every curated descriptor.
 *
 * @module web-console/modules/integrations/CuratedIntegrationProviders
 */

import { SecurityMonitor } from '../../../security/securityMonitor.js';
import { logger } from '../../../utils/logger.js';
import type { IConsoleOpaqueValueService } from '../../security/ConsoleOpaqueValues.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type {
  IIntegrationDescriptorStore,
  IntegrationDescriptorRecord,
} from '../../stores/IIntegrationDescriptorStore.js';
import type {
  IUserIntegrationStore,
  UserIntegrationProvider,
} from '../../stores/IUserIntegrationStore.js';
import { ConfiguredOAuthIntegrationProvider } from './ConfiguredOAuthIntegrationProvider.js';
import type { DnsLookup } from './IntegrationPublicHostGuard.js';
import type { PinnedOutboundFactory } from './PinnedOutboundFactory.js';
import {
  IntegrationDescriptorSeedLoader,
  type IntegrationDescriptorSeedCredentialResolver,
} from './IntegrationDescriptorSeedLoader.js';
import type { IIntegrationProvider } from './IntegrationProvider.js';
import { integrationDescriptorClientSecretContext } from './IntegrationSecretContext.js';
import { safeIntegrationAuditProvider } from './IntegrationSecurityAudit.js';
import { StaticApiKeyIntegrationProvider } from './StaticApiKeyIntegrationProvider.js';

const ENV_PREFIX = 'DOLLHOUSE_INTEGRATION_';

/**
 * Resolve a curated provider's deployment OAuth credentials from process.env by
 * convention: `DOLLHOUSE_INTEGRATION_<ID>_CLIENT_ID` / `_CLIENT_SECRET`, where
 * `<ID>` is the provider id upper-cased with non-alphanumerics collapsed to `_`.
 */
export function createEnvIntegrationDescriptorCredentialResolver(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationDescriptorSeedCredentialResolver {
  return providerId => {
    const key = providerId.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_');
    return {
      clientId: env[`${ENV_PREFIX}${key}_CLIENT_ID`] ?? null,
      clientSecret: env[`${ENV_PREFIX}${key}_CLIENT_SECRET`] ?? null,
    };
  };
}

/**
 * Build connect/callback providers from curated descriptor records, decrypting
 * each OAuth client secret under the descriptor's client-secret context. A
 * descriptor that cannot produce a provider (no interpreter, or a build error)
 * is skipped without aborting the rest.
 */
/**
 * Outbound-transport seams threaded into each built provider so curated OAuth
 * token-endpoint calls share the gateway's resolve-once-and-pin SSRF guard.
 * Absent fields fall back to the production pinned transport / DNS resolver.
 */
export interface CuratedProviderOutboundOptions {
  readonly pinnedOutbound?: PinnedOutboundFactory;
  readonly dnsLookup?: DnsLookup;
}

export function buildConfiguredIntegrationProviders(
  descriptors: readonly IntegrationDescriptorRecord[],
  secretEncryption: ISecretEncryptionService,
  outbound: CuratedProviderOutboundOptions = {},
): IIntegrationProvider[] {
  const providers: IIntegrationProvider[] = [];
  for (const descriptor of descriptors) {
    try {
      const provider = buildIntegrationProviderFromDescriptor(descriptor, secretEncryption, outbound);
      if (provider) {
        providers.push(provider);
        auditProviderBuild(descriptor.provider, 'configured');
      } else {
        auditProviderBuild(descriptor.provider, 'unsupported');
      }
    } catch (err) {
      auditProviderBuild(descriptor.provider, 'failed');
      logger.error(
        `[CuratedIntegrationProviders] Skipping descriptor '${descriptor.provider}' — provider build failed`,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }
  return providers;
}

/**
 * Per-request provider resolution for descriptors that are not in the
 * boot-time registry — runtime-authored BYO descriptors above all. Resolves
 * the caller-visible descriptor from the store and interprets it on the
 * spot, so a just-authored descriptor is connectable without a restart.
 * Chosen over registry-refresh-on-write, which would reintroduce shared
 * mutable cross-session state and race in multi-replica deployments.
 */
export type IntegrationProviderResolver = (
  userId: string,
  providerId: UserIntegrationProvider,
) => Promise<IIntegrationProvider | null>;

export type IntegrationCleanupProviderResolver = (
  userId: string,
  providerId: UserIntegrationProvider,
  integrationDescriptorId: string,
) => Promise<IIntegrationProvider | null>;

export function createStoreIntegrationProviderResolver(params: {
  readonly descriptorStore: IIntegrationDescriptorStore;
  readonly secretEncryption: ISecretEncryptionService;
  readonly outbound?: CuratedProviderOutboundOptions;
}): IntegrationProviderResolver {
  return async (userId, providerId) => {
    const descriptor = await params.descriptorStore.findVisibleByProvider(userId, providerId);
    if (!descriptor) return null;
    try {
      const provider = buildIntegrationProviderFromDescriptor(
        descriptor,
        params.secretEncryption,
        params.outbound ?? {},
      );
      auditProviderBuild(descriptor.provider, provider ? 'configured' : 'unsupported');
      return provider;
    } catch (err) {
      auditProviderBuild(descriptor.provider, 'failed');
      logger.error(
        `[CuratedIntegrationProviders] Per-request provider build failed for '${descriptor.provider}'`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      return null;
    }
  };
}

export function createStoreIntegrationCleanupProviderResolver(params: {
  readonly descriptorStore: IIntegrationDescriptorStore;
  readonly secretEncryption: ISecretEncryptionService;
  readonly outbound?: CuratedProviderOutboundOptions;
}): IntegrationCleanupProviderResolver {
  return async (userId, providerId, integrationDescriptorId) => {
    const curated = await params.descriptorStore.findCuratedByProvider(providerId);
    const descriptor = curated?.id === integrationDescriptorId
      ? curated
      : await params.descriptorStore.findById(integrationDescriptorId, userId);
    if (!descriptor || descriptor.provider !== providerId) return null;
    try {
      return buildIntegrationProviderFromDescriptor(
        descriptor,
        params.secretEncryption,
        params.outbound ?? {},
      );
    } catch (err) {
      auditProviderBuild(descriptor.provider, 'failed');
      logger.error(
        `[CuratedIntegrationProviders] Cleanup provider build failed for '${descriptor.provider}'`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      return null;
    }
  };
}

export function buildIntegrationProviderFromDescriptor(
  descriptor: IntegrationDescriptorRecord,
  secretEncryption: ISecretEncryptionService,
  outbound: CuratedProviderOutboundOptions,
): IIntegrationProvider | null {
  if (descriptor.authStrategy === 'static_api_key') {
    return new StaticApiKeyIntegrationProvider(descriptor);
  }
  if (descriptor.authStrategy === 'oauth2_authorization_code') {
    const ciphertext = descriptor.clientSecretCiphertext;
    if (!ciphertext) return null;
    const clientSecret = secretEncryption
      .decrypt(
        ciphertext,
        integrationDescriptorClientSecretContext({
          provider: descriptor.provider,
          ownerUserId: descriptor.ownerUserId,
        }),
      )
      .toString('utf8');
    return new ConfiguredOAuthIntegrationProvider({
      descriptor,
      clientSecret,
      ...(outbound.pinnedOutbound ? { pinnedOutbound: outbound.pinnedOutbound } : {}),
      ...(outbound.dnsLookup ? { dnsLookup: outbound.dnsLookup } : {}),
    });
  }
  // 'coded' descriptors have no configured-provider interpreter (e.g. GitHub stays bespoke).
  return null;
}

export interface LoadCuratedIntegrationProvidersParams {
  readonly seedDir: string | null | undefined;
  readonly descriptorStore: IIntegrationDescriptorStore;
  readonly integrationStore: IUserIntegrationStore;
  readonly secretEncryption: ISecretEncryptionService;
  readonly secretRevisionHasher: Pick<IConsoleOpaqueValueService, 'hashOpaqueValue'>;
  readonly now?: () => Date;
  /** Overridable for tests; defaults to reading deployment credentials from process.env. */
  readonly credentialResolver?: IntegrationDescriptorSeedCredentialResolver;
  /** Outbound-transport seams for the built providers' token-endpoint calls. */
  readonly outbound?: CuratedProviderOutboundOptions;
}

/**
 * Load curated descriptor seed files into the store and return the
 * connect/callback providers built from them. A no-op returning `[]` when no
 * seed directory is configured.
 */
export async function loadCuratedIntegrationProviders(
  params: LoadCuratedIntegrationProvidersParams,
): Promise<IIntegrationProvider[]> {
  if (!params.seedDir) return [];
  const loader = new IntegrationDescriptorSeedLoader(
    params.seedDir,
    params.descriptorStore,
    params.secretEncryption,
    params.credentialResolver ?? createEnvIntegrationDescriptorCredentialResolver(),
    {
      integrationStore: params.integrationStore,
      secretRevisionHasher: params.secretRevisionHasher,
      ...(params.now ? { now: params.now } : {}),
    },
  );
  const { descriptors } = await loader.loadSeeds();
  return buildConfiguredIntegrationProviders(descriptors, params.secretEncryption, params.outbound ?? {});
}

function auditProviderBuild(provider: string, outcome: 'configured' | 'unsupported' | 'failed'): void {
  SecurityMonitor.logSecurityEvent({
    type: 'INTEGRATION_SECURITY_DECISION',
    severity: outcome === 'configured' ? 'LOW' : 'MEDIUM',
    source: 'CuratedIntegrationProviders',
    details: `Integration provider build ${outcome} for provider ${safeIntegrationAuditProvider(provider)}`,
  });
}
