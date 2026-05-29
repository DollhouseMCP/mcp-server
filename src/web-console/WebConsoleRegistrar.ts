import type { DiContainerFacade } from '../di/DiContainerFacade.js';
import type { DatabaseInstance } from '../database/connection.js';
import type { IAuthStorageLayer } from '../auth/embedded-as/storage/IAuthStorageLayer.js';
import type { Gatekeeper } from '../handlers/mcp-aql/Gatekeeper.js';
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
import type { IUserIntegrationStore } from './stores/IUserIntegrationStore.js';
import type { IPortfolioElementStore } from './stores/IPortfolioElementStore.js';
import type { IPortfolioSyncJobStore } from './stores/IPortfolioSyncJobStore.js';
import type { IConsoleSecurityInvalidationStore } from './services/invalidation/IConsoleSecurityInvalidationStore.js';
import type { IOAuthGrantRevocationService } from './services/oauth/IConsoleOAuthGrantRevocationService.js';
import type { IRuntimeSessionControlStore } from './services/runtime/IRuntimeSessionControlStore.js';
import type { IUserConfigStore } from '../storage/userConfig/IUserConfigStore.js';
import type { IOperatorConfigStore } from '../storage/operatorConfig/IOperatorConfigStore.js';
import { InMemoryOperatorConfigStore } from '../storage/operatorConfig/InMemoryOperatorConfigStore.js';
import { PostgresOperatorConfigStore } from '../storage/operatorConfig/PostgresOperatorConfigStore.js';
import { InMemoryUserConfigStore } from '../storage/userConfig/InMemoryUserConfigStore.js';
import { InMemoryConsoleAccountAdminStore } from './stores/InMemoryConsoleAccountAdminStore.js';
import { InMemoryConsoleAccountAllowlistStore } from './stores/InMemoryConsoleAccountAllowlistStore.js';
import { InMemoryUserIntegrationStore } from './stores/InMemoryUserIntegrationStore.js';
import { InMemoryPortfolioElementStore } from './stores/InMemoryPortfolioElementStore.js';
import { InMemoryPortfolioSyncJobStore } from './stores/InMemoryPortfolioSyncJobStore.js';
import { InMemoryConsoleSecurityInvalidationStore } from './services/invalidation/InMemoryConsoleSecurityInvalidationStore.js';
import { InMemoryRuntimeSessionControlStore } from './services/runtime/InMemoryRuntimeSessionControlStore.js';
import type { SessionActivationRegistry } from '../state/SessionActivationState.js';
import {
  InMemorySessionActivationStateAdapter,
  InMemorySessionActivationEventSink,
  RegistrySessionActivationStateAdapter,
  type ISessionActivationEventSink,
  type ISessionActivationStateAdapter,
} from './modules/activations/index.js';
import {
  InMemorySessionApprovalEventSink,
  InMemorySessionApprovalStore,
  GatekeeperSessionApprovalStore,
  createApprovalModule,
  type ISessionApprovalEventSink,
  type SessionApprovalStore,
} from './modules/approvals/index.js';
import {
  InMemoryAdminAuditQuery,
  InMemoryApprovalAuditQuery,
  InMemoryAuthenticationAuditQuery,
  PostgresAdminAuditQuery,
  createAuditModule,
  type IAdminAuditQuery,
  type IApprovalAuditQuery,
  type IAuthenticationAuditQuery,
} from './modules/audit/index.js';
import {
  EmptySessionGatekeeperReader,
  GatekeeperSessionStateReader,
  InMemorySessionExecutionReader,
  createExecutionModule,
  type SessionExecutionReader,
  type SessionGatekeeperReader,
} from './modules/executions/index.js';
import { createAccountAdminModule } from './modules/account-admin/AccountAdminModule.js';
import { createActivationModule } from './modules/activations/index.js';
import { createHealthModule, type HealthReadinessChecks } from './modules/health/index.js';
import type { IGitHubIntegrationProvider } from './modules/integrations/GitHubIntegrationProvider.js';
import { createIntegrationModule } from './modules/integrations/IntegrationModule.js';
import {
  InMemoryConsoleTelemetryQuery,
  createOperationsModule,
  type IConsoleTelemetryQuery,
  type OperationsHealthChecks,
} from './modules/operations/index.js';
import { createPortfolioModule } from './modules/portfolio/PortfolioModule.js';
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
  integrationStore: 'WebConsoleIntegrationStore',
  portfolioStore: 'WebConsolePortfolioStore',
  portfolioSyncJobStore: 'WebConsolePortfolioSyncJobStore',
  securityInvalidationStore: 'WebConsoleSecurityInvalidationStore',
  runtimeSessionControlStore: 'WebConsoleRuntimeSessionControlStore',
  identityResolver: 'WebConsoleIdentityResolver',
  opaqueValues: 'WebConsoleOpaqueValueService',
  secretEncryption: 'WebConsoleSecretEncryptionService',
  adminAuditWriter: 'WebConsoleAdminAuditWriter',
  adminAuditQuery: 'WebConsoleAdminAuditQuery',
  approvalAuditQuery: 'WebConsoleApprovalAuditQuery',
  authenticationAuditQuery: 'WebConsoleAuthenticationAuditQuery',
  accountAdminMutationTransactionRunner: 'WebConsoleAccountAdminMutationTransactionRunner',
  protectedCorrelationRateLimiter: 'WebConsoleProtectedCorrelationRateLimiter',
  sessionActivationStateAdapter: 'WebConsoleSessionActivationStateAdapter',
  sessionActivationEventSink: 'WebConsoleSessionActivationEventSink',
  sessionApprovalStore: 'WebConsoleSessionApprovalStore',
  sessionApprovalEventSink: 'WebConsoleSessionApprovalEventSink',
  sessionExecutionReader: 'WebConsoleSessionExecutionReader',
  sessionGatekeeperReader: 'WebConsoleSessionGatekeeperReader',
  telemetryQuery: 'WebConsoleTelemetryQuery',
  oauthGrantRevocationService: 'WebConsoleOAuthGrantRevocationService',
  authStorage: 'WebConsoleAuthStorage',
  accountInviteIssuer: 'WebConsoleAccountInviteIssuer',
  operatorConfigStore: 'WebConsoleOperatorConfigStore',
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
  readonly githubIntegrationProvider?: IGitHubIntegrationProvider | null;
  readonly portfolioStore?: IPortfolioElementStore | null;
  readonly portfolioSyncJobStore?: IPortfolioSyncJobStore | null;
  readonly approvalStore?: SessionApprovalStore | null;
  readonly approvalEventSink?: ISessionApprovalEventSink | null;
  readonly executionReader?: SessionExecutionReader | null;
  readonly gatekeeperReader?: SessionGatekeeperReader | null;
  readonly telemetryQuery?: IConsoleTelemetryQuery | null;
  readonly operatorConfigStore?: IOperatorConfigStore | null;
  readonly adminAuditQuery?: IAdminAuditQuery | null;
  readonly approvalAuditQuery?: IApprovalAuditQuery | null;
  readonly authenticationAuditQuery?: IAuthenticationAuditQuery | null;
  readonly publicBaseUrl?: string;
}

export interface WebConsoleComposition {
  readonly registry: ConsoleModuleRegistry;
  readonly sessionStore: IConsoleSessionStore;
  readonly loginTransactionStore: ILoginTransactionStore;
  readonly idempotencyStore: IIdempotencyStore;
  readonly factorStore: IConsoleFactorStore;
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly accountAllowlistStore: IConsoleAccountAllowlistStore;
  readonly integrationStore: IUserIntegrationStore;
  readonly portfolioStore: IPortfolioElementStore;
  readonly portfolioSyncJobStore: IPortfolioSyncJobStore;
  readonly securityInvalidationStore: IConsoleSecurityInvalidationStore;
  readonly runtimeSessionControlStore: IRuntimeSessionControlStore;
  readonly identityResolver: IConsoleIdentityResolver;
  readonly opaqueValues: IConsoleOpaqueValueService;
  readonly secretEncryption: ISecretEncryptionService | null;
  readonly adminAuditWriter: IAdminAuditWriter;
  readonly adminAuditQuery: IAdminAuditQuery;
  readonly approvalAuditQuery: IApprovalAuditQuery;
  readonly authenticationAuditQuery: IAuthenticationAuditQuery;
  readonly accountAdminMutationTransactionRunner: IAccountAdminMutationTransactionRunner;
  readonly protectedCorrelationRateLimiter: ConsoleProtectedCorrelationRateLimiter | null;
  readonly sessionActivationStateAdapter: ISessionActivationStateAdapter;
  readonly sessionActivationEventSink: ISessionActivationEventSink;
  readonly sessionApprovalStore: SessionApprovalStore;
  readonly sessionApprovalEventSink: ISessionApprovalEventSink;
  readonly sessionExecutionReader: SessionExecutionReader;
  readonly sessionGatekeeperReader: SessionGatekeeperReader;
  readonly telemetryQuery: IConsoleTelemetryQuery;
  readonly oauthGrantRevocationService: IOAuthGrantRevocationService | null;
  readonly authStorage: IAuthStorageLayer | null;
  readonly accountInviteIssuer: IConsoleAccountInviteIssuer | null;
  readonly operatorConfigStore: IOperatorConfigStore;
  readonly userConfigStore: IUserConfigStore;
  readonly cleanupScheduler: ConsoleStoreCleanupScheduler | null;
  readonly storageBackend: 'memory' | 'postgres';
  readonly routesMounted: false;
}

export class WebConsoleRegistrar {
  constructor(private readonly options: WebConsoleRegistrarOptions = {}) {}

  async bootstrapAndRegister(container: DiContainerFacade): Promise<WebConsoleComposition> {
    const database = resolveConsoleDatabase(container);
    const baseStores = await createConsoleStores(database);
    const stores = {
      ...baseStores,
      portfolioStore: resolvePortfolioElementStore(container, this.options, baseStores.portfolioStore),
      portfolioSyncJobStore: resolvePortfolioSyncJobStore(container, this.options, baseStores.portfolioSyncJobStore),
    };
    const adminAuditWriter = resolveAdminAuditWriter(database, container);
    const adminAuditQuery = resolveAdminAuditQuery(database, container, this.options);
    const approvalAuditQuery = resolveApprovalAuditQuery(container, this.options);
    const authenticationAuditQuery = resolveAuthenticationAuditQuery(container, this.options);
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
    const opaqueValues = new HmacConsoleOpaqueValueService(resolveOpaqueValueHmacKey(container, this.options));
    const secretEncryption = resolveSecretEncryption(container, this.options);
    const githubIntegrationProvider = resolveGitHubIntegrationProvider(container, this.options);
    const integrationPublicBaseUrl = resolveIntegrationPublicBaseUrl(this.options, githubIntegrationProvider);
    const sessionActivationStateAdapter = resolveSessionActivationStateAdapter(container);
    const sessionActivationEventSink = resolveSessionActivationEventSink(container);
    const sessionApprovalStore = resolveSessionApprovalStore(container, this.options);
    const sessionApprovalEventSink = resolveSessionApprovalEventSink(container, this.options);
    const sessionExecutionReader = resolveSessionExecutionReader(container, this.options);
    const sessionGatekeeperReader = resolveSessionGatekeeperReader(container, this.options);
    const telemetryQuery = resolveTelemetryQuery(container, this.options);
    const operatorConfigStore = resolveOperatorConfigStore(database, container, this.options);
    const operationHealthChecks = createOperationHealthChecks({
      database,
      stores,
      authStorage,
      container,
    });
    registry.register(createHealthModule({
      readiness: createHealthReadinessInputs({
        database,
        stores,
        authStorage,
        routesMounted: false,
      }),
      now: this.options.now,
    }));
    registry.register(createAuditModule({
      adminAuditQuery,
      approvalAuditQuery,
      authenticationAuditQuery,
    }));
    registry.register(createOperationsModule({
      healthChecks: operationHealthChecks,
      telemetry: telemetryQuery,
      operatorConfigStore,
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
    registry.register(createActivationModule({
      runtimeStore: stores.runtimeSessionControlStore,
      portfolioStore: stores.portfolioStore,
      activationState: sessionActivationStateAdapter,
      eventSink: sessionActivationEventSink,
      now: this.options.now,
    }));
    registry.register(createApprovalModule({
      runtimeStore: stores.runtimeSessionControlStore,
      approvalStore: sessionApprovalStore,
      eventSink: sessionApprovalEventSink,
      now: this.options.now,
    }));
    registry.register(createExecutionModule({
      runtimeStore: stores.runtimeSessionControlStore,
      executionReader: sessionExecutionReader,
      gatekeeperReader: sessionGatekeeperReader,
      now: this.options.now,
    }));
    registry.register(createIntegrationModule({
      integrationStore: stores.integrationStore,
      loginTransactions: stores.loginTransactionStore,
      opaqueValues,
      secretEncryption,
      githubProvider: githubIntegrationProvider,
      publicBaseUrl: integrationPublicBaseUrl,
      now: this.options.now,
    }));
    registry.register(createPortfolioModule({
      portfolioStore: stores.portfolioStore,
      integrationStore: stores.integrationStore,
      syncJobStore: stores.portfolioSyncJobStore,
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
    const protectedCorrelationRateLimiter = resolveProtectedCorrelationRateLimiter(container, this.options);
    const cleanupScheduler = this.createCleanupScheduler(stores, container);
    const composition: WebConsoleComposition = {
      registry,
      ...stores,
      opaqueValues,
      secretEncryption,
      adminAuditWriter,
      adminAuditQuery,
      approvalAuditQuery,
      authenticationAuditQuery,
      accountAdminMutationTransactionRunner,
      protectedCorrelationRateLimiter,
      sessionActivationStateAdapter,
      sessionActivationEventSink,
      sessionApprovalStore,
      sessionApprovalEventSink,
      sessionExecutionReader,
      sessionGatekeeperReader,
      telemetryQuery,
      oauthGrantRevocationService,
      authStorage,
      accountInviteIssuer,
      operatorConfigStore,
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
    container.register(WEB_CONSOLE_SERVICE_NAMES.integrationStore, () => stores.integrationStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.portfolioStore, () => stores.portfolioStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.portfolioSyncJobStore, () => stores.portfolioSyncJobStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.securityInvalidationStore, () => stores.securityInvalidationStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.runtimeSessionControlStore, () => stores.runtimeSessionControlStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.identityResolver, () => stores.identityResolver);
    container.register(WEB_CONSOLE_SERVICE_NAMES.opaqueValues, () => opaqueValues);
    if (secretEncryption) {
      container.register(WEB_CONSOLE_SERVICE_NAMES.secretEncryption, () => secretEncryption);
    }
    container.register(WEB_CONSOLE_SERVICE_NAMES.adminAuditWriter, () => adminAuditWriter);
    container.register(WEB_CONSOLE_SERVICE_NAMES.adminAuditQuery, () => adminAuditQuery);
    container.register(WEB_CONSOLE_SERVICE_NAMES.approvalAuditQuery, () => approvalAuditQuery);
    container.register(WEB_CONSOLE_SERVICE_NAMES.authenticationAuditQuery, () => authenticationAuditQuery);
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
    container.register(WEB_CONSOLE_SERVICE_NAMES.sessionActivationStateAdapter, () => sessionActivationStateAdapter);
    container.register(WEB_CONSOLE_SERVICE_NAMES.sessionActivationEventSink, () => sessionActivationEventSink);
    container.register(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalStore, () => sessionApprovalStore);
    container.register(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalEventSink, () => sessionApprovalEventSink);
    container.register(WEB_CONSOLE_SERVICE_NAMES.sessionExecutionReader, () => sessionExecutionReader);
    container.register(WEB_CONSOLE_SERVICE_NAMES.sessionGatekeeperReader, () => sessionGatekeeperReader);
    container.register(WEB_CONSOLE_SERVICE_NAMES.telemetryQuery, () => telemetryQuery);
    if (oauthGrantRevocationService && !container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.oauthGrantRevocationService)) {
      container.register(WEB_CONSOLE_SERVICE_NAMES.oauthGrantRevocationService, () => oauthGrantRevocationService);
    }
    if (authStorage && !container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.authStorage)) {
      container.register(WEB_CONSOLE_SERVICE_NAMES.authStorage, () => authStorage);
    }
    if (accountInviteIssuer && !container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.accountInviteIssuer)) {
      container.register(WEB_CONSOLE_SERVICE_NAMES.accountInviteIssuer, () => accountInviteIssuer);
    }
    if (!container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.operatorConfigStore)) {
      container.register(WEB_CONSOLE_SERVICE_NAMES.operatorConfigStore, () => operatorConfigStore);
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
  readonly integrationStore: IUserIntegrationStore;
  readonly portfolioStore: IPortfolioElementStore;
  readonly portfolioSyncJobStore: IPortfolioSyncJobStore;
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

function createOperationHealthChecks(options: {
  readonly database: DatabaseInstance | undefined;
  readonly stores: ConsoleStoreSet;
  readonly authStorage: IAuthStorageLayer | null;
  readonly container: DiContainerFacade;
}): OperationsHealthChecks {
  return {
    database: () => Boolean(options.database),
    authServer: () => Boolean(options.authStorage),
    gatekeeper: () => options.container.hasRegistration('gatekeeper'),
    runtimeControl: () => Boolean(options.stores.runtimeSessionControlStore),
    securityInvalidation: () => ({
      component: 'security_invalidation',
      status: 'not_ready',
      checked_at: new Date(0).toISOString(),
      failure_codes: ['security_invalidation_processor_not_ready'],
    }),
    apiMount: () => ({
      component: 'api_mount',
      status: 'not_ready',
      checked_at: new Date(0).toISOString(),
      failure_codes: ['api_v1_not_mounted'],
    }),
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
      { PostgresUserIntegrationStore },
      { PostgresPortfolioSyncJobStore },
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
      import('./stores/PostgresUserIntegrationStore.js'),
      import('./stores/PostgresPortfolioSyncJobStore.js'),
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
      integrationStore: new PostgresUserIntegrationStore(database),
      portfolioSyncJobStore: new PostgresPortfolioSyncJobStore(database),
      // Portfolio persistence is intentionally behind a typed reader boundary:
      // the production adapter may be filesystem-, database-, or manager-backed.
      // That adapter is deferred while /api/v1 remains unmounted.
      portfolioStore: new InMemoryPortfolioElementStore(),
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
    integrationStore: new InMemoryUserIntegrationStore(),
    portfolioStore: new InMemoryPortfolioElementStore(),
    portfolioSyncJobStore: new InMemoryPortfolioSyncJobStore(),
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

function resolveAdminAuditQuery(
  database: DatabaseInstance | undefined,
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IAdminAuditQuery {
  if (options.adminAuditQuery !== undefined) return options.adminAuditQuery ?? new InMemoryAdminAuditQuery();
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.adminAuditQuery)) {
    return container.resolve<IAdminAuditQuery>(WEB_CONSOLE_SERVICE_NAMES.adminAuditQuery);
  }
  if (database) {
    if (!container.hasRegistration('AuditHmacResolver')) {
      throw new Error('Web console PostgreSQL admin audit query requires AuditHmacResolver');
    }
    return new PostgresAdminAuditQuery(database, container.resolve<AdminAuditHmacKeyResolver>('AuditHmacResolver'));
  }
  return new InMemoryAdminAuditQuery();
}

function resolveApprovalAuditQuery(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IApprovalAuditQuery {
  if (options.approvalAuditQuery !== undefined) {
    return options.approvalAuditQuery ?? new InMemoryApprovalAuditQuery();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.approvalAuditQuery)) {
    return container.resolve<IApprovalAuditQuery>(WEB_CONSOLE_SERVICE_NAMES.approvalAuditQuery);
  }
  return new InMemoryApprovalAuditQuery();
}

function resolveAuthenticationAuditQuery(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IAuthenticationAuditQuery {
  if (options.authenticationAuditQuery !== undefined) {
    return options.authenticationAuditQuery ?? new InMemoryAuthenticationAuditQuery();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.authenticationAuditQuery)) {
    return container.resolve<IAuthenticationAuditQuery>(WEB_CONSOLE_SERVICE_NAMES.authenticationAuditQuery);
  }
  return new InMemoryAuthenticationAuditQuery();
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

function resolveSessionActivationStateAdapter(container: DiContainerFacade): ISessionActivationStateAdapter {
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.sessionActivationStateAdapter)) {
    return container.resolve<ISessionActivationStateAdapter>(
      WEB_CONSOLE_SERVICE_NAMES.sessionActivationStateAdapter,
    );
  }
  if (container.hasRegistration('SessionActivationRegistry')) {
    return new RegistrySessionActivationStateAdapter(
      container.resolve<SessionActivationRegistry>('SessionActivationRegistry'),
    );
  }
  return new InMemorySessionActivationStateAdapter();
}

function resolveSessionActivationEventSink(container: DiContainerFacade): ISessionActivationEventSink {
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.sessionActivationEventSink)) {
    return container.resolve<ISessionActivationEventSink>(
      WEB_CONSOLE_SERVICE_NAMES.sessionActivationEventSink,
    );
  }
  return new InMemorySessionActivationEventSink();
}

function resolveSessionApprovalStore(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): SessionApprovalStore {
  if (options.approvalStore !== undefined) return options.approvalStore ?? new InMemorySessionApprovalStore();
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalStore)) {
    return container.resolve<SessionApprovalStore>(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalStore);
  }
  if (container.hasRegistration('gatekeeper')) {
    return new GatekeeperSessionApprovalStore(container.resolve<Gatekeeper>('gatekeeper'));
  }
  return new InMemorySessionApprovalStore();
}

function resolveSessionApprovalEventSink(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): ISessionApprovalEventSink {
  if (options.approvalEventSink !== undefined) {
    return options.approvalEventSink ?? new InMemorySessionApprovalEventSink();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalEventSink)) {
    return container.resolve<ISessionApprovalEventSink>(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalEventSink);
  }
  return new InMemorySessionApprovalEventSink();
}

function resolveSessionExecutionReader(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): SessionExecutionReader {
  if (options.executionReader !== undefined) {
    return options.executionReader ?? new InMemorySessionExecutionReader();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.sessionExecutionReader)) {
    return container.resolve<SessionExecutionReader>(WEB_CONSOLE_SERVICE_NAMES.sessionExecutionReader);
  }
  return new InMemorySessionExecutionReader();
}

function resolveSessionGatekeeperReader(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): SessionGatekeeperReader {
  if (options.gatekeeperReader !== undefined) {
    return options.gatekeeperReader ?? new EmptySessionGatekeeperReader();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.sessionGatekeeperReader)) {
    return container.resolve<SessionGatekeeperReader>(WEB_CONSOLE_SERVICE_NAMES.sessionGatekeeperReader);
  }
  if (container.hasRegistration('gatekeeper')) {
    return new GatekeeperSessionStateReader(container.resolve<Gatekeeper>('gatekeeper'));
  }
  return new EmptySessionGatekeeperReader();
}

function resolveTelemetryQuery(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IConsoleTelemetryQuery {
  if (options.telemetryQuery !== undefined) {
    return options.telemetryQuery ?? new InMemoryConsoleTelemetryQuery();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.telemetryQuery)) {
    return container.resolve<IConsoleTelemetryQuery>(WEB_CONSOLE_SERVICE_NAMES.telemetryQuery);
  }
  return new InMemoryConsoleTelemetryQuery();
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

function resolveOperatorConfigStore(
  database: DatabaseInstance | undefined,
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IOperatorConfigStore {
  if (options.operatorConfigStore !== undefined) return options.operatorConfigStore ?? new InMemoryOperatorConfigStore();
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.operatorConfigStore)) {
    return container.resolve<IOperatorConfigStore>(WEB_CONSOLE_SERVICE_NAMES.operatorConfigStore);
  }
  if (container.hasRegistration('OperatorConfigStore')) {
    return container.resolve<IOperatorConfigStore>('OperatorConfigStore');
  }
  return database ? new PostgresOperatorConfigStore({ db: database }) : new InMemoryOperatorConfigStore();
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

function resolveGitHubIntegrationProvider(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IGitHubIntegrationProvider | null {
  if (options.githubIntegrationProvider !== undefined) return options.githubIntegrationProvider;
  if (container.hasRegistration('WebConsoleGitHubIntegrationProvider')) {
    return container.resolve<IGitHubIntegrationProvider>('WebConsoleGitHubIntegrationProvider');
  }
  return null;
}

function resolvePortfolioElementStore(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
  fallback: IPortfolioElementStore,
): IPortfolioElementStore {
  if (options.portfolioStore !== undefined) return options.portfolioStore ?? fallback;
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.portfolioStore)) {
    return container.resolve<IPortfolioElementStore>(WEB_CONSOLE_SERVICE_NAMES.portfolioStore);
  }
  return fallback;
}

function resolvePortfolioSyncJobStore(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
  fallback: IPortfolioSyncJobStore,
): IPortfolioSyncJobStore {
  if (options.portfolioSyncJobStore !== undefined) return options.portfolioSyncJobStore ?? fallback;
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.portfolioSyncJobStore)) {
    return container.resolve<IPortfolioSyncJobStore>(WEB_CONSOLE_SERVICE_NAMES.portfolioSyncJobStore);
  }
  return fallback;
}

function resolveIntegrationPublicBaseUrl(
  options: WebConsoleRegistrarOptions,
  githubIntegrationProvider: IGitHubIntegrationProvider | null,
): string | null {
  if (options.publicBaseUrl) return options.publicBaseUrl;
  if (githubIntegrationProvider) {
    throw new Error('Web console GitHub integration provider requires publicBaseUrl');
  }
  return null;
}
