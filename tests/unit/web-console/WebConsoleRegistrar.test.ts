import { describe, expect, it, jest } from '@jest/globals';

import type { DiContainerFacade } from '../../../src/di/DiContainerFacade.js';

jest.unstable_mockModule('../../../src/web-console/stores/PostgresConsoleSessionStore.js', () => ({
  PostgresConsoleSessionStore: class PostgresConsoleSessionStore {
    constructor(readonly database: unknown) {}
  },
}));
jest.unstable_mockModule('../../../src/web-console/stores/PostgresLoginTransactionStore.js', () => ({
  PostgresLoginTransactionStore: class PostgresLoginTransactionStore {
    constructor(readonly database: unknown) {}
  },
}));
jest.unstable_mockModule('../../../src/web-console/stores/PostgresIdempotencyStore.js', () => ({
  PostgresIdempotencyStore: class PostgresIdempotencyStore {
    constructor(readonly database: unknown) {}
  },
}));
jest.unstable_mockModule('../../../src/web-console/stores/PostgresConsoleFactorStore.js', () => ({
  PostgresConsoleFactorStore: class PostgresConsoleFactorStore {
    constructor(readonly database: unknown) {}
  },
}));
jest.unstable_mockModule('../../../src/web-console/identity/PostgresConsoleIdentityResolver.js', () => ({
  PostgresConsoleIdentityResolver: class PostgresConsoleIdentityResolver {
    constructor(readonly database: unknown) {}
  },
}));

class TestContainer implements DiContainerFacade {
  readonly factories = new Map<string, () => unknown>();
  readonly values = new Map<string, unknown>();

  register<T>(name: string, factory: () => T): void {
    this.factories.set(name, factory);
  }

  resolve<T>(name: string): T {
    if (this.values.has(name)) return this.values.get(name) as T;
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Service not registered: ${name}`);
    const value = factory();
    this.values.set(name, value);
    return value as T;
  }

  hasRegistration(name: string): boolean {
    return this.values.has(name) || this.factories.has(name);
  }

  seed<T>(name: string, value: T): void {
    this.values.set(name, value);
  }
}

describe('WebConsoleRegistrar', () => {
  it('registers an unmounted in-memory web-console composition', async () => {
    const lifecycle = { registerPeriodicTask: jest.fn() };
    const reportCleanupError = jest.fn();
    const container = new TestContainer();
    container.seed('LifecycleService', lifecycle);
    const {
      ConsoleModuleRegistry,
      WebConsoleRegistrar,
      HmacConsoleOpaqueValueService,
      InMemoryAdminAuditWriter,
      InMemoryConsoleIdentityResolver,
      InMemoryConsoleSessionStore,
      InMemoryConsoleFactorStore,
      InMemoryIdempotencyStore,
      InMemoryLoginTransactionStore,
      WEB_CONSOLE_SERVICE_NAMES,
    } = await import('../../../src/web-console/index.js');

    const composition = await new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 11),
      reportCleanupError,
      now: () => new Date('2026-05-26T12:00:00.000Z'),
    }).bootstrapAndRegister(container);

    expect(composition).toMatchObject({
      storageBackend: 'memory',
      routesMounted: false,
    });
    expect(composition.registry).toBeInstanceOf(ConsoleModuleRegistry);
    expect(composition.registry.createRouteManifest()).toEqual({ apiVersion: 'v1', routes: [] });
    expect(composition.sessionStore).toBeInstanceOf(InMemoryConsoleSessionStore);
    expect(composition.loginTransactionStore).toBeInstanceOf(InMemoryLoginTransactionStore);
    expect(composition.idempotencyStore).toBeInstanceOf(InMemoryIdempotencyStore);
    expect(composition.factorStore).toBeInstanceOf(InMemoryConsoleFactorStore);
    expect(composition.identityResolver).toBeInstanceOf(InMemoryConsoleIdentityResolver);
    expect(composition.opaqueValues).toBeInstanceOf(HmacConsoleOpaqueValueService);
    expect(composition.adminAuditWriter).toBeInstanceOf(InMemoryAdminAuditWriter);
    expect(lifecycle.registerPeriodicTask).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Function),
      'webConsole.storeCleanup',
    );
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.composition)).toBe(composition);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.moduleRegistry)).toBe(composition.registry);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.sessionStore)).toBe(composition.sessionStore);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.factorStore)).toBe(composition.factorStore);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.cleanupScheduler)).toBe(composition.cleanupScheduler);
  });

  it('uses a container-provided opaque HMAC key and can defer cleanup registration', async () => {
    const container = new TestContainer();
    container.seed('WebConsoleOpaqueValueHmacKey', Buffer.alloc(32, 12));
    const { WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    const composition = await new WebConsoleRegistrar({
      registerCleanup: false,
    }).bootstrapAndRegister(container);

    expect(composition.cleanupScheduler).toBeNull();
    expect(composition.opaqueValues.createOpaqueValue()).toEqual(expect.any(String));
  });

  it('fails clearly when required secrets or scheduled error reporting are missing', async () => {
    const { WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    await expect(new WebConsoleRegistrar({
      reportCleanupError: jest.fn(),
    }).bootstrapAndRegister(new TestContainer())).rejects.toThrow('WebConsoleOpaqueValueHmacKey');

    await expect(new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 13),
    }).bootstrapAndRegister(new TestContainer())).rejects.toThrow('reportCleanupError');
  });

  it('fails clearly when cleanup is requested without LifecycleService', async () => {
    const container = new TestContainer();
    const { WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    await expect(new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 15),
      reportCleanupError: jest.fn(),
    }).bootstrapAndRegister(container)).rejects.toThrow('LifecycleService');
  });

  it('selects Postgres adapters from an existing database registration without mounting routes', async () => {
    const container = new TestContainer();
    const database = {};
    container.seed('SystemDatabaseInstance', database);
    const lifecycle = { registerPeriodicTask: jest.fn() };
    container.seed('LifecycleService', lifecycle);
    const { WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    const composition = await new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 14),
      reportCleanupError: jest.fn(),
    }).bootstrapAndRegister(container);

    expect(composition.storageBackend).toBe('postgres');
    expect(composition.routesMounted).toBe(false);
    expect(composition.registry.createRouteManifest()).toEqual({ apiVersion: 'v1', routes: [] });
    expect(composition.sessionStore.constructor.name).toBe('PostgresConsoleSessionStore');
    expect(composition.loginTransactionStore.constructor.name).toBe('PostgresLoginTransactionStore');
    expect(composition.idempotencyStore.constructor.name).toBe('PostgresIdempotencyStore');
    expect(composition.factorStore.constructor.name).toBe('PostgresConsoleFactorStore');
    expect(composition.identityResolver.constructor.name).toBe('PostgresConsoleIdentityResolver');
  });
});
