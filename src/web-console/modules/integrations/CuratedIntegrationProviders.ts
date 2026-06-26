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

import { logger } from '../../../utils/logger.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type {
  IIntegrationDescriptorStore,
  IntegrationDescriptorRecord,
} from '../../stores/IIntegrationDescriptorStore.js';
import { ConfiguredOAuthIntegrationProvider } from './ConfiguredOAuthIntegrationProvider.js';
import {
  IntegrationDescriptorSeedLoader,
  type IntegrationDescriptorSeedCredentialResolver,
} from './IntegrationDescriptorSeedLoader.js';
import type { IIntegrationProvider } from './IntegrationProvider.js';
import { integrationDescriptorClientSecretContext } from './IntegrationSecretContext.js';
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
export function buildConfiguredIntegrationProviders(
  descriptors: readonly IntegrationDescriptorRecord[],
  secretEncryption: ISecretEncryptionService,
): IIntegrationProvider[] {
  const providers: IIntegrationProvider[] = [];
  for (const descriptor of descriptors) {
    try {
      const provider = buildProvider(descriptor, secretEncryption);
      if (provider) providers.push(provider);
    } catch (err) {
      logger.error(
        `[CuratedIntegrationProviders] Skipping descriptor '${descriptor.provider}' — provider build failed`,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }
  return providers;
}

function buildProvider(
  descriptor: IntegrationDescriptorRecord,
  secretEncryption: ISecretEncryptionService,
): IIntegrationProvider | null {
  if (descriptor.authStrategy === 'static_api_key') {
    return new StaticApiKeyIntegrationProvider(descriptor);
  }
  if (descriptor.authStrategy === 'oauth2_authorization_code') {
    if (!descriptor.clientSecretCiphertext) return null;
    const clientSecret = secretEncryption
      .decrypt(
        descriptor.clientSecretCiphertext,
        integrationDescriptorClientSecretContext({
          provider: descriptor.provider,
          ownerUserId: descriptor.ownerUserId,
        }),
      )
      .toString('utf8');
    return new ConfiguredOAuthIntegrationProvider({ descriptor, clientSecret });
  }
  // 'coded' descriptors have no configured-provider interpreter (e.g. GitHub stays bespoke).
  return null;
}

export interface LoadCuratedIntegrationProvidersParams {
  readonly seedDir: string | null | undefined;
  readonly descriptorStore: IIntegrationDescriptorStore;
  readonly secretEncryption: ISecretEncryptionService;
  readonly now?: () => Date;
  /** Overridable for tests; defaults to reading deployment credentials from process.env. */
  readonly credentialResolver?: IntegrationDescriptorSeedCredentialResolver;
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
    params.now ? { now: params.now } : {},
  );
  const { descriptors } = await loader.loadSeeds();
  return buildConfiguredIntegrationProviders(descriptors, params.secretEncryption);
}
