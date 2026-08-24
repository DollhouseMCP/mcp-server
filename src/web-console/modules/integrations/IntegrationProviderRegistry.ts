import type { UserIntegrationProvider } from '../../stores/IUserIntegrationStore.js';
import type { IIntegrationProvider, IntegrationProviderCatalogDescriptor } from './IntegrationProvider.js';

export class IntegrationProviderRegistry {
  private readonly providers: ReadonlyMap<UserIntegrationProvider, IIntegrationProvider>;

  constructor(providers: readonly IIntegrationProvider[]) {
    const providerMap = new Map<UserIntegrationProvider, IIntegrationProvider>();
    for (const provider of providers) {
      const providerId = provider.descriptor.id;
      if (providerMap.has(providerId)) throw new DuplicateIntegrationProviderError(providerId);
      providerMap.set(providerId, provider);
    }
    this.providers = providerMap;
  }

  static empty(): IntegrationProviderRegistry {
    return new IntegrationProviderRegistry([]);
  }

  get(providerId: UserIntegrationProvider): IIntegrationProvider | null {
    return this.providers.get(providerId) ?? null;
  }

  require(providerId: UserIntegrationProvider): IIntegrationProvider {
    const provider = this.get(providerId);
    if (!provider) throw new IntegrationProviderNotFoundError(providerId);
    return provider;
  }

  listDescriptors(): readonly IntegrationProviderCatalogDescriptor[] {
    return [...this.providers.values()].map(provider => provider.descriptor);
  }
}

export class DuplicateIntegrationProviderError extends Error {
  constructor(readonly providerId: string) {
    super(`Integration provider '${providerId}' is registered more than once`);
    this.name = 'DuplicateIntegrationProviderError';
  }
}

export class IntegrationProviderNotFoundError extends Error {
  constructor(readonly providerId: string) {
    super(`Integration provider '${providerId}' is not registered`);
    this.name = 'IntegrationProviderNotFoundError';
  }
}
