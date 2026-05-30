import { describe, expect, it, jest } from '@jest/globals';

import type { DiContainerFacade } from '../../../src/di/DiContainerFacade.js';
import { InMemorySigningKeyStore } from '../../../src/storage/signingKeys/InMemorySigningKeyStore.js';
import { InMemoryUserConfigStore } from '../../../src/storage/userConfig/InMemoryUserConfigStore.js';

const CONSOLE_SELF_CAPABILITY = 'console:self';
const SHARED_HOSTED_PROFILE = 'shared-hosted';
const TEST_PUBLIC_BASE_URL = 'https://console.example.test';

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
jest.unstable_mockModule('../../../src/web-console/stores/PostgresUserIntegrationStore.js', () => ({
  PostgresUserIntegrationStore: class PostgresUserIntegrationStore {
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
jest.unstable_mockModule('../../../src/web-console/stores/PostgresConsoleAccountAllowlistStore.js', () => ({
  addAccountAllowlistEntryWithTx: jest.fn(),
  updateAccountAllowlistEntryWithTx: jest.fn(),
  removeAccountAllowlistEntryWithTx: jest.fn(),
  PostgresConsoleAccountAllowlistStore: class PostgresConsoleAccountAllowlistStore {
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

class ProductionAdapter {}

function productionAdapter<T>(): T {
  return new ProductionAdapter() as T;
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
      InMemoryAdminAuditQuery,
      InMemoryApprovalAuditQuery,
      InMemoryAuthenticationAuditQuery,
      InMemoryConsoleIdentityResolver,
      InMemoryConsoleSessionStore,
      InMemoryConsoleFactorStore,
      InMemoryConsoleAccountAllowlistStore,
      InMemoryConsoleAccountAdminStore,
      InMemoryUserIntegrationStore,
      InMemoryPortfolioElementStore,
      InMemoryRuntimeSessionControlStore,
      InMemorySessionApprovalStore,
      InMemorySessionApprovalEventSink,
      InMemorySessionExecutionReader,
      InMemoryConsoleTelemetryQuery,
      InMemoryIdempotencyStore,
      InMemoryLoginTransactionStore,
      StaticConsoleSecurityInvalidationReadiness,
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
      apiV1Mount: null,
    });
    expect(composition.registry).toBeInstanceOf(ConsoleModuleRegistry);
    expect(composition.registry.createRouteManifest().routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        moduleId: 'health',
        path: '/api/v1/health/ready',
        requiredCapability: 'none',
      }),
      expect.objectContaining({
        moduleId: 'accountAdmin',
        path: '/api/v1/admin/accounts/users',
        requiredCapability: 'console:admin:accounts',
      }),
      expect.objectContaining({
        moduleId: 'operations',
        path: '/api/v1/admin/operate/health',
        requiredCapability: 'console:admin:operate',
      }),
      expect.objectContaining({
        moduleId: 'audit',
        path: '/api/v1/admin/audit/admin',
        requiredCapability: 'console:admin:audit',
      }),
      expect.objectContaining({
        moduleId: 'selfSecurity',
        path: '/api/v1/me/security/factors',
        requiredCapability: CONSOLE_SELF_CAPABILITY,
      }),
      expect.objectContaining({
        moduleId: 'integrations',
        path: '/api/v1/me/integrations/github',
        requiredCapability: CONSOLE_SELF_CAPABILITY,
      }),
      expect.objectContaining({
        moduleId: 'portfolio',
        path: '/api/v1/me/portfolio/elements',
        requiredCapability: CONSOLE_SELF_CAPABILITY,
      }),
      expect.objectContaining({
        moduleId: 'approvals',
        path: '/api/v1/me/sessions/:session_id/approvals',
        requiredCapability: CONSOLE_SELF_CAPABILITY,
      }),
      expect.objectContaining({
        moduleId: 'executions',
        path: '/api/v1/me/sessions/:session_id/executions',
        requiredCapability: CONSOLE_SELF_CAPABILITY,
      }),
    ]));
    expect(composition.registry.createRouteManifest().routes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        moduleId: 'accountAdmin',
        path: '/api/v1/admin/accounts/allowlist',
      }),
    ]));
    expect(composition.sessionStore).toBeInstanceOf(InMemoryConsoleSessionStore);
    expect(composition.loginTransactionStore).toBeInstanceOf(InMemoryLoginTransactionStore);
    expect(composition.idempotencyStore).toBeInstanceOf(InMemoryIdempotencyStore);
    expect(composition.factorStore).toBeInstanceOf(InMemoryConsoleFactorStore);
    expect(composition.accountAdminStore).toBeInstanceOf(InMemoryConsoleAccountAdminStore);
    expect(composition.accountAllowlistStore).toBeInstanceOf(InMemoryConsoleAccountAllowlistStore);
    expect(composition.integrationStore).toBeInstanceOf(InMemoryUserIntegrationStore);
    expect(composition.portfolioStore).toBeInstanceOf(InMemoryPortfolioElementStore);
    expect(composition.runtimeSessionControlStore).toBeInstanceOf(InMemoryRuntimeSessionControlStore);
    expect(composition.sessionApprovalStore).toBeInstanceOf(InMemorySessionApprovalStore);
    expect(composition.sessionApprovalEventSink).toBeInstanceOf(InMemorySessionApprovalEventSink);
    expect(composition.sessionExecutionReader).toBeInstanceOf(InMemorySessionExecutionReader);
    expect(composition.telemetryQuery).toBeInstanceOf(InMemoryConsoleTelemetryQuery);
    expect(composition.identityResolver).toBeInstanceOf(InMemoryConsoleIdentityResolver);
    expect(composition.userConfigStore).toBeInstanceOf(InMemoryUserConfigStore);
    expect(composition.opaqueValues).toBeInstanceOf(HmacConsoleOpaqueValueService);
    expect(composition.adminAuditWriter).toBeInstanceOf(InMemoryAdminAuditWriter);
    expect(composition.adminAuditQuery).toBeInstanceOf(InMemoryAdminAuditQuery);
    expect(composition.approvalAuditQuery).toBeInstanceOf(InMemoryApprovalAuditQuery);
    expect(composition.authenticationAuditQuery).toBeInstanceOf(InMemoryAuthenticationAuditQuery);
    expect(composition.securityInvalidationReadiness).toBeInstanceOf(StaticConsoleSecurityInvalidationReadiness);
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
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.accountAllowlistStore)).toBe(composition.accountAllowlistStore);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.integrationStore)).toBe(composition.integrationStore);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.portfolioStore)).toBe(composition.portfolioStore);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.runtimeSessionControlStore))
      .toBe(composition.runtimeSessionControlStore);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalStore)).toBe(composition.sessionApprovalStore);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalEventSink))
      .toBe(composition.sessionApprovalEventSink);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.sessionExecutionReader))
      .toBe(composition.sessionExecutionReader);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.sessionGatekeeperReader))
      .toBe(composition.sessionGatekeeperReader);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.telemetryQuery)).toBe(composition.telemetryQuery);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.adminAuditQuery)).toBe(composition.adminAuditQuery);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.approvalAuditQuery)).toBe(composition.approvalAuditQuery);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.authenticationAuditQuery))
      .toBe(composition.authenticationAuditQuery);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.securityInvalidationReadiness))
      .toBe(composition.securityInvalidationReadiness);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.userConfigStore)).toBe(composition.userConfigStore);
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

  it('auto-wires approvals and Gatekeeper state to the lowercase live Gatekeeper registration', async () => {
    const container = new TestContainer();
    const {
      GatekeeperSessionStateReader,
      GatekeeperSessionApprovalStore,
      WebConsoleRegistrar,
      WEB_CONSOLE_SERVICE_NAMES,
    } = await import('../../../src/web-console/index.js');
    const { Gatekeeper } = await import('../../../src/handlers/mcp-aql/Gatekeeper.js');
    container.seed('gatekeeper', new Gatekeeper());

    const composition = await new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 19),
      registerCleanup: false,
    }).bootstrapAndRegister(container);

    expect(composition.sessionApprovalStore).toBeInstanceOf(GatekeeperSessionApprovalStore);
    expect(composition.sessionGatekeeperReader).toBeInstanceOf(GatekeeperSessionStateReader);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalStore)).toBe(composition.sessionApprovalStore);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.sessionGatekeeperReader))
      .toBe(composition.sessionGatekeeperReader);
  });

  it('accepts an injected portfolio store without assuming a storage backend', async () => {
    const container = new TestContainer();
    const { InMemoryPortfolioElementStore, WebConsoleRegistrar } = await import('../../../src/web-console/index.js');
    const portfolioStore = new InMemoryPortfolioElementStore();

    const composition = await new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 18),
      portfolioStore,
      registerCleanup: false,
    }).bootstrapAndRegister(container);

    expect(composition.portfolioStore).toBe(portfolioStore);
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

  it('fails clearly when GitHub integration writes are configured without publicBaseUrl', async () => {
    const { WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    await expect(new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 25),
      registerCleanup: false,
      githubIntegrationProvider: {
        createAuthorizationUrl: () => 'https://github.example/install',
        exchangeAuthorizationCode: () => Promise.resolve({
          accountLabel: 'alice',
          installationId: 'installation-1',
          repositorySelection: 'selected',
          contentsPermission: 'read',
          accessToken: 'access-token',
          refreshToken: null,
        }),
        revokeCredentials: () => Promise.resolve(),
      },
    }).bootstrapAndRegister(new TestContainer())).rejects
      .toThrow('GitHub integration provider requires publicBaseUrl');
  });

  it('fails hosted/shared activation with all production invariant failures instead of mounting', async () => {
    const { WebConsoleProductionActivationError, WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    await expect(new WebConsoleRegistrar({
      activationProfile: SHARED_HOSTED_PROFILE,
      opaqueValueHmacKey: Buffer.alloc(32, 26),
      registerCleanup: false,
    }).bootstrapAndRegister(new TestContainer())).rejects.toBeInstanceOf(WebConsoleProductionActivationError);
    await expect(new WebConsoleRegistrar({
      activationProfile: SHARED_HOSTED_PROFILE,
      opaqueValueHmacKey: Buffer.alloc(32, 26),
      registerCleanup: false,
    }).bootstrapAndRegister(new TestContainer())).rejects.toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({ code: 'database_required' }),
        expect.objectContaining({ code: 'security_invalidation_processor_not_ready' }),
        expect.objectContaining({ code: 'portfolio_sync_worker_not_ready' }),
        expect.objectContaining({ code: 'sessionStore_not_production_ready' }),
        expect.objectContaining({ code: 'authStorage_missing' }),
        expect.objectContaining({ code: 'secretEncryption_missing' }),
        expect.objectContaining({ code: 'protectedCorrelationRateLimiter_missing' }),
        expect.objectContaining({ code: 'protectedCorrelationRateLimitStore_missing' }),
        expect.objectContaining({ code: 'oauthGrantRevocationService_missing' }),
        expect.objectContaining({ code: 'accountInviteIssuer_missing' }),
        expect.objectContaining({ code: 'githubIntegrationProvider_missing' }),
        expect.objectContaining({ code: 'integrationPublicBaseUrl_missing' }),
      ]),
    });
  });

  it('accepts hosted/shared activation only when production dependencies are explicit', async () => {
    const container = new TestContainer();
    const database = {};
    container.seed('SystemDatabaseInstance', database);
    container.seed('AuditHmacResolver', { resolve: jest.fn() });
    container.seed('UserConfigStore', productionAdapter());
    container.seed('SigningKeyStore', productionAdapter());
    container.seed('RateLimitStore', productionAdapter());
    container.seed('WebConsoleSessionActivationStateAdapter', productionAdapter());
    container.seed('WebConsoleSessionActivationEventSink', productionAdapter());
    const {
      StaticConsoleSecurityInvalidationReadiness,
      WebConsoleRegistrar,
      WEB_CONSOLE_SERVICE_NAMES,
    } = await import('../../../src/web-console/index.js');

    const composition = await new WebConsoleRegistrar({
      activationProfile: SHARED_HOSTED_PROFILE,
      enableApiV1Mount: true,
      productionReadiness: {
        portfolioSyncWorkerReady: true,
      },
      securityInvalidationReadiness: new StaticConsoleSecurityInvalidationReadiness(true),
      opaqueValueHmacKey: Buffer.alloc(32, 27),
      protectedCorrelationSelectorHmacKey: Buffer.alloc(32, 28),
      secretEncryptionKey: {
        keyId: 'prod-key',
        key: Buffer.alloc(32, 29),
      },
      authStorage: productionAdapter(),
      oauthGrantRevocationService: productionAdapter(),
      accountInviteIssuer: productionAdapter(),
      githubIntegrationProvider: productionAdapter(),
      publicBaseUrl: TEST_PUBLIC_BASE_URL,
      portfolioStore: productionAdapter(),
      approvalStore: productionAdapter(),
      approvalEventSink: productionAdapter(),
      executionReader: productionAdapter(),
      gatekeeperReader: productionAdapter(),
      telemetryQuery: productionAdapter(),
      ownedActivityQuery: productionAdapter(),
      ownedMetricQuery: productionAdapter(),
      approvalAuditQuery: productionAdapter(),
      authenticationAuditQuery: productionAdapter(),
      registerCleanup: false,
    }).bootstrapAndRegister(container);

    expect(composition.storageBackend).toBe('postgres');
    expect(composition.routesMounted).toBe(false);
    expect(composition.apiV1Mount).not.toBeNull();
    expect(composition.apiV1Mount?.mounted()).toBe(false);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.apiV1Mount)).toBe(composition.apiV1Mount);
    composition.apiV1Mount?.markMounted();
    expect(composition.apiV1Mount?.mounted()).toBe(true);
    expect(composition.routesMounted).toBe(true);
  });

  it('refuses descriptor api mount outside the hosted/shared activation gate', async () => {
    const { WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    await expect(new WebConsoleRegistrar({
      enableApiV1Mount: true,
      opaqueValueHmacKey: Buffer.alloc(32, 31),
      publicBaseUrl: TEST_PUBLIC_BASE_URL,
      registerCleanup: false,
    }).bootstrapAndRegister(new TestContainer())).rejects
      .toThrow('Web console /api/v1 mount requires shared-hosted activation profile');
  });

  it('keeps aggregated production activation failures for null-prototype adapters', async () => {
    const {
      WebConsoleProductionActivationError,
      assertWebConsoleProductionActivation,
    } = await import('../../../src/web-console/index.js');

    expect(() => assertWebConsoleProductionActivation({
      activationProfile: SHARED_HOSTED_PROFILE,
      storageBackend: 'postgres',
      enableAccountAllowlistRoutes: false,
      readiness: {
        securityInvalidationProcessorReady: true,
        portfolioSyncWorkerReady: true,
      },
      stores: { customStore: Object.create(null) as unknown },
      services: {
        authStorage: productionAdapter(),
        secretEncryption: productionAdapter(),
        protectedCorrelationRateLimiter: productionAdapter(),
        protectedCorrelationRateLimitStore: productionAdapter(),
        oauthGrantRevocationService: productionAdapter(),
        accountInviteIssuer: productionAdapter(),
        githubIntegrationProvider: productionAdapter(),
        integrationPublicBaseUrl: TEST_PUBLIC_BASE_URL,
      },
    })).toThrow(WebConsoleProductionActivationError);
    try {
      assertWebConsoleProductionActivation({
        activationProfile: SHARED_HOSTED_PROFILE,
        storageBackend: 'postgres',
        enableAccountAllowlistRoutes: false,
        readiness: {
          securityInvalidationProcessorReady: true,
          portfolioSyncWorkerReady: true,
        },
        stores: { customStore: Object.create(null) as unknown },
        services: {
          authStorage: productionAdapter(),
          secretEncryption: productionAdapter(),
          protectedCorrelationRateLimiter: productionAdapter(),
          protectedCorrelationRateLimitStore: productionAdapter(),
          oauthGrantRevocationService: productionAdapter(),
          accountInviteIssuer: productionAdapter(),
          githubIntegrationProvider: productionAdapter(),
          integrationPublicBaseUrl: TEST_PUBLIC_BASE_URL,
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(WebConsoleProductionActivationError);
      expect(error).toMatchObject({
        failures: [expect.objectContaining({ code: 'customStore_not_production_ready' })],
      });
    }
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
    container.seed('UserConfigStore', { load: jest.fn(), save: jest.fn() });
    container.seed('SigningKeyStore', new InMemorySigningKeyStore());
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
      expect.objectContaining({ moduleId: 'integrations' }),
      expect.objectContaining({ moduleId: 'operations' }),
      expect.objectContaining({ moduleId: 'audit' }),
      expect.objectContaining({ moduleId: 'portfolio' }),
      expect.objectContaining({ moduleId: 'selfSecurity' }),
    ]));
    expect(composition.sessionStore.constructor.name).toBe('PostgresConsoleSessionStore');
    expect(composition.loginTransactionStore.constructor.name).toBe('PostgresLoginTransactionStore');
    expect(composition.idempotencyStore.constructor.name).toBe('PostgresIdempotencyStore');
    expect(composition.factorStore.constructor.name).toBe('PostgresConsoleFactorStore');
    expect(composition.accountAdminStore.constructor.name).toBe('PostgresConsoleAccountAdminStore');
    expect(composition.accountAllowlistStore.constructor.name).toBe('PostgresConsoleAccountAllowlistStore');
    expect(composition.integrationStore.constructor.name).toBe('PostgresUserIntegrationStore');
    expect(composition.portfolioStore.constructor.name).toBe('InMemoryPortfolioElementStore');
    expect(composition.runtimeSessionControlStore.constructor.name).toBe('PostgresRuntimeSessionControlStore');
    expect(composition.identityResolver.constructor.name).toBe('PostgresConsoleIdentityResolver');
    expect(composition.adminAuditQuery.constructor.name).toBe('PostgresAdminAuditQuery');
  });

  it('fails clearly when PostgreSQL self-service settings lacks UserConfigStore', async () => {
    const container = new TestContainer();
    container.seed('SystemDatabaseInstance', {});
    container.seed('AuditHmacResolver', { resolve: jest.fn() });
    container.seed('LifecycleService', { registerPeriodicTask: jest.fn() });
    const { WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    await expect(new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 17),
      reportCleanupError: jest.fn(),
    }).bootstrapAndRegister(container)).rejects.toThrow('UserConfigStore');
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
