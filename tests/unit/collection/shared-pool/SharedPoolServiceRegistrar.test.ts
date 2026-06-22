/**
 * Tests for SharedPoolServiceRegistrar — feature-flag gating and DI wiring.
 *
 * The registrar reads from the `env` object (parsed once at import time).
 * We directly mutate `env.DOLLHOUSE_SHARED_POOL_ENABLED` to toggle the
 * flag per test, and restore it in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { SharedPoolServiceRegistrar } from '../../../../src/collection/shared-pool/SharedPoolServiceRegistrar.js';
import { env } from '../../../../src/config/env.js';
import type { DiContainerFacade } from '../../../../src/di/DiContainerFacade.js';

/**
 * Minimal DiContainerFacade mock that tracks registrations.
 */
function createMockContainer(overrides?: {
  hasRegistration?: (name: string) => boolean;
}): DiContainerFacade & { registrations: Map<string, () => unknown> } {
  const registrations = new Map<string, () => unknown>();
  return {
    registrations,
    register<T>(name: string, factory: () => T): void {
      registrations.set(name, factory as () => unknown);
    },
    resolve<T>(name: string): T {
      const factory = registrations.get(name);
      if (!factory) throw new Error(`Service '${name}' not registered`);
      return factory() as T;
    },
    hasRegistration(name: string): boolean {
      if (overrides?.hasRegistration) return overrides.hasRegistration(name);
      return registrations.has(name);
    },
  };
}

// Cast env to mutable for test toggling. The real `env` object is
// read-only by convention but is a plain object at runtime.
const mutableEnv = env as Record<string, unknown>;
const savedEnabled = env.DOLLHOUSE_SHARED_POOL_ENABLED;
const savedCollectionUrl = env.DOLLHOUSE_COLLECTION_URL;
const savedAllowlist = env.DOLLHOUSE_COLLECTION_ALLOWLIST;

describe('SharedPoolServiceRegistrar', () => {
  let registrar: SharedPoolServiceRegistrar;

  beforeEach(() => {
    registrar = new SharedPoolServiceRegistrar();
  });

  afterEach(() => {
    mutableEnv.DOLLHOUSE_SHARED_POOL_ENABLED = savedEnabled;
    mutableEnv.DOLLHOUSE_COLLECTION_URL = savedCollectionUrl;
    mutableEnv.DOLLHOUSE_COLLECTION_ALLOWLIST = savedAllowlist;
  });

  describe('when feature flag is off (default)', () => {
    beforeEach(() => {
      mutableEnv.DOLLHOUSE_SHARED_POOL_ENABLED = false;
    });

    it('returns false and registers nothing', async () => {
      const container = createMockContainer();
      const result = await registrar.bootstrapAndRegister(container);

      expect(result).toBe(false);
      expect(container.registrations.size).toBe(0);
    });
  });

  describe('when feature flag is on', () => {
    beforeEach(() => {
      mutableEnv.DOLLHOUSE_SHARED_POOL_ENABLED = true;
    });

    it('returns true', async () => {
      const container = createMockContainer();
      const result = await registrar.bootstrapAndRegister(container);
      expect(result).toBe(true);
    });

    it('registers SharedPoolConfig', async () => {
      const container = createMockContainer();
      await registrar.bootstrapAndRegister(container);

      expect(container.registrations.has('SharedPoolConfig')).toBe(true);
      const config = container.resolve('SharedPoolConfig') as { enabled: boolean };
      expect(config.enabled).toBe(true);
    });

    it('registers all expected services', async () => {
      const container = createMockContainer();
      await registrar.bootstrapAndRegister(container);

      const expectedServices = [
        'SharedPoolConfig',
        'ProvenanceStore',
        'ContentHashVerifier',
        'SharedPoolInstaller',
        'DeploymentSeedLoader',
        'ForkOnEditStrategy',
        'PublicElementDiscovery',
      ];

      for (const name of expectedServices) {
        expect(container.registrations.has(name)).toBe(true);
      }
    });

    it('SharedPoolInstaller resolves without throwing', async () => {
      const container = createMockContainer();
      await registrar.bootstrapAndRegister(container);

      expect(() => container.resolve('SharedPoolInstaller')).not.toThrow();
    });

    it('DeploymentSeedLoader resolves without throwing', async () => {
      const container = createMockContainer();
      await registrar.bootstrapAndRegister(container);

      expect(() => container.resolve('DeploymentSeedLoader')).not.toThrow();
    });

    it('PublicElementDiscovery resolves without throwing', async () => {
      const container = createMockContainer();
      await registrar.bootstrapAndRegister(container);

      expect(() => container.resolve('PublicElementDiscovery')).not.toThrow();
    });

    it('ForkOnEditStrategy resolves without throwing', async () => {
      const container = createMockContainer();
      await registrar.bootstrapAndRegister(container);

      expect(() => container.resolve('ForkOnEditStrategy')).not.toThrow();
    });

    it('all services resolve without throwing (no remaining placeholders)', async () => {
      const container = createMockContainer();
      await registrar.bootstrapAndRegister(container);

      const allServices = [
        'SharedPoolConfig', 'ProvenanceStore', 'ContentHashVerifier',
        'SharedPoolInstaller', 'DeploymentSeedLoader', 'ForkOnEditStrategy',
        'PublicElementDiscovery',
      ];
      for (const name of allServices) {
        expect(() => container.resolve(name)).not.toThrow();
      }
    });

    it('ProvenanceStore and ContentHashVerifier resolve without throwing (file mode)', async () => {
      const container = createMockContainer({
        hasRegistration: (name) => name !== 'DatabaseInstance' && container.registrations.has(name),
      });
      await registrar.bootstrapAndRegister(container);

      expect(() => container.resolve('ProvenanceStore')).not.toThrow();
      expect(() => container.resolve('ContentHashVerifier')).not.toThrow();
    });

    it('registers DB-mode ProvenanceStore when DatabaseInstance is present', async () => {
      const limitMock = jest.fn<() => Promise<{ id: string }[]>>().mockResolvedValue([{ id: 'already-exists' }]);
      const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });
      const selectMock = jest.fn().mockReturnValue({ from: fromMock });
      const mockDbInstance = { select: selectMock };

      const container = createMockContainer({
        hasRegistration: (name) => name === 'DatabaseInstance' || container.registrations.has(name),
      });
      container.register('DatabaseInstance', () => mockDbInstance);
      await registrar.bootstrapAndRegister(container);

      expect(container.registrations.has('ProvenanceStore')).toBe(true);
      expect(container.registrations.has('SystemUserProvisioner')).toBe(true);
      expect(() => container.resolve('ProvenanceStore')).not.toThrow();
      expect(() => container.resolve('ContentHashVerifier')).not.toThrow();
    });

    it('picks up collection URL from env', async () => {
      mutableEnv.DOLLHOUSE_COLLECTION_URL = 'https://custom.example.com/collection';
      const container = createMockContainer();
      await registrar.bootstrapAndRegister(container);

      const config = container.resolve('SharedPoolConfig') as { collectionUrl: string };
      expect(config.collectionUrl).toBe('https://custom.example.com/collection');
    });

    it('picks up allowlist from env', async () => {
      mutableEnv.DOLLHOUSE_COLLECTION_ALLOWLIST = ['custom.host', 'another.host'];
      const container = createMockContainer();
      await registrar.bootstrapAndRegister(container);

      const config = container.resolve('SharedPoolConfig') as { collectionAllowlist: string[] };
      expect(config.collectionAllowlist).toEqual(['custom.host', 'another.host']);
    });
  });
});
