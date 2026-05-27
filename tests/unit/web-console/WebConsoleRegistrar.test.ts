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
      InMemoryConsoleAccountAdminStore,
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
    expect(composition.registry.createRouteManifest().routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        moduleId: 'accountAdmin',
        path: '/api/v1/admin/accounts/users',
        requiredCapability: 'console:admin:accounts',
      }),
    ]));
    expect(composition.sessionStore).toBeInstanceOf(InMemoryConsoleSessionStore);
    expect(composition.loginTransactionStore).toBeInstanceOf(InMemoryLoginTransactionStore);
    expect(composition.idempotencyStore).toBeInstanceOf(InMemoryIdempotencyStore);
    expect(composition.factorStore).toBeInstanceOf(InMemoryConsoleFactorStore);
    expect(composition.accountAdminStore).toBeInstanceOf(InMemoryConsoleAccountAdminStore);
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
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.accountAdminStore)).toBe(composition.accountAdminStore);
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

  it('registers protected correlation rate limiting only with explicit shared dependencies', async () => {
    const container = new TestContainer();
    const { InMemoryRateLimitStore } = await import('../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js');
    const {
      ConsoleProtectedCorrelationRateLimiter,
      WebConsoleRegistrar,
      WEB_CONSOLE_SERVICE_NAMES,
    } = await import('../../../src/web-console/index.js');
    const rateLimitStore = new InMemoryRateLimitStore();
    container.seed('RateLimitStore', rateLimitStore);
    const selectorKey = Buffer.alloc(32, 22);
    const now = () => new Date('2026-05-27T14:30:00.000Z');

    const composition = await new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 21),
      protectedCorrelationSelectorHmacKey: selectorKey,
      registerCleanup: false,
      now,
    }).bootstrapAndRegister(container);
    selectorKey.fill(0);

    expect(composition.protectedCorrelationRateLimiter).toBeInstanceOf(ConsoleProtectedCorrelationRateLimiter);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.protectedCorrelationRateLimiter))
      .toBe(composition.protectedCorrelationRateLimiter);

    const first = await composition.protectedCorrelationRateLimiter?.consume({
      consoleSessionIdHash: Buffer.alloc(32, 7),
      ip: null,
      accountCorrelationId: '018f3d47-73ae-7f10-a0de-0742618d4fb1',
    });
    const second = await new ConsoleProtectedCorrelationRateLimiter({
      store: new InMemoryRateLimitStore(),
      selectorHmacKey: Buffer.alloc(32, 22),
      now,
    }).consume({
      consoleSessionIdHash: Buffer.alloc(32, 7),
      ip: null,
      accountCorrelationId: '018f3d47-73ae-7f10-a0de-0742618d4fb1',
    });
    expect(first).toMatchObject({
      allowed: true,
      attemptsRemaining: second.attemptsRemaining,
      windowResetsAt: new Date('2026-05-27T15:30:00.000Z'),
    });
  });

  it('fails clearly when protected correlation key is supplied without a rate-limit store', async () => {
    const { WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    await expect(new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 23),
      protectedCorrelationSelectorHmacKey: Buffer.alloc(32, 24),
      registerCleanup: false,
    }).bootstrapAndRegister(new TestContainer())).rejects.toThrow('RateLimitStore');
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
    container.seed('AuditHmacResolver', { resolve: jest.fn() });
    const lifecycle = { registerPeriodicTask: jest.fn() };
    container.seed('LifecycleService', lifecycle);
    const { WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    const composition = await new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 14),
      reportCleanupError: jest.fn(),
    }).bootstrapAndRegister(container);

    expect(composition.storageBackend).toBe('postgres');
    expect(composition.routesMounted).toBe(false);
    expect(composition.registry.createRouteManifest().routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ moduleId: 'accountAdmin' }),
    ]));
    expect(composition.sessionStore.constructor.name).toBe('PostgresConsoleSessionStore');
    expect(composition.loginTransactionStore.constructor.name).toBe('PostgresLoginTransactionStore');
    expect(composition.idempotencyStore.constructor.name).toBe('PostgresIdempotencyStore');
    expect(composition.factorStore.constructor.name).toBe('PostgresConsoleFactorStore');
    expect(composition.accountAdminStore.constructor.name).toBe('PostgresConsoleAccountAdminStore');
    expect(composition.identityResolver.constructor.name).toBe('PostgresConsoleIdentityResolver');
  });

  it('fails clearly when PostgreSQL storage lacks durable admin audit HMAC resolution', async () => {
    const container = new TestContainer();
    container.seed('SystemDatabaseInstance', {});
    container.seed('LifecycleService', { registerPeriodicTask: jest.fn() });
    const { WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    await expect(new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 16),
      reportCleanupError: jest.fn(),
    }).bootstrapAndRegister(container)).rejects.toThrow('AuditHmacResolver');
  });
});
