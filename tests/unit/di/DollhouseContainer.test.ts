import { describe, it, expect } from '@jest/globals';
import { DollhouseContainer } from '../../../src/di/Container.js';

describe('DollhouseContainer', () => {
  it('should create a container instance', () => {
    const container = new DollhouseContainer();
    expect(container).toBeDefined();
  });

  it('should register and resolve services', () => {
    const container = new DollhouseContainer();

    // Test that core services are registered
    const apiCache = container.resolve('APICache');
    expect(apiCache).toBeDefined();

    const collectionCache = container.resolve('CollectionCache');
    expect(collectionCache).toBeDefined();

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
});
