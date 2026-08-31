import { describe, it, expect } from '@jest/globals';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { WEB_CONSOLE_SERVICE_NAMES } from '../../../src/web-console/WebConsoleRegistrar.js';
import type { IIntegrationProvider } from '../../../src/web-console/modules/integrations/IntegrationProvider.js';
import type { IntegrationProviderRegistry } from '../../../src/web-console/modules/integrations/IntegrationProviderRegistry.js';

describe('DollhouseContainer', () => {
  it('should create a container instance', () => {
    const container = new DollhouseContainer();
    expect(container).toBeDefined();
  });

  it('should register and resolve services', async () => {
    const container = new DollhouseContainer();

    // Test that core services are registered
    const apiCache = container.resolve('APICache');
    expect(apiCache).toBeDefined();

    const collectionCache = container.resolve('CollectionCache');
    expect(collectionCache).toBeDefined();

    // Phase 4.5: ConfigManager now depends on OperatorConfigStore +
    // UserConfigStore, which are async-registered by StorageServiceRegistrar
    // in preparePortfolio. Register them inline here so this unit test
    // doesn't have to invoke the full preparePortfolio bootstrap.
    const { InMemoryOperatorConfigStore } = await import('../../../src/storage/operatorConfig/InMemoryOperatorConfigStore.js');
    const { InMemoryUserConfigStore } = await import('../../../src/storage/userConfig/InMemoryUserConfigStore.js');
    container.register('OperatorConfigStore', () => new InMemoryOperatorConfigStore());
    container.register('UserConfigStore', () => new InMemoryUserConfigStore());

    const configManager = container.resolve('ConfigManager');
    expect(configManager).toBeDefined();
  });

  it('should resolve singleton services consistently', () => {
    const container = new DollhouseContainer();

    // Resolve the same service twice
    const apiCache1 = container.resolve('APICache');
    const apiCache2 = container.resolve('APICache');

    // Should return the same instance for singleton services
    expect(apiCache1).toBe(apiCache2);
  });

  it('should throw error when resolving unregistered service', () => {
    const container = new DollhouseContainer();

    expect(() => {
      container.resolve('NonExistentService');
    }).toThrow('Service not registered: NonExistentService');
  });

  it('rejects duplicate service registration without explicit replacement', () => {
    const container = new DollhouseContainer();
    container.register('Slice13Service', () => ({ generation: 1 }));

    expect(() => {
      container.register('Slice13Service', () => ({ generation: 2 }));
    }).toThrow("Service already registered: Slice13Service");
    expect(container.resolve<{ generation: number }>('Slice13Service')).toEqual({ generation: 1 });
  });

  it('permits an explicit service-registration replacement', () => {
    const container = new DollhouseContainer();
    container.register('Slice13Service', () => ({ generation: 1 }));
    container.register('Slice13Service', () => ({ generation: 2 }), { override: true });

    expect(container.resolve<{ generation: number }>('Slice13Service')).toEqual({ generation: 2 });
  });

  it('requires replace targets to exist', () => {
    const container = new DollhouseContainer();

    expect(() => {
      container.replace('MisspelledService', () => ({ generation: 2 }));
    }).toThrow('Service not registered for replacement: MisspelledService');
  });

  it('includes configured OAuth providers in the runtime refresh registry', () => {
    const container = new DollhouseContainer();
    const provider = configuredProvider('configured-oauth');
    container.register(
      WEB_CONSOLE_SERVICE_NAMES.configuredIntegrationProviders,
      () => [provider],
    );

    const registry = (container as unknown as {
      resolveIntegrationProviderRegistry(): IntegrationProviderRegistry;
    }).resolveIntegrationProviderRegistry();

    expect(registry.get('configured-oauth')).toBe(provider);
  });
});

function configuredProvider(id: string): IIntegrationProvider {
  return {
    descriptor: { id, displayName: 'Configured OAuth', category: 'test' },
    authorizationConfigured: true,
    credentialStrategy: 'oauth2_authorization_code',
    createAuthorizationUrl: () => 'https://auth.example/authorize',
    exchangeAuthorizationCode: () => Promise.reject(new Error('not used')),
    refreshCredentials: () => Promise.resolve({ accessToken: 'refreshed' }),
    revokeCredentials: () => Promise.resolve(),
    projectStatus: () => ({ body: { provider: id, status: 'disconnected' } }),
  } as IIntegrationProvider;
}
