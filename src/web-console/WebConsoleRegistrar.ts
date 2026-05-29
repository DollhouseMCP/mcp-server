import type { DiContainerFacade } from '../di/DiContainerFacade.js';
import type { DatabaseInstance } from '../database/connection.js';
import type { IAuthStorageLayer } from '../auth/embedded-as/storage/IAuthStorageLayer.js';
import { InMemoryAdminAuditWriter } from './audit/InMemoryAdminAuditWriter.js';
import { PostgresAdminAuditWriter, type AdminAuditHmacKeyResolver } from './audit/PostgresAdminAuditWriter.js';
import { InMemoryConsoleIdentityResolver } from './identity/InMemoryConsoleIdentityResolver.js';
import { ConsoleStoreCleanupScheduler } from './lifecycle/ConsoleStoreCleanupScheduler.js';
import type { ConsoleStoreCleanupError } from './lifecycle/ConsoleStoreCleanupScheduler.js';
import type { IConsoleOpaqueValueService } from './security/ConsoleOpaqueValues.js';
import { HmacConsoleOpaqueValueService } from './security/ConsoleOpaqueValues.js';
import type { AeadSecretKey, ISecretEncryptionService } from './security/SecretEncryption.js';
import { AeadSecretEncryptionService } from './security/SecretEncryption.js';
import type { IAdminAuditWriter } from './audit/IAdminAuditWriter.js';
import type { IConsoleIdentityResolver } from './identity/IConsoleIdentityResolver.js';
import { ConsoleModuleRegistry } from './platform/ConsoleModuleRegistry.js';
import type { IConsoleSessionStore } from './stores/IConsoleSessionStore.js';
import { InMemoryConsoleSessionStore } from './stores/InMemoryConsoleSessionStore.js';
import type { IIdempotencyStore } from './stores/IIdempotencyStore.js';
import { InMemoryIdempotencyStore } from './stores/InMemoryIdempotencyStore.js';
import type { ILoginTransactionStore } from './stores/ILoginTransactionStore.js';
import { InMemoryLoginTransactionStore } from './stores/InMemoryLoginTransactionStore.js';
import type { IConsoleFactorStore } from './stores/IConsoleFactorStore.js';
import type { IConsoleAccountAdminStore } from './stores/IConsoleAccountAdminStore.js';
import type { IConsoleAccountAllowlistStore } from './stores/IConsoleAccountAllowlistStore.js';
import type { IConsoleSecurityInvalidationStore } from './services/invalidation/IConsoleSecurityInvalidationStore.js';
import type { IOAuthGrantRevocationService } from './services/oauth/IConsoleOAuthGrantRevocationService.js';
import type { IRuntimeSessionControlStore } from './services/runtime/IRuntimeSessionControlStore.js';
import type { IUserConfigStore } from '../storage/userConfig/IUserConfigStore.js';
import { InMemoryUserConfigStore } from '../storage/userConfig/InMemoryUserConfigStore.js';
import { InMemoryConsoleAccountAdminStore } from './stores/InMemoryConsoleAccountAdminStore.js';
import { InMemoryConsoleAccountAllowlistStore } from './stores/InMemoryConsoleAccountAllowlistStore.js';
import { InMemoryConsoleSecurityInvalidationStore } from './services/invalidation/InMemoryConsoleSecurityInvalidationStore.js';
import { InMemoryRuntimeSessionControlStore } from './services/runtime/InMemoryRuntimeSessionControlStore.js';
import { createAccountAdminModule } from './modules/account-admin/AccountAdminModule.js';
import { createHealthModule, type HealthReadinessChecks } from './modules/health/index.js';
import { createRuntimeSessionModule } from './modules/runtime-sessions/RuntimeSessionModule.js';
import { createSelfServiceModule } from './modules/self-service/SelfServiceModule.js';
import { createSelfSecurityModule } from './modules/self-security/SelfSecurityModule.js';
import type { IConsoleAccountInviteIssuer } from './modules/account-admin/AccountAdminInviteService.js';
import {
  InMemoryAccountAdminMutationTransactionRunner,
  PostgresAccountAdminMutationTransactionRunner,
  type IAccountAdminMutationTransactionRunner,
} from './modules/account-admin/AccountAdminMutationTransaction.js';
import type { IRateLimitStore } from '../auth/embedded-as/storage/IRateLimitStore.js';
import { ConsoleProtectedCorrelationRateLimiter } from './services/rate-limit/ConsoleProtectedCorrelationRateLimiter.js';

export const WEB_CONSOLE_SERVICE_NAMES = {
  composition: 'WebConsoleComposition',
  moduleRegistry: 'WebConsoleModuleRegistry',
  sessionStore: 'WebConsoleSessionStore',
  loginTransactionStore: 'WebConsoleLoginTransactionStore',
  idempotencyStore: 'WebConsoleIdempotencyStore',
  factorStore: 'WebConsoleFactorStore',
  accountAdminStore: 'WebConsoleAccountAdminStore',
  accountAllowlistStore: 'WebConsoleAccountAllowlistStore',
  securityInvalidationStore: 'WebConsoleSecurityInvalidationStore',
  runtimeSessionControlStore: 'WebConsoleRuntimeSessionControlStore',
  identityResolver: 'WebConsoleIdentityResolver',
  opaqueValues: 'WebConsoleOpaqueValueService',
  secretEncryption: 'WebConsoleSecretEncryptionService',
  adminAuditWriter: 'WebConsoleAdminAuditWriter',
  accountAdminMutationTransactionRunner: 'WebConsoleAccountAdminMutationTransactionRunner',
  protectedCorrelationRateLimiter: 'WebConsoleProtectedCorrelationRateLimiter',
  oauthGrantRevocationService: 'WebConsoleOAuthGrantRevocationService',
  authStorage: 'WebConsoleAuthStorage',
  accountInviteIssuer: 'WebConsoleAccountInviteIssuer',
  userConfigStore: 'WebConsoleUserConfigStore',
  cleanupScheduler: 'WebConsoleStoreCleanupScheduler',
} as const;

export interface WebConsoleRegistrarOptions {
  readonly opaqueValueHmacKey?: Buffer;
  readonly registerCleanup?: boolean;
  readonly cleanupIntervalMs?: number;
  readonly now?: () => Date;
  readonly reportCleanupError?: (error: ConsoleStoreCleanupError) => void;
  readonly secretEncryptionKey?: AeadSecretKey;
  readonly retainedSecretEncryptionKeys?: readonly AeadSecretKey[];
  readonly protectedCorrelationSelectorHmacKey?: Buffer;
  readonly oauthGrantRevocationService?: IOAuthGrantRevocationService | null;
  readonly authStorage?: IAuthStorageLayer | null;
  readonly accountInviteIssuer?: IConsoleAccountInviteIssuer | null;
  readonly enableAccountAllowlistRoutes?: boolean;
  readonly runtimeTerminationAcknowledgementTimeoutMs?: number;
}

export interface WebConsoleComposition {
  readonly registry: ConsoleModuleRegistry;
  readonly sessionStore: IConsoleSessionStore;
  readonly loginTransactionStore: ILoginTransactionStore;
  readonly idempotencyStore: IIdempotencyStore;
  readonly factorStore: IConsoleFactorStore;
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly accountAllowlistStore: IConsoleAccountAllowlistStore;
  readonly securityInvalidationStore: IConsoleSecurityInvalidationStore;
  readonly runtimeSessionControlStore: IRuntimeSessionControlStore;
  readonly identityResolver: IConsoleIdentityResolver;
  readonly opaqueValues: IConsoleOpaqueValueService;
  readonly secretEncryption: ISecretEncryptionService | null;
  readonly adminAuditWriter: IAdminAuditWriter;
  readonly accountAdminMutationTransactionRunner: IAccountAdminMutationTransactionRunner;
  readonly protectedCorrelationRateLimiter: ConsoleProtectedCorrelationRateLimiter | null;
  readonly oauthGrantRevocationService: IOAuthGrantRevocationService | null;
  readonly authStorage: IAuthStorageLayer | null;
  readonly accountInviteIssuer: IConsoleAccountInviteIssuer | null;
  readonly userConfigStore: IUserConfigStore;
  readonly cleanupScheduler: ConsoleStoreCleanupScheduler | null;
  readonly storageBackend: 'memory' | 'postgres';
  readonly routesMounted: false;
}

export class WebConsoleRegistrar {
  constructor(private readonly options: WebConsoleRegistrarOptions = {}) {}

  async bootstrapAndRegister(container: DiContainerFacade): Promise<WebConsoleComposition> {
    const database = resolveConsoleDatabase(container);
    const stores = await createConsoleStores(database);
    const adminAuditWriter = resolveAdminAuditWriter(database, container);
    const accountAdminMutationTransactionRunner = resolveAccountAdminMutationTransactionRunner({
      database,
      container,
      accountAdminStore: stores.accountAdminStore,
      accountAllowlistStore: stores.accountAllowlistStore,
      securityInvalidationStore: stores.securityInvalidationStore,
      adminAuditWriter,
    });
    const registry = new ConsoleModuleRegistry();
    const oauthGrantRevocationService = resolveOAuthGrantRevocationService(container, this.options);
    const authStorage = resolveAuthStorage(container, this.options);
    const accountInviteIssuer = resolveAccountInviteIssuer(container, this.options);
    const userConfigStore = resolveUserConfigStore(database, container);
    registry.register(createHealthModule({
      readiness: createHealthReadinessInputs({
        database,
        stores,
        authStorage,
        routesMounted: false,
      }),
      now: this.options.now,
    }));
    registry.register(createAccountAdminModule({
      accountAdminStore: stores.accountAdminStore,
      accountAllowlistStore: stores.accountAllowlistStore,
      sessionStore: stores.sessionStore,
      authStorage,
      accountInviteIssuer,
      oauthGrantRevocationService,
      runtimeSessionControlStore: stores.runtimeSessionControlStore,
      runtimeTerminationAcknowledgementTimeoutMs: this.options.runtimeTerminationAcknowledgementTimeoutMs,
      accountAdminMutationTransactionRunner,
      enableAccountAllowlistRoutes: this.options.enableAccountAllowlistRoutes === true,
      now: this.options.now,
    }));
    registry.register(createRuntimeSessionModule({
      runtimeStore: stores.runtimeSessionControlStore,
      accountAdminStore: stores.accountAdminStore,
      now: this.options.now,
    }));
    registry.register(createSelfServiceModule({
      accountAdminStore: stores.accountAdminStore,
      userConfigStore,
      now: this.options.now,
    }));
    registry.register(createSelfSecurityModule({
      factorStore: stores.factorStore,
      sessionStore: stores.sessionStore,
      now: this.options.now,
    }));
    const opaqueValues = new HmacConsoleOpaqueValueService(resolveOpaqueValueHmacKey(container, this.options));
    const secretEncryption = resolveSecretEncryption(container, this.options);
    const protectedCorrelationRateLimiter = resolveProtectedCorrelationRateLimiter(container, this.options);
    const cleanupScheduler = this.createCleanupScheduler(stores, container);
    const composition: WebConsoleComposition = {
      registry,
      ...stores,
      opaqueValues,
      secretEncryption,
      adminAuditWriter,
      accountAdminMutationTransactionRunner,
      protectedCorrelationRateLimiter,
      oauthGrantRevocationService,
      authStorage,
      accountInviteIssuer,
      userConfigStore,
      cleanupScheduler,
      storageBackend: database ? 'postgres' : 'memory',
      routesMounted: false,
    };

    container.register(WEB_CONSOLE_SERVICE_NAMES.composition, () => composition);
    container.register(WEB_CONSOLE_SERVICE_NAMES.moduleRegistry, () => registry);
    container.register(WEB_CONSOLE_SERVICE_NAMES.sessionStore, () => stores.sessionStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.loginTransactionStore, () => stores.loginTransactionStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.idempotencyStore, () => stores.idempotencyStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.factorStore, () => stores.factorStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.accountAdminStore, () => stores.accountAdminStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.accountAllowlistStore, () => stores.accountAllowlistStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.securityInvalidationStore, () => stores.securityInvalidationStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.runtimeSessionControlStore, () => stores.runtimeSessionControlStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.identityResolver, () => stores.identityResolver);
    container.register(WEB_CONSOLE_SERVICE_NAMES.opaqueValues, () => opaqueValues);
    if (secretEncryption) {
      container.register(WEB_CONSOLE_SERVICE_NAMES.secretEncryption, () => secretEncryption);
    }
    container.register(WEB_CONSOLE_SERVICE_NAMES.adminAuditWriter, () => adminAuditWriter);
    container.register(
      WEB_CONSOLE_SERVICE_NAMES.accountAdminMutationTransactionRunner,
      () => accountAdminMutationTransactionRunner,
    );
    if (protectedCorrelationRateLimiter) {
      container.register(
        WEB_CONSOLE_SERVICE_NAMES.protectedCorrelationRateLimiter,
        () => protectedCorrelationRateLimiter,
      );
    }
    if (oauthGrantRevocationService && !container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.oauthGrantRevocationService)) {
      container.register(WEB_CONSOLE_SERVICE_NAMES.oauthGrantRevocationService, () => oauthGrantRevocationService);
    }
    if (authStorage && !container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.authStorage)) {
      container.register(WEB_CONSOLE_SERVICE_NAMES.authStorage, () => authStorage);
    }
    if (accountInviteIssuer && !container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.accountInviteIssuer)) {
      container.register(WEB_CONSOLE_SERVICE_NAMES.accountInviteIssuer, () => accountInviteIssuer);
    }
    if (!container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.userConfigStore)) {
      container.register(WEB_CONSOLE_SERVICE_NAMES.userConfigStore, () => userConfigStore);
    }
    if (cleanupScheduler) {
      container.register(WEB_CONSOLE_SERVICE_NAMES.cleanupScheduler, () => cleanupScheduler);
    }

    return composition;
  }

  private createCleanupScheduler(
    stores: Pick<WebConsoleComposition,
      'sessionStore' | 'loginTransactionStore' | 'idempotencyStore' | 'runtimeSessionControlStore'
    >,
    container: DiContainerFacade,
  ): ConsoleStoreCleanupScheduler | null {
    if (this.options.registerCleanup === false) return null;
    const reportError = this.options.reportCleanupError;
    if (!reportError) {
      throw new Error('Web console cleanup registration requires reportCleanupError');
    }
    if (!container.hasRegistration('LifecycleService')) {
      throw new Error('Web console cleanup registration requires LifecycleService');
    }
    const scheduler = new ConsoleStoreCleanupScheduler({
      stores,
      intervalMs: this.options.cleanupIntervalMs,
      now: this.options.now,
      reportError,
    });
    scheduler.register(container.resolve('LifecycleService'));
    return scheduler;
  }
}

interface ConsoleStoreSet {
  readonly sessionStore: IConsoleSessionStore;
  readonly loginTransactionStore: ILoginTransactionStore;
  readonly idempotencyStore: IIdempotencyStore;
  readonly factorStore: IConsoleFactorStore;
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly accountAllowlistStore: IConsoleAccountAllowlistStore;
  readonly securityInvalidationStore: IConsoleSecurityInvalidationStore;
  readonly runtimeSessionControlStore: IRuntimeSessionControlStore;
  readonly identityResolver: IConsoleIdentityResolver;
}

function createHealthReadinessInputs(options: {
  readonly database: DatabaseInstance | undefined;
  readonly stores: ConsoleStoreSet;
  readonly authStorage: IAuthStorageLayer | null;
  readonly routesMounted: false;
}): HealthReadinessChecks {
  return {
    sessionStorageAvailable: () => Boolean(options.stores.sessionStore),
    identityResolutionAvailable: () => Boolean(options.stores.identityResolver),
    // TODO(web-console-readiness): replace this stub when the security
    // invalidation processor/listener/cursor readiness runtime is wired.
    securityInvalidationReady: () => false,
    runtimeControlAvailable: () => Boolean(options.stores.runtimeSessionControlStore),
    databaseAvailable: () => Boolean(options.database),
    authServerAvailable: () => Boolean(options.authStorage),
    // TODO(web-console-mount): flip through the M7 production mount gate.
    apiV1Mounted: () => options.routesMounted,
  };
}

async function createConsoleStores(database: DatabaseInstance | undefined): Promise<ConsoleStoreSet> {
  if (database) {
    const [
      { PostgresConsoleSessionStore },
      { PostgresLoginTransactionStore },
      { PostgresIdempotencyStore },
      { PostgresConsoleFactorStore },
      { PostgresConsoleAccountAdminStore },
      { PostgresConsoleAccountAllowlistStore },
      { PostgresConsoleSecurityInvalidationStore },
      { PostgresRuntimeSessionControlStore },
      { PostgresConsoleIdentityResolver },
    ] = await Promise.all([
      import('./stores/PostgresConsoleSessionStore.js'),
      import('./stores/PostgresLoginTransactionStore.js'),
      import('./stores/PostgresIdempotencyStore.js'),
      import('./stores/PostgresConsoleFactorStore.js'),
      import('./stores/PostgresConsoleAccountAdminStore.js'),
      import('./stores/PostgresConsoleAccountAllowlistStore.js'),
      import('./services/invalidation/PostgresConsoleSecurityInvalidationStore.js'),
      import('./services/runtime/PostgresRuntimeSessionControlStore.js'),
      import('./identity/PostgresConsoleIdentityResolver.js'),
    ]);
    return {
      sessionStore: new PostgresConsoleSessionStore(database),
      loginTransactionStore: new PostgresLoginTransactionStore(database),
      idempotencyStore: new PostgresIdempotencyStore(database),
      factorStore: new PostgresConsoleFactorStore(database),
      accountAdminStore: new PostgresConsoleAccountAdminStore(database),
      accountAllowlistStore: new PostgresConsoleAccountAllowlistStore(database),
      securityInvalidationStore: new PostgresConsoleSecurityInvalidationStore(database),
      runtimeSessionControlStore: new PostgresRuntimeSessionControlStore(database),
      identityResolver: new PostgresConsoleIdentityResolver(database),
    };
  }
  const { InMemoryConsoleFactorStore } = await import('./stores/InMemoryConsoleFactorStore.js');
  return {
    sessionStore: new InMemoryConsoleSessionStore(),
    loginTransactionStore: new InMemoryLoginTransactionStore(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    factorStore: new InMemoryConsoleFactorStore(),
    accountAdminStore: new InMemoryConsoleAccountAdminStore(),
    accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(),
    securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(),
    runtimeSessionControlStore: new InMemoryRuntimeSessionControlStore(),
    identityResolver: new InMemoryConsoleIdentityResolver(),
  };
}

function resolveConsoleDatabase(container: DiContainerFacade): DatabaseInstance | undefined {
  if (container.hasRegistration('SystemDatabaseInstance')) {
    return container.resolve<DatabaseInstance>('SystemDatabaseInstance');
  }
  if (container.hasRegistration('DatabaseInstance')) {
    return container.resolve<DatabaseInstance>('DatabaseInstance');
  }
  return undefined;
}

function resolveAdminAuditWriter(
  database: DatabaseInstance | undefined,
  container: DiContainerFacade,
): IAdminAuditWriter {
  if (!database) return new InMemoryAdminAuditWriter();
  if (!container.hasRegistration('AuditHmacResolver')) {
    throw new Error('Web console PostgreSQL admin audit requires AuditHmacResolver');
  }
  return new PostgresAdminAuditWriter(database, container.resolve<AdminAuditHmacKeyResolver>('AuditHmacResolver'));
}

function resolveAccountAdminMutationTransactionRunner(options: {
  readonly database: DatabaseInstance | undefined;
  readonly container: DiContainerFacade;
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly accountAllowlistStore: IConsoleAccountAllowlistStore;
  readonly securityInvalidationStore: IConsoleSecurityInvalidationStore;
  readonly adminAuditWriter: IAdminAuditWriter;
}): IAccountAdminMutationTransactionRunner {
  if (options.database) {
    if (!options.container.hasRegistration('AuditHmacResolver')) {
      throw new Error('Web console PostgreSQL account-admin mutation transactions require AuditHmacResolver');
    }
    return new PostgresAccountAdminMutationTransactionRunner({
      db: options.database,
      hmacKeyResolver: options.container.resolve<AdminAuditHmacKeyResolver>('AuditHmacResolver'),
    });
  }
  return new InMemoryAccountAdminMutationTransactionRunner({
    accountAdminStore: options.accountAdminStore,
    accountAllowlistStore: options.accountAllowlistStore,
    securityInvalidationStore: options.securityInvalidationStore,
    adminAuditWriter: options.adminAuditWriter,
  });
}

function resolveOpaqueValueHmacKey(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): Buffer {
  if (options.opaqueValueHmacKey) return Buffer.from(options.opaqueValueHmacKey);
  if (container.hasRegistration('WebConsoleOpaqueValueHmacKey')) {
    return Buffer.from(container.resolve<Buffer>('WebConsoleOpaqueValueHmacKey'));
  }
  throw new Error('Web console composition requires a WebConsoleOpaqueValueHmacKey registration or opaqueValueHmacKey option');
}

function resolveSecretEncryption(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): ISecretEncryptionService | null {
  const key = options.secretEncryptionKey ??
    (container.hasRegistration('WebConsoleSecretEncryptionKey')
      ? container.resolve<AeadSecretKey>('WebConsoleSecretEncryptionKey')
      : null);
  if (!key) return null;
  return new AeadSecretEncryptionService(key, options.retainedSecretEncryptionKeys ?? []);
}

function resolveProtectedCorrelationRateLimiter(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): ConsoleProtectedCorrelationRateLimiter | null {
  const key = options.protectedCorrelationSelectorHmacKey ??
    (container.hasRegistration('WebConsoleProtectedCorrelationSelectorHmacKey')
      ? container.resolve<Buffer>('WebConsoleProtectedCorrelationSelectorHmacKey')
      : null);
  if (!key) return null;
  if (!container.hasRegistration('RateLimitStore')) {
    throw new Error('Web console protected correlation rate limiting requires RateLimitStore');
  }
  return new ConsoleProtectedCorrelationRateLimiter({
    store: container.resolve<IRateLimitStore>('RateLimitStore'),
    selectorHmacKey: Buffer.from(key),
    now: options.now,
  });
}

function resolveUserConfigStore(
  database: DatabaseInstance | undefined,
  container: DiContainerFacade,
): IUserConfigStore {
  if (container.hasRegistration('UserConfigStore')) {
    return container.resolve<IUserConfigStore>('UserConfigStore');
  }
  if (database) {
    throw new Error('Web console PostgreSQL self-service settings require UserConfigStore');
  }
  return new InMemoryUserConfigStore();
}

function resolveOAuthGrantRevocationService(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IOAuthGrantRevocationService | null {
  if (options.oauthGrantRevocationService !== undefined) return options.oauthGrantRevocationService;
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.oauthGrantRevocationService)) {
    return container.resolve<IOAuthGrantRevocationService>(WEB_CONSOLE_SERVICE_NAMES.oauthGrantRevocationService);
  }
  return null;
}

function resolveAuthStorage(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IAuthStorageLayer | null {
  if (options.authStorage !== undefined) return options.authStorage;
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.authStorage)) {
    return container.resolve<IAuthStorageLayer>(WEB_CONSOLE_SERVICE_NAMES.authStorage);
  }
  // Transitional bridge for the embedded AS bootstrap wiring, which still
  // publishes its storage under the legacy container key.
  if (container.hasRegistration('AuthStorage')) {
    return container.resolve<IAuthStorageLayer>('AuthStorage');
  }
  return null;
}

function resolveAccountInviteIssuer(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IConsoleAccountInviteIssuer | null {
  if (options.accountInviteIssuer !== undefined) return options.accountInviteIssuer;
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.accountInviteIssuer)) {
    return container.resolve<IConsoleAccountInviteIssuer>(WEB_CONSOLE_SERVICE_NAMES.accountInviteIssuer);
  }
  return null;
}
