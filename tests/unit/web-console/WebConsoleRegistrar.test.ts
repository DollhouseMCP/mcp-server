import { describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

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
jest.unstable_mockModule('../../../src/web-console/services/invalidation/PostgresConsoleSecurityInvalidationStore.js', () => ({
  appendSecurityInvalidationEventWithTx: jest.fn(),
  PostgresConsoleSecurityInvalidationStore: class PostgresConsoleSecurityInvalidationStore {
    private readonly liveReplicaIds = new Set<string>();
    private readonly cursors = new Map<string, number>();

    constructor(readonly database: unknown) {}

    acquireReplicaLease(input: { readonly replicaId: string }): Promise<void> {
      this.liveReplicaIds.add(input.replicaId);
      return Promise.resolve();
    }

    getReplicaCursor(replicaId: string): Promise<number> {
      return Promise.resolve(this.cursors.get(replicaId) ?? 0);
    }

    recordReplicaCursor(replicaId: string, sequenceId: number): Promise<void> {
      this.cursors.set(replicaId, sequenceId);
      return Promise.resolve();
    }

    listLiveReplicaIds(): Promise<readonly string[]> {
      return Promise.resolve([...this.liveReplicaIds]);
    }

    listEventsAfter(): Promise<readonly unknown[]> {
      return Promise.resolve([]);
    }

    acknowledgeEvent(): Promise<void> {
      return Promise.resolve();
    }
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
class GatekeeperSessionApprovalStore {}
class GatekeeperSessionStateReader {}

function productionAdapter<T>(): T {
  return new ProductionAdapter() as T;
}

function seedCanonicalPortfolioManagers(container: TestContainer): void {
  container.seed('UserIdResolver', () => '018f3d47-73ae-7f10-a0de-0742618d4fb1');
  for (const serviceName of [
    'PersonaManager',
    'SkillManager',
    'TemplateManager',
    'AgentManager',
    'MemoryManager',
    'EnsembleManager',
  ]) {
    container.seed(serviceName, productionAdapter());
  }
}

function productionDatabaseRows() {
  return [
    { databaseName: 'dollhouse_prod', currentUser: 'dollhouse_app' },
  ];
}

function productionRequiredTableRows(tableNames: readonly string[]) {
  return tableNames.map(tableName => ({
    tableName,
  }));
}

function productionActivationServices() {
  return {
    authStorage: productionAdapter(),
    secretEncryption: productionAdapter(),
    protectedCorrelationRateLimiter: productionAdapter(),
    protectedCorrelationRateLimitStore: productionAdapter(),
    oauthGrantRevocationService: productionAdapter(),
    consoleOAuthClient: productionAdapter(),
    accountInviteIssuer: productionAdapter(),
    githubIntegrationProvider: productionAdapter(),
    integrationPublicBaseUrl: TEST_PUBLIC_BASE_URL,
  };
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
      activationProfile: 'development',
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
        moduleId: 'auth',
        path: '/api/v1/auth/login',
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

  it('constructs a production GitHub integration provider from explicit config', async () => {
    const {
      GitHubAppIntegrationProvider,
      WebConsoleRegistrar,
      WEB_CONSOLE_SERVICE_NAMES,
    } = await import('../../../src/web-console/index.js');
    const container = new TestContainer();

    const composition = await new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 251),
      registerCleanup: false,
      publicBaseUrl: TEST_PUBLIC_BASE_URL,
      githubIntegrationProviderConfig: {
        clientId: 'Iv1.test-client',
        clientSecret: 'github-client-secret',
        fetch: jest.fn<typeof fetch>(),
      },
    }).bootstrapAndRegister(container);

    expect(composition.githubIntegrationProvider).toBeInstanceOf(GitHubAppIntegrationProvider);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.githubIntegrationProvider))
      .toBe(composition.githubIntegrationProvider);
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
        expect.objectContaining({ code: 'database_verification_not_ready' }),
        expect.objectContaining({ code: 'security_invalidation_processor_not_ready' }),
        expect.objectContaining({ code: 'portfolio_sync_worker_not_ready' }),
        expect.objectContaining({ code: 'sessionStore_not_production_ready' }),
        expect.objectContaining({ code: 'authStorage_missing' }),
        expect.objectContaining({ code: 'secretEncryption_missing' }),
        expect.objectContaining({ code: 'consoleOAuthClient_missing' }),
        expect.objectContaining({ code: 'integrationPublicBaseUrl_missing' }),
        expect.objectContaining({ code: 'accountAdmin_accountInviteIssuer_missing' }),
        expect.objectContaining({ code: 'accountAdmin_oauthGrantRevocationService_missing' }),
        expect.objectContaining({ code: 'accountAdmin_protectedCorrelationRateLimiter_missing' }),
        expect.objectContaining({ code: 'integrations_githubIntegrationProvider_missing' }),
      ]),
    });
  });

  it('derives hosted/shared activation from exposed multi-user deployment signal', async () => {
    const { WebConsoleProductionActivationError, WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    await expect(new WebConsoleRegistrar({
      deploymentSignal: {
        httpHost: '0.0.0.0',
        authMethods: ['github'],
      },
      opaqueValueHmacKey: Buffer.alloc(32, 31),
      registerCleanup: false,
    }).bootstrapAndRegister(new TestContainer())).rejects.toBeInstanceOf(WebConsoleProductionActivationError);
    await expect(new WebConsoleRegistrar({
      activationProfile: 'development',
      deploymentSignal: {
        httpHost: '0.0.0.0',
        authMethods: ['local-password'],
      },
      opaqueValueHmacKey: Buffer.alloc(32, 31),
      registerCleanup: false,
    }).bootstrapAndRegister(new TestContainer())).rejects.toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({ code: 'database_required' }),
      ]),
    });
  });

  it('proves the full-surface hosted/shared production dependency inventory can close locally', async () => {
    const container = new TestContainer();
    const {
      WEB_CONSOLE_PRODUCTION_REQUIRED_TABLES,
      WebConsoleRegistrar,
      WEB_CONSOLE_SERVICE_NAMES,
    } = await import('../../../src/web-console/index.js');
    const database = {
      execute: jest.fn()
        .mockResolvedValueOnce(productionDatabaseRows())
        .mockResolvedValueOnce(productionRequiredTableRows(WEB_CONSOLE_PRODUCTION_REQUIRED_TABLES)),
    };
    container.seed('SystemDatabaseInstance', database);
    container.seed('AuditHmacResolver', { resolve: jest.fn() });
    container.seed('UserConfigStore', productionAdapter());
    container.seed('SigningKeyStore', productionAdapter());
    container.seed('RateLimitStore', productionAdapter());
    container.seed('LifecycleService', { registerPeriodicTask: jest.fn() });
    container.seed('WebConsoleAccountAllowlistAuthorityCutoverComplete', true);
    seedCanonicalPortfolioManagers(container);

    const composition = await new WebConsoleRegistrar({
      activationProfile: SHARED_HOSTED_PROFILE,
      enableApiV1Mount: true,
      enableAccountAllowlistRoutes: true,
      requireExplicitProductionAdapterMetadata: true,
      productionDatabaseVerification: {
        expectedDatabaseName: 'dollhouse_prod',
        expectedCurrentUser: 'dollhouse_app',
      },
      opaqueValueHmacKey: Buffer.alloc(32, 45),
      protectedCorrelationSelectorHmacKey: Buffer.alloc(32, 46),
      secretEncryptionKey: {
        keyId: 'prod-key',
        key: Buffer.alloc(32, 47),
      },
      authStorage: productionAdapter(),
      githubIntegrationProviderConfig: {
        clientId: 'github-client-id',
        clientSecret: 'github-client-secret',
      },
      publicBaseUrl: TEST_PUBLIC_BASE_URL,
      registerCleanup: false,
    }).bootstrapAndRegister(container);

    expect(composition.storageBackend).toBe('postgres');
    expect(composition.routesMounted).toBe(false);
    expect(composition.apiV1Mount).not.toBeNull();
    expect(composition.consoleOAuthClient?.constructor.name).toBe('EmbeddedAsConsoleOAuthClient');
    expect(composition.githubIntegrationProvider?.constructor.name).toBe('GitHubAppIntegrationProvider');
    expect(composition.accountInviteIssuer?.constructor.name).toBe('PostgresConsoleAccountInviteIssuer');
    expect(composition.oauthGrantRevocationService?.constructor.name)
      .toBe('ConsoleOAuthGrantRevocationService');
    expect(composition.portfolioSyncWorker?.isRunning()).toBe(true);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.githubIntegrationProvider))
      .toBe(composition.githubIntegrationProvider);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.apiV1Mount)).toBe(composition.apiV1Mount);
    expect(database.execute).toHaveBeenCalledTimes(2);
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
    container.seed('WebConsoleAccountAllowlistAuthorityCutoverComplete', true);
    const lifecycle = { registerPeriodicTask: jest.fn() };
    container.seed('LifecycleService', lifecycle);
    const {
      productionDatabaseReady,
      WebConsoleRegistrar,
      WEB_CONSOLE_SERVICE_NAMES,
    } = await import('../../../src/web-console/index.js');

    const composition = await new WebConsoleRegistrar({
      activationProfile: SHARED_HOSTED_PROFILE,
      enableApiV1Mount: true,
      enableAccountAllowlistRoutes: true,
      productionDatabaseReadiness: productionDatabaseReady(),
      securityInvalidationReplicaId: 'replica-a',
      portfolioSyncWorkerId: 'portfolio-worker-a',
      opaqueValueHmacKey: Buffer.alloc(32, 27),
      protectedCorrelationSelectorHmacKey: Buffer.alloc(32, 28),
      secretEncryptionKey: {
        keyId: 'prod-key',
        key: Buffer.alloc(32, 29),
      },
      authStorage: productionAdapter(),
      consoleOAuthClient: productionAdapter(),
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
    expect(composition.oauthGrantRevocationService?.constructor.name)
      .toBe('ConsoleOAuthGrantRevocationService');
    expect(composition.accountInviteIssuer?.constructor.name)
      .toBe('PostgresConsoleAccountInviteIssuer');
    expect(composition.routesMounted).toBe(false);
    expect(composition.apiV1Mount).not.toBeNull();
    expect(composition.securityInvalidationProcessor).not.toBeNull();
    expect(composition.portfolioSyncWorker?.isRunning()).toBe(true);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.securityInvalidationProcessor))
      .toBe(composition.securityInvalidationProcessor);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.portfolioSyncWorker))
      .toBe(composition.portfolioSyncWorker);
    await expect(composition.securityInvalidationReadiness.getReadiness()).resolves.toMatchObject({
      ready: true,
      failureCodes: [],
    });
    expect(lifecycle.registerPeriodicTask).toHaveBeenCalledWith(
      5000,
      expect.any(Function),
      'webConsole.securityInvalidationProcessor',
    );
    expect(composition.apiV1Mount?.mounted()).toBe(false);
    expect(container.resolve(WEB_CONSOLE_SERVICE_NAMES.apiV1Mount)).toBe(composition.apiV1Mount);
    composition.apiV1Mount?.markMounted();
    expect(composition.apiV1Mount?.mounted()).toBe(true);
    expect(composition.routesMounted).toBe(true);
  });

  it('serves representative public, self, and admin paths through the dormant mounted router', async () => {
    const container = new TestContainer();
    container.seed('SystemDatabaseInstance', {});
    container.seed('AuditHmacResolver', { resolve: jest.fn() });
    container.seed('UserConfigStore', productionAdapter());
    container.seed('SigningKeyStore', productionAdapter());
    container.seed('RateLimitStore', productionAdapter());
    container.seed('WebConsoleSessionActivationStateAdapter', productionAdapter());
    container.seed('WebConsoleSessionActivationEventSink', productionAdapter());
    container.seed('LifecycleService', { registerPeriodicTask: jest.fn() });
    const { WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    const composition = await new WebConsoleRegistrar({
      activationProfile: SHARED_HOSTED_PROFILE,
      enableApiV1Mount: true,
      productionReadiness: {
        databaseVerificationReady: true,
        portfolioSyncWorkerReady: true,
      },
      securityInvalidationReplicaId: 'replica-a',
      opaqueValueHmacKey: Buffer.alloc(32, 37),
      protectedCorrelationSelectorHmacKey: Buffer.alloc(32, 38),
      secretEncryptionKey: {
        keyId: 'prod-key',
        key: Buffer.alloc(32, 39),
      },
      authStorage: productionAdapter(),
      oauthGrantRevocationService: productionAdapter(),
      consoleOAuthClient: productionAdapter(),
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
      now: () => new Date('2026-05-26T12:00:00.000Z'),
    }).bootstrapAndRegister(container);

    const app = express();
    app.use(composition.apiV1Mount?.router ?? express.Router());
    composition.apiV1Mount?.markMounted();

    await expect(request(app).get('/api/v1/health/ready')).resolves.toMatchObject({
      status: 200,
      body: {
        status: 'ok',
        ready: true,
        checked_at: '2026-05-26T12:00:00.000Z',
      },
    });
    await expect(request(app).get('/api/v1/me/profile')).resolves.toMatchObject({
      status: 401,
      body: expect.objectContaining({ code: 'unauthenticated' }),
    });
    await expect(request(app).get('/api/v1/admin/operate/health')).resolves.toMatchObject({
      status: 401,
      body: expect.objectContaining({ code: 'unauthenticated' }),
    });
  });

  it('uses the deployment-derived replica id when hosted/shared startup omits an explicit one', async () => {
    const container = new TestContainer();
    container.seed('SystemDatabaseInstance', {});
    container.seed('AuditHmacResolver', { resolve: jest.fn() });
    container.seed('UserConfigStore', productionAdapter());
    container.seed('SigningKeyStore', productionAdapter());
    container.seed('RateLimitStore', productionAdapter());
    container.seed('WebConsoleSessionActivationStateAdapter', productionAdapter());
    container.seed('WebConsoleSessionActivationEventSink', productionAdapter());
    container.seed('LifecycleService', { registerPeriodicTask: jest.fn() });
    const { WebConsoleRegistrar } = await import('../../../src/web-console/index.js');

    const composition = await new WebConsoleRegistrar({
      activationProfile: SHARED_HOSTED_PROFILE,
      productionReadiness: {
        databaseVerificationReady: true,
        portfolioSyncWorkerReady: true,
      },
      opaqueValueHmacKey: Buffer.alloc(32, 40),
      protectedCorrelationSelectorHmacKey: Buffer.alloc(32, 41),
      secretEncryptionKey: {
        keyId: 'prod-key',
        key: Buffer.alloc(32, 42),
      },
      authStorage: productionAdapter(),
      oauthGrantRevocationService: productionAdapter(),
      consoleOAuthClient: productionAdapter(),
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

    expect(composition.securityInvalidationProcessor).not.toBeNull();
    await expect(composition.securityInvalidationReadiness.getReadiness()).resolves.toMatchObject({
      ready: true,
      failureCodes: [],
    });
  });

  it('omits selected route modules before hosted/shared production dependency checks', async () => {
    const container = new TestContainer();
    const {
      WEB_CONSOLE_OMITTABLE_ROUTE_MODULE_IDS,
      WEB_CONSOLE_PRODUCTION_REQUIRED_TABLES,
      WebConsoleRegistrar,
    } = await import('../../../src/web-console/index.js');
    const database = {
      execute: jest.fn()
        .mockResolvedValueOnce(productionDatabaseRows())
        .mockResolvedValueOnce(productionRequiredTableRows(WEB_CONSOLE_PRODUCTION_REQUIRED_TABLES)),
    };
    container.seed('SystemDatabaseInstance', database);
    container.seed('AuditHmacResolver', { resolve: jest.fn() });
    container.seed('UserConfigStore', productionAdapter());
    container.seed('SigningKeyStore', productionAdapter());
    container.seed('LifecycleService', { registerPeriodicTask: jest.fn() });

    const composition = await new WebConsoleRegistrar({
      activationProfile: SHARED_HOSTED_PROFILE,
      omittedRouteModuleIds: WEB_CONSOLE_OMITTABLE_ROUTE_MODULE_IDS,
      productionDatabaseVerification: {
        expectedDatabaseName: 'dollhouse_prod',
        expectedCurrentUser: 'dollhouse_app',
      },
      productionReadiness: {
        portfolioSyncWorkerReady: true,
      },
      opaqueValueHmacKey: Buffer.alloc(32, 43),
      secretEncryptionKey: {
        keyId: 'prod-key',
        key: Buffer.alloc(32, 44),
      },
      authStorage: productionAdapter(),
      consoleOAuthClient: productionAdapter(),
      publicBaseUrl: TEST_PUBLIC_BASE_URL,
      registerCleanup: false,
    }).bootstrapAndRegister(container);

    const registeredIds = new Set(composition.registry.createRouteManifest().routes.map(route => route.moduleId));
    expect([...registeredIds].sort()).toEqual(['auth', 'health']);
    expect(composition.apiV1Mount).toBeNull();
    expect(composition.routesMounted).toBe(false);
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
        databaseVerificationReady: true,
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
        consoleOAuthClient: productionAdapter(),
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
          databaseVerificationReady: true,
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
          consoleOAuthClient: productionAdapter(),
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

  it('rejects known process-local Gatekeeper readers during hosted/shared activation', async () => {
    const {
      WebConsoleProductionActivationError,
      assertWebConsoleProductionActivation,
    } = await import('../../../src/web-console/index.js');

    expect(() => assertWebConsoleProductionActivation({
      activationProfile: SHARED_HOSTED_PROFILE,
      storageBackend: 'postgres',
      enableAccountAllowlistRoutes: false,
      readiness: {
        databaseVerificationReady: true,
        securityInvalidationProcessorReady: true,
        portfolioSyncWorkerReady: true,
      },
      stores: {},
      services: {
        ...productionActivationServices(),
        sessionApprovalStore: new GatekeeperSessionApprovalStore(),
        sessionGatekeeperReader: new GatekeeperSessionStateReader(),
      },
    })).toThrow(WebConsoleProductionActivationError);
    try {
      assertWebConsoleProductionActivation({
        activationProfile: SHARED_HOSTED_PROFILE,
        storageBackend: 'postgres',
        enableAccountAllowlistRoutes: false,
        readiness: {
          databaseVerificationReady: true,
          securityInvalidationProcessorReady: true,
          portfolioSyncWorkerReady: true,
        },
        stores: {},
        services: {
          ...productionActivationServices(),
          sessionApprovalStore: new GatekeeperSessionApprovalStore(),
          sessionGatekeeperReader: new GatekeeperSessionStateReader(),
        },
      });
    } catch (error) {
      expect(error).toMatchObject({
        failures: expect.arrayContaining([
          expect.objectContaining({ code: 'sessionApprovalStore_not_production_ready' }),
          expect.objectContaining({ code: 'sessionGatekeeperReader_not_production_ready' }),
        ]),
      });
    }
  });

  it('rejects production route dependencies for registered modules when backends are deferred defaults', async () => {
    const {
      WebConsoleProductionActivationError,
      InMemoryConsoleTelemetryQuery,
      assertWebConsoleProductionActivation,
    } = await import('../../../src/web-console/index.js');

    expect(() => assertWebConsoleProductionActivation({
      activationProfile: SHARED_HOSTED_PROFILE,
      storageBackend: 'postgres',
      enableAccountAllowlistRoutes: false,
      readiness: {
        databaseVerificationReady: true,
        securityInvalidationProcessorReady: true,
        portfolioSyncWorkerReady: true,
      },
      stores: {},
      services: productionActivationServices(),
      registeredRouteModuleIds: ['operations'],
      routeDependencies: [{
        moduleId: 'operations',
        dependencyName: 'telemetryQuery',
        value: new InMemoryConsoleTelemetryQuery(),
        detail: 'operator telemetry routes require a production telemetry query backend.',
      }, {
        moduleId: 'sessionTelemetry',
        dependencyName: 'ownedActivityQuery',
        value: new InMemoryConsoleTelemetryQuery(),
      }],
    })).toThrow(WebConsoleProductionActivationError);
    try {
      assertWebConsoleProductionActivation({
        activationProfile: SHARED_HOSTED_PROFILE,
        storageBackend: 'postgres',
        enableAccountAllowlistRoutes: false,
        readiness: {
          databaseVerificationReady: true,
          securityInvalidationProcessorReady: true,
          portfolioSyncWorkerReady: true,
        },
        stores: {},
        services: productionActivationServices(),
        registeredRouteModuleIds: ['operations'],
        routeDependencies: [{
          moduleId: 'operations',
          dependencyName: 'telemetryQuery',
          value: new InMemoryConsoleTelemetryQuery(),
          detail: 'operator telemetry routes require a production telemetry query backend.',
        }, {
          moduleId: 'sessionTelemetry',
          dependencyName: 'ownedActivityQuery',
          value: new InMemoryConsoleTelemetryQuery(),
        }],
      });
    } catch (error) {
      expect(error).toMatchObject({
        failures: [expect.objectContaining({
          code: 'operations_telemetryQuery_not_production_ready',
          detail: 'operator telemetry routes require a production telemetry query backend.',
        })],
      });
    }
  });

  it('rejects registered route modules without production dependency declarations', async () => {
    const {
      WebConsoleProductionActivationError,
      assertWebConsoleProductionActivation,
    } = await import('../../../src/web-console/index.js');
    const inputs = {
      activationProfile: SHARED_HOSTED_PROFILE,
      storageBackend: 'postgres' as const,
      enableAccountAllowlistRoutes: false,
      readiness: {
        databaseVerificationReady: true,
        securityInvalidationProcessorReady: true,
        portfolioSyncWorkerReady: true,
      },
      stores: {},
      services: productionActivationServices(),
      registeredRouteModuleIds: ['health', 'auth', 'operations'],
      routeDependencies: [],
    };

    expect(() => assertWebConsoleProductionActivation(inputs)).toThrow(WebConsoleProductionActivationError);
    try {
      assertWebConsoleProductionActivation(inputs);
    } catch (error) {
      expect(error).toMatchObject({
        failures: [
          expect.objectContaining({
            code: 'operations_production_dependencies_undeclared',
            detail: 'operations routes are registered without a production dependency declaration; omit the module or declare its production dependencies before hosted/shared activation.',
          }),
        ],
      });
    }
  });

  it('allows globally checked health and auth modules without route dependency declarations', async () => {
    const { assertWebConsoleProductionActivation } = await import('../../../src/web-console/index.js');

    expect(() => assertWebConsoleProductionActivation({
      activationProfile: SHARED_HOSTED_PROFILE,
      storageBackend: 'postgres',
      enableAccountAllowlistRoutes: false,
      readiness: {
        databaseVerificationReady: true,
        securityInvalidationProcessorReady: true,
        portfolioSyncWorkerReady: true,
      },
      stores: {},
      services: productionActivationServices(),
      registeredRouteModuleIds: ['health', 'auth'],
      routeDependencies: [],
    })).not.toThrow();
  });

  it('keeps declared route dependency module ids aligned with registered descriptors', async () => {
    const {
      ConsoleModuleRegistry,
      InMemoryConsoleTelemetryQuery,
      InMemoryOwnedActivityQuery,
      InMemoryOwnedMetricQuery,
      InMemoryPortfolioElementStore,
      InMemoryPortfolioSyncJobStore,
      InMemoryRuntimeSessionControlStore,
      InMemorySessionExecutionReader,
      createAccountAdminModule,
      createActivationModule,
      createAuditModule,
      createExecutionModule,
      createIntegrationModule,
      createOperationsModule,
      createPortfolioModule,
      createRuntimeSessionModule,
      createSecurityAdminModule,
      createSessionTelemetryModule,
      createSelfSecurityModule,
      createSelfServiceModule,
      createApprovalModule,
      createProductionRouteDependencies,
      registeredRouteModuleIds,
    } = await import('../../../src/web-console/index.js');
    const registry = new ConsoleModuleRegistry();
    const runtimeStore = new InMemoryRuntimeSessionControlStore();
    const portfolioStore = new InMemoryPortfolioElementStore();
    registry.register(createAccountAdminModule({
      accountAdminStore: productionAdapter(),
      accountAllowlistStore: productionAdapter(),
      sessionStore: productionAdapter(),
      accountInviteIssuer: productionAdapter(),
      enableAccountAllowlistRoutes: false,
    }));
    registry.register(createActivationModule({
      runtimeStore,
      portfolioStore,
      activationState: productionAdapter(),
    }));
    registry.register(createApprovalModule({
      runtimeStore,
      approvalStore: productionAdapter(),
      eventSink: productionAdapter(),
    }));
    registry.register(createAuditModule({
      adminAuditQuery: productionAdapter(),
      approvalAuditQuery: productionAdapter(),
      authenticationAuditQuery: productionAdapter(),
    }));
    registry.register(createExecutionModule({
      runtimeStore,
      executionReader: new InMemorySessionExecutionReader(),
      gatekeeperReader: productionAdapter(),
    }));
    registry.register(createRuntimeSessionModule({
      runtimeStore,
      accountAdminStore: productionAdapter(),
    }));
    registry.register(createSecurityAdminModule({
      signingKeyStore: productionAdapter(),
      factorStore: productionAdapter(),
      invalidationStore: productionAdapter(),
      authPolicyStore: productionAdapter(),
    }));
    registry.register(createSelfServiceModule({
      accountAdminStore: productionAdapter(),
      userConfigStore: productionAdapter(),
    }));
    registry.register(createSelfSecurityModule({
      factorStore: productionAdapter(),
      sessionStore: productionAdapter(),
    }));
    registry.register(createIntegrationModule({
      integrationStore: productionAdapter(),
      loginTransactions: productionAdapter(),
      opaqueValues: productionAdapter(),
      secretEncryption: productionAdapter(),
      githubProvider: productionAdapter(),
      publicBaseUrl: TEST_PUBLIC_BASE_URL,
    }));
    registry.register(createOperationsModule({
      healthChecks: {
        database: () => true,
        authServer: () => true,
        gatekeeper: () => true,
        runtimeControl: () => true,
        securityInvalidation: () => Promise.resolve({
          component: 'security_invalidation',
          status: 'ok',
          checked_at: new Date(0).toISOString(),
          failure_codes: [],
        }),
        apiMount: () => ({ component: 'api_mount', status: 'ok', checked_at: new Date(0).toISOString(), failure_codes: [] }),
      },
      telemetry: new InMemoryConsoleTelemetryQuery(),
      operatorConfigStore: productionAdapter(),
    }));
    registry.register(createPortfolioModule({
      portfolioStore,
      integrationStore: productionAdapter(),
      syncJobStore: new InMemoryPortfolioSyncJobStore(),
    }));
    registry.register(createSessionTelemetryModule({
      runtimeStore,
      ownedActivityQuery: new InMemoryOwnedActivityQuery(),
      ownedMetricQuery: new InMemoryOwnedMetricQuery(),
    }));

    const registeredIds = new Set(registeredRouteModuleIds(registry));
    const dependencies = createProductionRouteDependencies({
      stores: {
        portfolioStore,
        portfolioSyncJobStore: new InMemoryPortfolioSyncJobStore(),
        accountAdminStore: productionAdapter(),
        accountAllowlistStore: productionAdapter(),
        sessionStore: productionAdapter(),
        loginTransactionStore: productionAdapter(),
        idempotencyStore: productionAdapter(),
        factorStore: productionAdapter(),
        securityInvalidationStore: productionAdapter(),
        runtimeSessionControlStore: runtimeStore,
        identityResolver: productionAdapter(),
      } as Parameters<typeof createProductionRouteDependencies>[0]['stores'],
      services: {
        accountInviteIssuer: productionAdapter(),
        oauthGrantRevocationService: productionAdapter(),
        protectedCorrelationRateLimiter: productionAdapter(),
        protectedCorrelationRateLimitStore: productionAdapter(),
        adminAuditQuery: productionAdapter(),
        approvalAuditQuery: productionAdapter(),
        authenticationAuditQuery: productionAdapter(),
        githubIntegrationProvider: productionAdapter(),
        ownedActivityQuery: new InMemoryOwnedActivityQuery(),
        ownedMetricQuery: new InMemoryOwnedMetricQuery(),
        accountAdminMutationTransactionRunner: productionAdapter(),
        operatorConfigStore: productionAdapter(),
        signingKeyStore: productionAdapter(),
        authPolicyStore: productionAdapter(),
        userConfigStore: productionAdapter(),
        sessionActivationStateAdapter: productionAdapter(),
        sessionActivationEventSink: productionAdapter(),
        sessionApprovalStore: productionAdapter(),
        sessionApprovalEventSink: productionAdapter(),
        sessionExecutionReader: new InMemorySessionExecutionReader(),
        sessionGatekeeperReader: productionAdapter(),
        telemetryQuery: new InMemoryConsoleTelemetryQuery(),
      },
    });

    expect([...new Set(dependencies.map(dependency => dependency.moduleId))].sort()).toEqual(
      [...registeredIds].filter(moduleId => moduleId !== 'health').sort(),
    );
    expect(dependencies.every(dependency => registeredIds.has(dependency.moduleId))).toBe(true);
  });

  it('honors explicit production adapter metadata before constructor-name checks', async () => {
    const {
      WebConsoleProductionActivationError,
      assertWebConsoleProductionActivation,
      markWebConsoleProductionAdapter,
    } = await import('../../../src/web-console/index.js');
    const explicitlyReadyUnknownAdapter = markWebConsoleProductionAdapter(Object.create(null) as object, {
      productionReady: true,
      adapterName: 'ExternallyManagedStore',
    });
    const explicitlyUnsafeAdapter = markWebConsoleProductionAdapter(new ProductionAdapter(), {
      productionReady: false,
      adapterName: 'ProcessLocalStore',
      detail: 'ProcessLocalStore is process-local and cannot serve hosted/shared traffic.',
    });

    expect(() => assertWebConsoleProductionActivation({
      activationProfile: SHARED_HOSTED_PROFILE,
      storageBackend: 'postgres',
      enableAccountAllowlistRoutes: false,
      readiness: {
        databaseVerificationReady: true,
        securityInvalidationProcessorReady: true,
        portfolioSyncWorkerReady: true,
      },
      stores: { explicitlyReadyUnknownAdapter },
      services: {
        ...productionActivationServices(),
        explicitlyUnsafeAdapter,
      },
    })).toThrow(WebConsoleProductionActivationError);
    try {
      assertWebConsoleProductionActivation({
        activationProfile: SHARED_HOSTED_PROFILE,
        storageBackend: 'postgres',
        enableAccountAllowlistRoutes: false,
        readiness: {
          databaseVerificationReady: true,
          securityInvalidationProcessorReady: true,
          portfolioSyncWorkerReady: true,
        },
        stores: { explicitlyReadyUnknownAdapter },
        services: {
          ...productionActivationServices(),
          explicitlyUnsafeAdapter,
        },
      });
    } catch (error) {
      expect(error).toMatchObject({
        failures: [
          expect.objectContaining({
            code: 'explicitlyUnsafeAdapter_not_production_ready',
            detail: 'ProcessLocalStore is process-local and cannot serve hosted/shared traffic.',
          }),
        ],
      });
    }

    expect(() => assertWebConsoleProductionActivation({
      activationProfile: SHARED_HOSTED_PROFILE,
      storageBackend: 'postgres',
      enableAccountAllowlistRoutes: false,
      requireExplicitProductionAdapterMetadata: true,
      readiness: {
        databaseVerificationReady: true,
        securityInvalidationProcessorReady: true,
        portfolioSyncWorkerReady: true,
      },
      stores: { explicitlyReadyUnknownAdapter },
      services: {
        ...productionActivationServices(),
        unmarkedAdapter: new ProductionAdapter(),
      },
    })).toThrow(WebConsoleProductionActivationError);
    try {
      assertWebConsoleProductionActivation({
        activationProfile: SHARED_HOSTED_PROFILE,
        storageBackend: 'postgres',
        enableAccountAllowlistRoutes: false,
        requireExplicitProductionAdapterMetadata: true,
        readiness: {
          databaseVerificationReady: true,
          securityInvalidationProcessorReady: true,
          portfolioSyncWorkerReady: true,
        },
        stores: { explicitlyReadyUnknownAdapter },
        services: {
          ...productionActivationServices(),
          unmarkedAdapter: new ProductionAdapter(),
        },
      });
    } catch (error) {
      expect(error).toMatchObject({
        failures: expect.arrayContaining([
          expect.objectContaining({
            code: 'unmarkedAdapter_metadata_missing',
          }),
        ]),
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
    expect(composition.sessionActivationStateAdapter.constructor.name).toBe('PostgresSessionActivationStateAdapter');
    expect(composition.sessionActivationEventSink.constructor.name).toBe('PostgresSessionActivationEventSink');
    expect(composition.runtimeSessionControlStore.constructor.name).toBe('PostgresRuntimeSessionControlStore');
    expect(composition.sessionExecutionReader.constructor.name).toBe('PostgresSessionExecutionReader');
    expect(composition.telemetryQuery.constructor.name).toBe('PostgresConsoleTelemetryQuery');
    expect(composition.ownedMetricQuery.constructor.name).toBe('PostgresOwnedMetricQuery');
    expect(composition.identityResolver.constructor.name).toBe('PostgresConsoleIdentityResolver');
    expect(composition.adminAuditQuery.constructor.name).toBe('PostgresAdminAuditQuery');
    expect(composition.approvalAuditQuery.constructor.name).toBe('PostgresApprovalAuditQuery');
    expect(composition.authenticationAuditQuery.constructor.name).toBe('PostgresAuthenticationAuditQuery');
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
