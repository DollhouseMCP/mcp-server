import type { IntegrationDescriptorRecord } from '../../stores/IIntegrationDescriptorStore.js';
import type { UserIntegrationRecord } from '../../stores/IUserIntegrationStore.js';
import type {
  IIntegrationProvider,
  IntegrationAuthorizationRequest,
  IntegrationProviderStatusProjection,
  IntegrationRevocationRequest,
  IntegrationTokenExchangeRequest,
  IntegrationTokenExchangeResult,
} from './IntegrationProvider.js';
import { normalizeUnicodeDisplayText } from './IntegrationProvider.js';
import { serializeConfiguredIntegrationStatus } from './IntegrationDtos.js';
import { integrationDescriptorRoutingFingerprint } from './IntegrationDescriptorRoutingFingerprint.js';

export class StaticApiKeyIntegrationProvider implements IIntegrationProvider {
  readonly descriptor;
  readonly integrationDescriptorId;
  readonly integrationDescriptorFingerprint;
  readonly authorizationConfigured = true;
  readonly credentialStrategy = 'static_api_key';
  readonly staticApiKeyInjection;

  constructor(private readonly record: IntegrationDescriptorRecord) {
    if (record.authStrategy !== 'static_api_key' || !record.staticApiKey) {
      throw new Error('static API key provider requires a static_api_key descriptor');
    }
    this.descriptor = {
      id: record.provider,
      displayName: normalizeUnicodeDisplayText(record.displayName),
      category: normalizeUnicodeDisplayText(record.category),
    };
    this.integrationDescriptorId = record.id;
    this.integrationDescriptorFingerprint = integrationDescriptorRoutingFingerprint(record);
    this.staticApiKeyInjection = record.staticApiKey.injection;
  }

  createAuthorizationUrl(_request: IntegrationAuthorizationRequest): string {
    throw new Error('static_api_key_provider_does_not_use_oauth');
  }

  exchangeAuthorizationCode(_request: IntegrationTokenExchangeRequest): Promise<IntegrationTokenExchangeResult> {
    return Promise.reject(new Error('static_api_key_provider_does_not_use_oauth'));
  }

  async revokeCredentials(_request: IntegrationRevocationRequest): Promise<void> {
    // Static keys have no remote revocation endpoint; local disconnect removes the encrypted credential.
    await Promise.resolve();
  }

  projectStatus(record: UserIntegrationRecord | null): IntegrationProviderStatusProjection {
    return { body: serializeConfiguredIntegrationStatus(this.descriptor, record) };
  }
}
