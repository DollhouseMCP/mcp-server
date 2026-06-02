import type { DiContainerFacade } from '../di/DiContainerFacade.js';
import type { DatabaseInstance } from '../database/connection.js';
import { env } from '../config/env.js';
import type { Router } from 'express';
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
import { assembleSecuredConsoleRouter } from './platform/ConsoleSecuredRouterAssembler.js';
import type { IConsoleSessionStore } from './stores/IConsoleSessionStore.js';
import { InMemoryConsoleSessionStore } from './stores/InMemoryConsoleSessionStore.js';
import type { IIdempotencyStore } from './stores/IIdempotencyStore.js';
import { InMemoryIdempotencyStore } from './stores/InMemoryIdempotencyStore.js';
import type { ILoginTransactionStore } from './stores/ILoginTransactionStore.js';
import { InMemoryLoginTransactionStore } from './stores/InMemoryLoginTransactionStore.js';
import type { IConsoleFactorStore } from './stores/IConsoleFactorStore.js';
import type { IConsoleAuthPolicyStore } from './stores/IConsoleAuthPolicyStore.js';
import { InMemoryConsoleAuthPolicyStore } from './stores/InMemoryConsoleAuthPolicyStore.js';
import type { IConsoleAccountAdminStore } from './stores/IConsoleAccountAdminStore.js';
import type { IConsoleAccountAllowlistStore } from './stores/IConsoleAccountAllowlistStore.js';
import type { IUserIntegrationStore } from './stores/IUserIntegrationStore.js';
import type { IPortfolioElementStore } from './stores/IPortfolioElementStore.js';
import type { IPortfolioSyncJobStore } from './stores/IPortfolioSyncJobStore.js';
import type { IConsoleSecurityInvalidationStore } from './services/invalidation/IConsoleSecurityInvalidationStore.js';
import {
  ConsoleOAuthGrantRevocationService,
  PostgresConsoleOAuthSubjectResolver,
  type IOAuthGrantRevocationService,
} from './services/oauth/index.js';
import type { IRuntimeSessionControlStore } from './services/runtime/IRuntimeSessionControlStore.js';
import {
  StaticConsoleSecurityInvalidationReadiness,
  StoreBackedConsoleSecurityInvalidationReadiness,
  type IConsoleSecurityInvalidationReadiness,
} from './services/invalidation/ConsoleSecurityInvalidationReadiness.js';
import {
  ConsolePortfolioSyncExecutor,
  ConsolePortfolioSyncWorker,
  type IConsolePortfolioSyncWorker,
  type IPortfolioSyncJobExecutor,
} from './services/portfolio-sync/index.js';
import {
  ConsoleSecurityInvalidationProcessor,
  type IConsoleSecurityInvalidationProcessor,
} from './services/invalidation/ConsoleSecurityInvalidationProcessor.js';
import type { IUserConfigStore } from '../storage/userConfig/IUserConfigStore.js';
import type { IOperatorConfigStore } from '../storage/operatorConfig/IOperatorConfigStore.js';
import { InMemoryOperatorConfigStore } from '../storage/operatorConfig/InMemoryOperatorConfigStore.js';
import { PostgresOperatorConfigStore } from '../storage/operatorConfig/PostgresOperatorConfigStore.js';
import type { ISigningKeyStore } from '../storage/signingKeys/ISigningKeyStore.js';
import { InMemorySigningKeyStore } from '../storage/signingKeys/InMemorySigningKeyStore.js';
import { InMemoryUserConfigStore } from '../storage/userConfig/InMemoryUserConfigStore.js';
import { InMemoryConsoleAccountAdminStore } from './stores/InMemoryConsoleAccountAdminStore.js';
import { InMemoryConsoleAccountAllowlistStore } from './stores/InMemoryConsoleAccountAllowlistStore.js';
import { InMemoryUserIntegrationStore } from './stores/InMemoryUserIntegrationStore.js';
import { InMemoryPortfolioElementStore } from './stores/InMemoryPortfolioElementStore.js';
import {
  ManagerBackedPortfolioElementStore,
  type ManagerBackedPortfolioManagers,
} from './stores/ManagerBackedPortfolioElementStore.js';
import { InMemoryPortfolioSyncJobStore } from './stores/InMemoryPortfolioSyncJobStore.js';
import { InMemoryConsoleSecurityInvalidationStore } from './services/invalidation/InMemoryConsoleSecurityInvalidationStore.js';
import { InMemoryRuntimeSessionControlStore } from './services/runtime/InMemoryRuntimeSessionControlStore.js';
import type { SessionActivationRegistry } from '../state/SessionActivationState.js';
import type { ContextTracker } from '../security/encryption/ContextTracker.js';
import type { UserIdResolver } from '../database/UserContext.js';
import type { IElement } from '../types/elements/IElement.js';
import type { BaseElementManager } from '../elements/base/BaseElementManager.js';
import { DatabaseConfirmationStore } from '../state/DatabaseConfirmationStore.js';
import {
  InMemorySessionActivationStateAdapter,
  InMemorySessionActivationEventSink,
  PostgresSessionActivationEventSink,
  PostgresSessionActivationStateAdapter,
  RegistrySessionActivationStateAdapter,
  type ISessionActivationEventSink,
  type ISessionActivationStateAdapter,
} from './modules/activations/index.js';
import {
  InMemorySessionApprovalEventSink,
  InMemorySessionApprovalStore,
  ConfirmationSessionApprovalStore,
  GatekeeperSessionApprovalStore,
  PostgresSessionApprovalEventSink,
  createApprovalModule,
  type ISessionApprovalEventSink,
  type SessionApprovalStore,
} from './modules/approvals/index.js';
import {
  InMemoryAdminAuditQuery,
  InMemoryApprovalAuditQuery,
  InMemoryAuthenticationAuditQuery,
  PostgresAdminAuditQuery,
  PostgresApprovalAuditQuery,
  PostgresAuthenticationAuditQuery,
  createAuditModule,
  type IAdminAuditQuery,
  type IApprovalAuditQuery,
  type IAuthenticationAuditQuery,
} from './modules/audit/index.js';
import {
  EmptySessionGatekeeperReader,
  GatekeeperSessionStateReader,
  InMemorySessionExecutionReader,
  PostgresSessionExecutionReader,
  PostgresSessionGatekeeperReader,
  createExecutionModule,
  type SessionExecutionReader,
  type SessionGatekeeperReader,
} from './modules/executions/index.js';
import { createAccountAdminModule } from './modules/account-admin/AccountAdminModule.js';
import { createActivationModule } from './modules/activations/index.js';
import { createHealthModule, type HealthReadinessChecks } from './modules/health/index.js';
import {
  GitHubAppIntegrationProvider,
  type GitHubAppIntegrationProviderConfig,
} from './modules/integrations/GitHubAppIntegrationProvider.js';
import type { IGitHubIntegrationProvider } from './modules/integrations/GitHubIntegrationProvider.js';
import { createIntegrationModule } from './modules/integrations/IntegrationModule.js';
import {
  InMemoryConsoleTelemetryQuery,
  PostgresConsoleTelemetryQuery,
  createOperationsModule,
  type IConsoleTelemetryQuery,
  type OperationsHealthChecks,
} from './modules/operations/index.js';
import { createPortfolioModule } from './modules/portfolio/PortfolioModule.js';
import { createRuntimeSessionModule } from './modules/runtime-sessions/RuntimeSessionModule.js';
import { createSelfServiceModule } from './modules/self-service/SelfServiceModule.js';
import { createSelfSecurityModule } from './modules/self-security/SelfSecurityModule.js';
import { createSecurityAdminModule } from './modules/security-admin/index.js';
import {
  InMemoryOwnedActivityQuery,
  InMemoryOwnedMetricQuery,
  PostgresOwnedActivityQuery,
  PostgresOwnedMetricQuery,
  createSessionTelemetryModule,
  type IOwnedActivityQuery,
  type IOwnedMetricQuery,
} from './modules/session-telemetry/index.js';
import type { IConsoleAccountInviteIssuer } from './modules/account-admin/AccountAdminInviteService.js';
import { PostgresConsoleAccountInviteIssuer } from './modules/account-admin/PostgresConsoleAccountInviteIssuer.js';
import {
  InMemoryAccountAdminMutationTransactionRunner,
  PostgresAccountAdminMutationTransactionRunner,
  type IAccountAdminMutationTransactionRunner,
} from './modules/account-admin/AccountAdminMutationTransaction.js';
import type { IRateLimitStore } from '../auth/embedded-as/storage/IRateLimitStore.js';
import { ConsoleProtectedCorrelationRateLimiter } from './services/rate-limit/ConsoleProtectedCorrelationRateLimiter.js';
import {
  assertWebConsoleProductionActivation,
  markWebConsoleProductionAdapter,
  type WebConsoleActivationProfile,
  type WebConsoleProductionRouteDependency,
  type WebConsoleProductionReadinessOptions,
} from './WebConsoleProductionActivation.js';
import {
  createPostgresProductionDatabaseReadiness,
  productionDatabaseNotVerified,
  type IProductionDatabaseReadiness,
} from './WebConsoleProductionDatabaseReadiness.js';
import { resolveStableWebConsoleReplicaId, resolveWebConsoleReplicaId } from './WebConsoleReplicaIdentity.js';
import {
  resolveWebConsoleActivationProfile,
  type WebConsoleDeploymentSignal,
} from './WebConsoleActivationProfile.js';
import {
  EmbeddedAsConsoleOAuthClient,
  createConsoleBffAuthModule,
  type IConsoleOAuthClient,
} from './auth/index.js';
import {
  SECURITY_ADMIN_MODULE_ID,
  WEB_CONSOLE_OMITTABLE_ROUTE_MODULE_IDS,
  type WebConsoleOmittableRouteModuleId,
} from './WebConsoleRouteModuleIds.js';

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
  ownedActivityQuery: 'WebConsoleOwnedActivityQuery',
  ownedMetricQuery: 'WebConsoleOwnedMetricQuery',
  oauthGrantRevocationService: 'WebConsoleOAuthGrantRevocationService',
  consoleOAuthClient: 'WebConsoleOAuthClient',
  authStorage: 'WebConsoleAuthStorage',
  accountInviteIssuer: 'WebConsoleAccountInviteIssuer',
  githubIntegrationProvider: 'WebConsoleGitHubIntegrationProvider',
  productionDatabaseReadiness: 'WebConsoleProductionDatabaseReadiness',
  operatorConfigStore: 'WebConsoleOperatorConfigStore',
  signingKeyStore: 'WebConsoleSigningKeyStore',
  authPolicyStore: 'WebConsoleAuthPolicyStore',
  userConfigStore: 'WebConsoleUserConfigStore',
  securityInvalidationReadiness: 'WebConsoleSecurityInvalidationReadiness',
  securityInvalidationProcessor: 'WebConsoleSecurityInvalidationProcessor',
  portfolioSyncWorker: 'WebConsolePortfolioSyncWorker',
  apiV1Mount: 'WebConsoleApiV1Mount',
  cleanupScheduler: 'WebConsoleStoreCleanupScheduler',
} as const;

export { WEB_CONSOLE_OMITTABLE_ROUTE_MODULE_IDS, type WebConsoleOmittableRouteModuleId };

export interface WebConsoleRegistrarOptions {
  readonly activationProfile?: WebConsoleActivationProfile;
  readonly deploymentSignal?: WebConsoleDeploymentSignal;
  readonly productionReadiness?: WebConsoleProductionReadinessOptions;
  readonly productionDatabaseReadiness?: IProductionDatabaseReadiness | null;
  readonly productionDatabaseVerification?: {
    readonly expectedDatabaseName: string;
    readonly expectedCurrentUser?: string;
  };
  readonly requireExplicitProductionAdapterMetadata?: boolean;
  readonly omittedRouteModuleIds?: readonly WebConsoleOmittableRouteModuleId[];
  readonly opaqueValueHmacKey?: Buffer;
  readonly registerCleanup?: boolean;
  readonly cleanupIntervalMs?: number;
  readonly now?: () => Date;
  readonly reportCleanupError?: (error: ConsoleStoreCleanupError) => void;
  readonly secretEncryptionKey?: AeadSecretKey;
  readonly retainedSecretEncryptionKeys?: readonly AeadSecretKey[];
  readonly protectedCorrelationSelectorHmacKey?: Buffer;
  readonly oauthGrantRevocationService?: IOAuthGrantRevocationService | null;
  readonly consoleOAuthClient?: IConsoleOAuthClient | null;
  readonly authStorage?: IAuthStorageLayer | null;
  readonly accountInviteIssuer?: IConsoleAccountInviteIssuer | null;
  readonly enableAccountAllowlistRoutes?: boolean;
  readonly runtimeTerminationAcknowledgementTimeoutMs?: number;
  readonly githubIntegrationProvider?: IGitHubIntegrationProvider | null;
  readonly githubIntegrationProviderConfig?: GitHubAppIntegrationProviderConfig | null;
  readonly portfolioStore?: IPortfolioElementStore | null;
  readonly enableManagerBackedPortfolioStore?: boolean;
  readonly enablePortfolioWriteRoutes?: boolean;
  readonly portfolioSyncJobStore?: IPortfolioSyncJobStore | null;
  readonly portfolioSyncWorker?: IConsolePortfolioSyncWorker | null;
  readonly portfolioSyncJobExecutor?: IPortfolioSyncJobExecutor | null;
  readonly portfolioSyncRepositoryName?: string;
  readonly portfolioSyncWorkerId?: string;
  readonly portfolioSyncWorkerIntervalMs?: number;
  readonly portfolioSyncWorkerLeaseDurationMs?: number;
  readonly portfolioSyncWorkerBatchSize?: number;
  readonly reportPortfolioSyncWorkerError?: (error: unknown) => void;
  readonly approvalStore?: SessionApprovalStore | null;
  readonly approvalEventSink?: ISessionApprovalEventSink | null;
  readonly executionReader?: SessionExecutionReader | null;
  readonly gatekeeperReader?: SessionGatekeeperReader | null;
  readonly telemetryQuery?: IConsoleTelemetryQuery | null;
  readonly ownedActivityQuery?: IOwnedActivityQuery | null;
  readonly ownedMetricQuery?: IOwnedMetricQuery | null;
  readonly operatorConfigStore?: IOperatorConfigStore | null;
  readonly signingKeyStore?: ISigningKeyStore | null;
  readonly authPolicyStore?: IConsoleAuthPolicyStore | null;
  readonly adminAuditQuery?: IAdminAuditQuery | null;
  readonly approvalAuditQuery?: IApprovalAuditQuery | null;
  readonly authenticationAuditQuery?: IAuthenticationAuditQuery | null;
  readonly securityInvalidationReadiness?: IConsoleSecurityInvalidationReadiness | null;
  readonly securityInvalidationReplicaId?: string;
  readonly securityInvalidationProcessorIntervalMs?: number;
  readonly securityInvalidationProcessorLeaseDurationMs?: number;
  readonly securityInvalidationProcessorBatchSize?: number;
  readonly securityInvalidationInitialDrainMaxEvents?: number;
  readonly reportSecurityInvalidationProcessorError?: (error: unknown) => void;
  readonly publicBaseUrl?: string;
  readonly enableApiV1Mount?: boolean;
  readonly consoleOrigin?: string;
  readonly consoleSessionIdleTimeoutMs?: number;
  readonly reportApiV1InternalError?: (error: unknown, correlationId: string) => void;
}

export interface WebConsoleApiV1Mount {
  readonly router: Router;
  readonly mounted: () => boolean;
  readonly markMounted: () => void;
}

export interface WebConsoleComposition {
  readonly activationProfile: WebConsoleActivationProfile;
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
  readonly ownedActivityQuery: IOwnedActivityQuery;
  readonly ownedMetricQuery: IOwnedMetricQuery;
  readonly oauthGrantRevocationService: IOAuthGrantRevocationService | null;
  readonly consoleOAuthClient: IConsoleOAuthClient | null;
  readonly authStorage: IAuthStorageLayer | null;
  readonly accountInviteIssuer: IConsoleAccountInviteIssuer | null;
  readonly githubIntegrationProvider: IGitHubIntegrationProvider | null;
  readonly operatorConfigStore: IOperatorConfigStore;
  readonly signingKeyStore: ISigningKeyStore;
  readonly authPolicyStore: IConsoleAuthPolicyStore;
  readonly userConfigStore: IUserConfigStore;
  readonly securityInvalidationReadiness: IConsoleSecurityInvalidationReadiness;
  readonly securityInvalidationProcessor: IConsoleSecurityInvalidationProcessor | null;
  readonly portfolioSyncWorker: IConsolePortfolioSyncWorker | null;
  readonly apiV1Mount: WebConsoleApiV1Mount | null;
  readonly cleanupScheduler: ConsoleStoreCleanupScheduler | null;
  readonly storageBackend: 'memory' | 'postgres';
  readonly routesMounted: boolean;
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
    const approvalAuditQuery = resolveApprovalAuditQuery(database, container, this.options);
    const authenticationAuditQuery = resolveAuthenticationAuditQuery(database, container, this.options);
    const accountAdminMutationTransactionRunner = resolveAccountAdminMutationTransactionRunner({
      database,
      container,
      accountAdminStore: stores.accountAdminStore,
      accountAllowlistStore: stores.accountAllowlistStore,
      securityInvalidationStore: stores.securityInvalidationStore,
      adminAuditWriter,
    });
    const registry = new ConsoleModuleRegistry();
    const consoleOAuthClient = resolveConsoleOAuthClient(container, this.options);
    const authStorage = resolveAuthStorage(container, this.options);
    const oauthGrantRevocationService = resolveOAuthGrantRevocationService({
      container,
      options: this.options,
      database,
      authStorage,
    });
    const userConfigStore = resolveUserConfigStore(database, container);
    const opaqueValues = new HmacConsoleOpaqueValueService(resolveOpaqueValueHmacKey(container, this.options));
    const secretEncryption = resolveSecretEncryption(container, this.options);
    const githubIntegrationProvider = resolveGitHubIntegrationProvider(container, this.options);
    const integrationPublicBaseUrl = resolveIntegrationPublicBaseUrl(this.options, githubIntegrationProvider);
    const sessionActivationStateAdapter = resolveSessionActivationStateAdapter(container, database, this.options);
    const sessionActivationEventSink = resolveSessionActivationEventSink(container, database);
    const sessionApprovalStore = resolveSessionApprovalStore(container, database, this.options);
    const sessionApprovalEventSink = resolveSessionApprovalEventSink(container, database, this.options);
    const sessionExecutionReader = resolveSessionExecutionReader(container, database, this.options);
    const sessionGatekeeperReader = resolveSessionGatekeeperReader(container, database, this.options);
    const telemetryQuery = resolveTelemetryQuery(container, database, this.options);
    const ownedActivityQuery = resolveOwnedActivityQuery(container, database, this.options);
    const ownedMetricQuery = resolveOwnedMetricQuery(container, database, this.options);
    const operatorConfigStore = resolveOperatorConfigStore(database, container, this.options);
    const signingKeyStore = resolveSigningKeyStore(database, container, this.options);
    const accountInviteIssuer = resolveAccountInviteIssuer({
      container,
      options: this.options,
      database,
      signingKeyStore,
      publicBaseUrl: integrationPublicBaseUrl,
    });
    const authPolicyStore = await resolveAuthPolicyStore(database, container, this.options);
    const activationProfile = resolveWebConsoleActivationProfile({
      activationProfile: this.options.activationProfile,
      deploymentSignal: this.options.deploymentSignal,
    });
    const securityInvalidationRuntime = await resolveSecurityInvalidationRuntime({
      activationProfile,
      container,
      options: this.options,
      stores,
      storageBackend: database ? 'postgres' : 'memory',
    });
    const securityInvalidationReadiness = securityInvalidationRuntime.readiness;
    const portfolioSyncWorker = resolvePortfolioSyncWorker({
      activationProfile,
      container,
      options: this.options,
      stores,
      secretEncryption,
      storageBackend: database ? 'postgres' : 'memory',
    });
    const productionReadiness = await resolveProductionReadinessForActivation(
      activationProfile,
      securityInvalidationReadiness,
      portfolioSyncWorker,
      this.options,
      container,
      database,
    );
    const apiV1MountState = createApiV1MountState();
    const operationHealthChecks = createOperationHealthChecks({
      database,
      stores,
      authStorage,
      container,
      securityInvalidationReadiness,
      routesMounted: apiV1MountState.mounted,
    });
    registry.register(createHealthModule({
      readiness: createHealthReadinessInputs({
        database,
        stores,
        authStorage,
        securityInvalidationReadiness,
        routesMounted: apiV1MountState.mounted,
      }),
      now: this.options.now,
    }));
    if (consoleOAuthClient && secretEncryption && integrationPublicBaseUrl) {
      registry.register(createConsoleBffAuthModule({
        oauthClient: consoleOAuthClient,
        loginTransactions: stores.loginTransactionStore,
        sessionStore: stores.sessionStore,
        identityResolver: stores.identityResolver,
        opaqueValues,
        secretEncryption,
        publicBaseUrl: integrationPublicBaseUrl,
        now: this.options.now,
      }));
    }
    registerRouteModule(registry, this.options, 'audit', () => createAuditModule({
      adminAuditQuery,
      approvalAuditQuery,
      authenticationAuditQuery,
    }));
    registerRouteModule(registry, this.options, 'operations', () => createOperationsModule({
      healthChecks: operationHealthChecks,
      telemetry: telemetryQuery,
      operatorConfigStore,
      now: this.options.now,
    }));
    registerRouteModule(registry, this.options, SECURITY_ADMIN_MODULE_ID, () => createSecurityAdminModule({
      signingKeyStore,
      factorStore: stores.factorStore,
      invalidationStore: stores.securityInvalidationStore,
      authPolicyStore,
      now: this.options.now,
    }));
    registerRouteModule(registry, this.options, 'accountAdmin', () => createAccountAdminModule({
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
    registerRouteModule(registry, this.options, 'runtimeSessions', () => createRuntimeSessionModule({
      runtimeStore: stores.runtimeSessionControlStore,
      accountAdminStore: stores.accountAdminStore,
      now: this.options.now,
    }));
    registerRouteModule(registry, this.options, 'activations', () => createActivationModule({
      runtimeStore: stores.runtimeSessionControlStore,
      portfolioStore: stores.portfolioStore,
      activationState: sessionActivationStateAdapter,
      eventSink: sessionActivationEventSink,
      now: this.options.now,
    }));
    registerRouteModule(registry, this.options, 'approvals', () => createApprovalModule({
      runtimeStore: stores.runtimeSessionControlStore,
      approvalStore: sessionApprovalStore,
      eventSink: sessionApprovalEventSink,
      now: this.options.now,
    }));
    registerRouteModule(registry, this.options, 'executions', () => createExecutionModule({
      runtimeStore: stores.runtimeSessionControlStore,
      executionReader: sessionExecutionReader,
      gatekeeperReader: sessionGatekeeperReader,
      now: this.options.now,
    }));
    registerRouteModule(registry, this.options, 'session-telemetry', () => createSessionTelemetryModule({
      runtimeStore: stores.runtimeSessionControlStore,
      ownedActivityQuery,
      ownedMetricQuery,
      now: this.options.now,
    }));
    registerRouteModule(registry, this.options, 'integrations', () => createIntegrationModule({
      integrationStore: stores.integrationStore,
      loginTransactions: stores.loginTransactionStore,
      opaqueValues,
      secretEncryption,
      githubProvider: githubIntegrationProvider,
      publicBaseUrl: integrationPublicBaseUrl,
      now: this.options.now,
    }));
    registerRouteModule(registry, this.options, 'portfolio', () => createPortfolioModule({
      portfolioStore: stores.portfolioStore,
      integrationStore: stores.integrationStore,
      syncJobStore: stores.portfolioSyncJobStore,
      enablePortfolioWriteRoutes: this.options.enablePortfolioWriteRoutes === true,
      now: this.options.now,
    }));
    registerRouteModule(registry, this.options, 'selfService', () => createSelfServiceModule({
      accountAdminStore: stores.accountAdminStore,
      userConfigStore,
      now: this.options.now,
    }));
    registerRouteModule(registry, this.options, 'selfSecurity', () => createSelfSecurityModule({
      factorStore: stores.factorStore,
      sessionStore: stores.sessionStore,
      now: this.options.now,
    }));
    const protectedCorrelationRateLimiter = resolveProtectedCorrelationRateLimiter(container, this.options);
    const protectedCorrelationRateLimitStore = resolveRateLimitStore(container);
    assertWebConsoleProductionActivation({
      activationProfile,
      storageBackend: database ? 'postgres' : 'memory',
      enableAccountAllowlistRoutes: this.options.enableAccountAllowlistRoutes === true,
      requireExplicitProductionAdapterMetadata: this.options.requireExplicitProductionAdapterMetadata === true,
      readiness: productionReadiness,
      stores: createProductionCoreStores(stores),
      registeredRouteModuleIds: registeredRouteModuleIds(registry),
      routeDependencies: createProductionRouteDependencies({
        stores,
        services: {
          accountInviteIssuer,
          oauthGrantRevocationService,
          protectedCorrelationRateLimiter,
          protectedCorrelationRateLimitStore,
          adminAuditQuery,
          approvalAuditQuery,
          authenticationAuditQuery,
          githubIntegrationProvider,
          ownedActivityQuery,
          ownedMetricQuery,
          accountAdminMutationTransactionRunner,
          operatorConfigStore,
          signingKeyStore,
          authPolicyStore,
          userConfigStore,
          sessionActivationStateAdapter,
          sessionActivationEventSink,
          sessionApprovalStore,
          sessionApprovalEventSink,
          sessionExecutionReader,
          sessionGatekeeperReader,
          telemetryQuery,
        },
      }),
      services: {
        authStorage,
        secretEncryption,
        consoleOAuthClient,
        integrationPublicBaseUrl,
        adminAuditWriter,
        authPolicyStore,
      },
    });
    const apiV1Mount = createApiV1Mount({
      activationProfile,
      options: this.options,
      registry,
      sessionStore: stores.sessionStore,
      identityResolver: stores.identityResolver,
      opaqueValues,
      integrationPublicBaseUrl,
      adminAuditWriter,
      idempotencyStore: stores.idempotencyStore,
      authPolicyStore,
      protectedCorrelationRateLimiter,
      apiV1MountState,
      userContext: resolveConsoleUserContext(container),
    });
    const cleanupScheduler = this.createCleanupScheduler(stores, container);
    const composition: WebConsoleComposition = {
      activationProfile,
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
      ownedActivityQuery,
      ownedMetricQuery,
      oauthGrantRevocationService,
      consoleOAuthClient,
      authStorage,
      accountInviteIssuer,
      githubIntegrationProvider,
      operatorConfigStore,
      signingKeyStore,
      authPolicyStore,
      userConfigStore,
      securityInvalidationReadiness,
      securityInvalidationProcessor: securityInvalidationRuntime.processor,
      portfolioSyncWorker,
      apiV1Mount,
      cleanupScheduler,
      storageBackend: database ? 'postgres' : 'memory',
      get routesMounted() {
        return apiV1MountState.mounted();
      },
    };

    registerWebConsoleCompositionServices(container, composition);

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

export function registeredRouteModuleIds(registry: ConsoleModuleRegistry): readonly string[] {
  return [...new Set(registry.createRouteManifest().routes.map(route => route.moduleId))];
}

function registerRouteModule(
  registry: ConsoleModuleRegistry,
  options: WebConsoleRegistrarOptions,
  moduleId: WebConsoleOmittableRouteModuleId,
  createModule: () => Parameters<ConsoleModuleRegistry['register']>[0],
): void {
  if (isRouteModuleOmitted(options, moduleId)) return;
  registry.register(createModule());
}

function isRouteModuleOmitted(
  options: Pick<WebConsoleRegistrarOptions, 'omittedRouteModuleIds'>,
  moduleId: WebConsoleOmittableRouteModuleId,
): boolean {
  return new Set(options.omittedRouteModuleIds ?? []).has(moduleId);
}

function createProductionCoreStores(stores: ConsoleStoreSet): Readonly<Record<string, unknown>> {
  return {
    sessionStore: stores.sessionStore,
    loginTransactionStore: stores.loginTransactionStore,
    idempotencyStore: stores.idempotencyStore,
    securityInvalidationStore: stores.securityInvalidationStore,
    identityResolver: stores.identityResolver,
  };
}

export function createProductionRouteDependencies(options: {
  readonly stores: ConsoleStoreSet;
  readonly services: {
    readonly accountInviteIssuer: IConsoleAccountInviteIssuer | null;
    readonly oauthGrantRevocationService: IOAuthGrantRevocationService | null;
    readonly protectedCorrelationRateLimiter: ConsoleProtectedCorrelationRateLimiter | null;
    readonly protectedCorrelationRateLimitStore: IRateLimitStore | null;
    readonly adminAuditQuery: IAdminAuditQuery;
    readonly approvalAuditQuery: IApprovalAuditQuery;
    readonly authenticationAuditQuery: IAuthenticationAuditQuery;
    readonly githubIntegrationProvider: IGitHubIntegrationProvider | null;
    readonly ownedActivityQuery: IOwnedActivityQuery;
    readonly ownedMetricQuery: IOwnedMetricQuery;
    readonly accountAdminMutationTransactionRunner: IAccountAdminMutationTransactionRunner;
    readonly operatorConfigStore: IOperatorConfigStore;
    readonly signingKeyStore: ISigningKeyStore;
    readonly authPolicyStore: IConsoleAuthPolicyStore;
    readonly userConfigStore: IUserConfigStore;
    readonly sessionActivationStateAdapter: ISessionActivationStateAdapter;
    readonly sessionActivationEventSink: ISessionActivationEventSink;
    readonly sessionApprovalStore: SessionApprovalStore;
    readonly sessionApprovalEventSink: ISessionApprovalEventSink;
    readonly sessionExecutionReader: SessionExecutionReader;
    readonly sessionGatekeeperReader: SessionGatekeeperReader;
    readonly telemetryQuery: IConsoleTelemetryQuery;
  };
}): readonly WebConsoleProductionRouteDependency[] {
  return [
    routeDependency('accountAdmin', 'accountAdminStore', options.stores.accountAdminStore,
      'accountAdmin routes require production account administration persistence or must be omitted before hosted/shared mount.'),
    routeDependency('accountAdmin', 'accountAllowlistStore', options.stores.accountAllowlistStore,
      'accountAdmin allowlist routes require production account allowlist persistence or must be omitted before hosted/shared mount.'),
    routeDependency('accountAdmin', 'accountAdminMutationTransactionRunner', options.services.accountAdminMutationTransactionRunner,
      'accountAdmin mutation routes require a production transaction runner or must be omitted before hosted/shared mount.'),
    routeDependency('accountAdmin', 'accountInviteIssuer', options.services.accountInviteIssuer,
      'accountAdmin invite routes require a production invite issuer or must be omitted before hosted/shared mount.'),
    routeDependency('accountAdmin', 'oauthGrantRevocationService', options.services.oauthGrantRevocationService,
      'accountAdmin credential revocation routes require a production OAuth grant revocation service or must be omitted before hosted/shared mount.'),
    routeDependency('accountAdmin', 'protectedCorrelationRateLimiter', options.services.protectedCorrelationRateLimiter,
      'accountAdmin protected correlation routes require a production protected-correlation rate limiter or must be omitted before hosted/shared mount.'),
    routeDependency('accountAdmin', 'protectedCorrelationRateLimitStore', options.services.protectedCorrelationRateLimitStore,
      'accountAdmin protected correlation routes require a production rate-limit store or must be omitted before hosted/shared mount.'),
    routeDependency('runtimeSessions', 'runtimeSessionControlStore', options.stores.runtimeSessionControlStore,
      'runtime session routes require production runtime-control persistence or must be omitted before hosted/shared mount.'),
    routeDependency('runtimeSessions', 'accountAdminStore', options.stores.accountAdminStore,
      'runtime session account projections require production account administration persistence or must be omitted before hosted/shared mount.'),
    routeDependency('selfService', 'accountAdminStore', options.stores.accountAdminStore,
      'self-service profile routes require production account administration persistence or must be omitted before hosted/shared mount.'),
    routeDependency('selfService', 'userConfigStore', options.services.userConfigStore,
      'self-service settings routes require production user configuration persistence or must be omitted before hosted/shared mount.'),
    routeDependency('selfSecurity', 'factorStore', options.stores.factorStore,
      'self-security factor routes require production factor persistence or must be omitted before hosted/shared mount.'),
    routeDependency('selfSecurity', 'sessionStore', options.stores.sessionStore,
      'self-security session routes require production console-session persistence or must be omitted before hosted/shared mount.'),
    routeDependency(SECURITY_ADMIN_MODULE_ID, 'signingKeyStore', options.services.signingKeyStore,
      'security-admin signing-key routes require production signing-key persistence or must be omitted before hosted/shared mount.'),
    routeDependency(SECURITY_ADMIN_MODULE_ID, 'factorStore', options.stores.factorStore,
      'security-admin factor routes require production factor persistence or must be omitted before hosted/shared mount.'),
    routeDependency(SECURITY_ADMIN_MODULE_ID, 'authPolicyStore', options.services.authPolicyStore,
      'security-admin auth-policy routes require production auth-policy persistence or must be omitted before hosted/shared mount.'),
    routeDependency('activations', 'portfolioStore', options.stores.portfolioStore,
      'activation routes require production portfolio persistence or must be omitted before hosted/shared mount.'),
    routeDependency('activations', 'runtimeSessionControlStore', options.stores.runtimeSessionControlStore,
      'activation routes require production runtime-control persistence or must be omitted before hosted/shared mount.'),
    routeDependency('activations', 'sessionActivationStateAdapter', options.services.sessionActivationStateAdapter,
      'activation routes require a production activation-state adapter or must be omitted before hosted/shared mount.'),
    routeDependency('activations', 'sessionActivationEventSink', options.services.sessionActivationEventSink,
      'activation routes require a production activation-event sink or must be omitted before hosted/shared mount.'),
    routeDependency('approvals', 'runtimeSessionControlStore', options.stores.runtimeSessionControlStore,
      'approval routes require production runtime-control persistence or must be omitted before hosted/shared mount.'),
    routeDependency('approvals', 'sessionApprovalStore', options.services.sessionApprovalStore,
      'approval routes require a production approval store or must be omitted before hosted/shared mount.'),
    routeDependency('approvals', 'sessionApprovalEventSink', options.services.sessionApprovalEventSink,
      'approval routes require a production approval-event sink or must be omitted before hosted/shared mount.'),
    routeDependency('audit', 'adminAuditQuery', options.services.adminAuditQuery,
      'audit routes require a production admin-audit query backend or must be omitted before hosted/shared mount.'),
    routeDependency('audit', 'approvalAuditQuery', options.services.approvalAuditQuery,
      'audit approval routes require a production approval-audit query backend or must be omitted before hosted/shared mount.'),
    routeDependency('audit', 'authenticationAuditQuery', options.services.authenticationAuditQuery,
      'audit authentication routes require a production authentication-audit query backend or must be omitted before hosted/shared mount.'),
    routeDependency('executions', 'sessionExecutionReader', options.services.sessionExecutionReader,
      'execution routes require a production execution-state reader or must be omitted before hosted/shared mount.'),
    routeDependency('executions', 'sessionGatekeeperReader', options.services.sessionGatekeeperReader,
      'Gatekeeper execution routes require a production live Gatekeeper reader or must be omitted before hosted/shared mount.'),
    routeDependency('integrations', 'integrationStore', options.stores.integrationStore,
      'integration routes require production user-integration persistence or must be omitted before hosted/shared mount.'),
    routeDependency('integrations', 'githubIntegrationProvider', options.services.githubIntegrationProvider,
      'a configured GitHub integration provider must be a production adapter; absence is allowed and disables only GitHub linking.',
      true),
    routeDependency('operations', 'telemetryQuery', options.services.telemetryQuery,
      'operator telemetry routes require a production telemetry query backend or must be omitted before hosted/shared mount.'),
    routeDependency('operations', 'operatorConfigStore', options.services.operatorConfigStore,
      'operator configuration routes require production operator configuration persistence or must be omitted before hosted/shared mount.'),
    routeDependency('portfolio', 'portfolioStore', options.stores.portfolioStore,
      'portfolio routes require production portfolio persistence or must be omitted before hosted/shared mount.'),
    routeDependency('portfolio', 'integrationStore', options.stores.integrationStore,
      'portfolio sync routes require production user-integration persistence or must be omitted before hosted/shared mount.'),
    routeDependency('portfolio', 'portfolioSyncJobStore', options.stores.portfolioSyncJobStore,
      'portfolio sync routes require production sync-job persistence or must be omitted before hosted/shared mount.'),
    routeDependency('session-telemetry', 'ownedActivityQuery', options.services.ownedActivityQuery,
      'owned session log routes require a production activity query backend or must be omitted before hosted/shared mount.'),
    routeDependency('session-telemetry', 'ownedMetricQuery', options.services.ownedMetricQuery,
      'owned session metric routes require a production metric query backend or must be omitted before hosted/shared mount.'),
  ];
}

function routeDependency(
  moduleId: string,
  dependencyName: string,
  value: unknown,
  detail: string,
  optional = false,
): WebConsoleProductionRouteDependency {
  return {
    moduleId,
    dependencyName,
    value,
    detail,
    optional,
  };
}

function registerIfMissing<T>(container: DiContainerFacade, name: string, factory: () => T): void {
  if (!container.hasRegistration(name)) {
    container.register(name, factory);
  }
}

function registerWebConsoleCompositionServices(
  container: DiContainerFacade,
  composition: WebConsoleComposition,
): void {
  container.register(WEB_CONSOLE_SERVICE_NAMES.composition, () => composition);
  container.register(WEB_CONSOLE_SERVICE_NAMES.moduleRegistry, () => composition.registry);
  container.register(WEB_CONSOLE_SERVICE_NAMES.sessionStore, () => composition.sessionStore);
  container.register(WEB_CONSOLE_SERVICE_NAMES.loginTransactionStore, () => composition.loginTransactionStore);
  container.register(WEB_CONSOLE_SERVICE_NAMES.idempotencyStore, () => composition.idempotencyStore);
  container.register(WEB_CONSOLE_SERVICE_NAMES.factorStore, () => composition.factorStore);
  container.register(WEB_CONSOLE_SERVICE_NAMES.accountAdminStore, () => composition.accountAdminStore);
  container.register(WEB_CONSOLE_SERVICE_NAMES.accountAllowlistStore, () => composition.accountAllowlistStore);
  container.register(WEB_CONSOLE_SERVICE_NAMES.integrationStore, () => composition.integrationStore);
  container.register(WEB_CONSOLE_SERVICE_NAMES.portfolioStore, () => composition.portfolioStore);
  container.register(WEB_CONSOLE_SERVICE_NAMES.portfolioSyncJobStore, () => composition.portfolioSyncJobStore);
  container.register(WEB_CONSOLE_SERVICE_NAMES.securityInvalidationStore, () => composition.securityInvalidationStore);
  container.register(WEB_CONSOLE_SERVICE_NAMES.runtimeSessionControlStore, () => composition.runtimeSessionControlStore);
  container.register(WEB_CONSOLE_SERVICE_NAMES.identityResolver, () => composition.identityResolver);
  container.register(WEB_CONSOLE_SERVICE_NAMES.opaqueValues, () => composition.opaqueValues);
  if (composition.secretEncryption) {
    container.register(WEB_CONSOLE_SERVICE_NAMES.secretEncryption, () => composition.secretEncryption);
  }
  container.register(WEB_CONSOLE_SERVICE_NAMES.adminAuditWriter, () => composition.adminAuditWriter);
  container.register(WEB_CONSOLE_SERVICE_NAMES.adminAuditQuery, () => composition.adminAuditQuery);
  container.register(WEB_CONSOLE_SERVICE_NAMES.approvalAuditQuery, () => composition.approvalAuditQuery);
  container.register(WEB_CONSOLE_SERVICE_NAMES.authenticationAuditQuery, () => composition.authenticationAuditQuery);
  container.register(
    WEB_CONSOLE_SERVICE_NAMES.accountAdminMutationTransactionRunner,
    () => composition.accountAdminMutationTransactionRunner,
  );
  if (composition.protectedCorrelationRateLimiter) {
    container.register(
      WEB_CONSOLE_SERVICE_NAMES.protectedCorrelationRateLimiter,
      () => composition.protectedCorrelationRateLimiter,
    );
  }
  container.register(WEB_CONSOLE_SERVICE_NAMES.sessionActivationStateAdapter, () => composition.sessionActivationStateAdapter);
  container.register(WEB_CONSOLE_SERVICE_NAMES.sessionActivationEventSink, () => composition.sessionActivationEventSink);
  container.register(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalStore, () => composition.sessionApprovalStore);
  container.register(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalEventSink, () => composition.sessionApprovalEventSink);
  container.register(WEB_CONSOLE_SERVICE_NAMES.sessionExecutionReader, () => composition.sessionExecutionReader);
  container.register(WEB_CONSOLE_SERVICE_NAMES.sessionGatekeeperReader, () => composition.sessionGatekeeperReader);
  container.register(WEB_CONSOLE_SERVICE_NAMES.telemetryQuery, () => composition.telemetryQuery);
  registerOptionalWebConsoleCompositionServices(container, composition);
}

function registerOptionalWebConsoleCompositionServices(
  container: DiContainerFacade,
  composition: WebConsoleComposition,
): void {
  if (composition.oauthGrantRevocationService && !container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.oauthGrantRevocationService)) {
    container.register(WEB_CONSOLE_SERVICE_NAMES.oauthGrantRevocationService, () => composition.oauthGrantRevocationService);
  }
  if (composition.consoleOAuthClient && !container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.consoleOAuthClient)) {
    container.register(WEB_CONSOLE_SERVICE_NAMES.consoleOAuthClient, () => composition.consoleOAuthClient);
  }
  if (composition.authStorage && !container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.authStorage)) {
    container.register(WEB_CONSOLE_SERVICE_NAMES.authStorage, () => composition.authStorage);
  }
  if (composition.accountInviteIssuer && !container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.accountInviteIssuer)) {
    container.register(WEB_CONSOLE_SERVICE_NAMES.accountInviteIssuer, () => composition.accountInviteIssuer);
  }
  if (composition.githubIntegrationProvider && !container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.githubIntegrationProvider)) {
    container.register(WEB_CONSOLE_SERVICE_NAMES.githubIntegrationProvider, () => composition.githubIntegrationProvider);
  }
  registerIfMissing(container, WEB_CONSOLE_SERVICE_NAMES.operatorConfigStore, () => composition.operatorConfigStore);
  registerIfMissing(container, WEB_CONSOLE_SERVICE_NAMES.signingKeyStore, () => composition.signingKeyStore);
  registerIfMissing(container, WEB_CONSOLE_SERVICE_NAMES.authPolicyStore, () => composition.authPolicyStore);
  registerIfMissing(container, WEB_CONSOLE_SERVICE_NAMES.userConfigStore, () => composition.userConfigStore);
  registerIfMissing(
    container,
    WEB_CONSOLE_SERVICE_NAMES.securityInvalidationReadiness,
    () => composition.securityInvalidationReadiness,
  );
  if (composition.securityInvalidationProcessor) {
    registerIfMissing(
      container,
      WEB_CONSOLE_SERVICE_NAMES.securityInvalidationProcessor,
      () => composition.securityInvalidationProcessor,
    );
  }
  if (composition.portfolioSyncWorker) {
    registerIfMissing(
      container,
      WEB_CONSOLE_SERVICE_NAMES.portfolioSyncWorker,
      () => composition.portfolioSyncWorker,
    );
  }
  if (composition.apiV1Mount) {
    container.register(WEB_CONSOLE_SERVICE_NAMES.apiV1Mount, () => composition.apiV1Mount);
  }
  if (composition.cleanupScheduler) {
    container.register(WEB_CONSOLE_SERVICE_NAMES.cleanupScheduler, () => composition.cleanupScheduler);
  }
}

function createApiV1MountState(): Pick<WebConsoleApiV1Mount, 'mounted' | 'markMounted'> {
  let mounted = false;
  return {
    mounted: () => mounted,
    markMounted: () => {
      mounted = true;
    },
  };
}

function createApiV1Mount(options: {
  readonly activationProfile: WebConsoleActivationProfile;
  readonly options: WebConsoleRegistrarOptions;
  readonly registry: ConsoleModuleRegistry;
  readonly sessionStore: IConsoleSessionStore;
  readonly identityResolver: IConsoleIdentityResolver;
  readonly opaqueValues: IConsoleOpaqueValueService;
  readonly integrationPublicBaseUrl: string | null;
  readonly adminAuditWriter: IAdminAuditWriter;
  readonly idempotencyStore: IIdempotencyStore;
  readonly authPolicyStore: IConsoleAuthPolicyStore;
  readonly protectedCorrelationRateLimiter: ConsoleProtectedCorrelationRateLimiter | null;
  readonly apiV1MountState: Pick<WebConsoleApiV1Mount, 'mounted' | 'markMounted'>;
  readonly userContext: ReturnType<typeof resolveConsoleUserContext>;
}): WebConsoleApiV1Mount | null {
  if (options.options.enableApiV1Mount !== true) return null;
  if (options.activationProfile !== 'shared-hosted') {
    throw new Error('Web console /api/v1 mount requires shared-hosted activation profile');
  }
  const consoleOrigin = options.options.consoleOrigin ?? originFromPublicBaseUrl(options.integrationPublicBaseUrl);
  const router = assembleSecuredConsoleRouter(options.registry, {
    sessionStore: options.sessionStore,
    identityResolver: options.identityResolver,
    opaqueValues: options.opaqueValues,
    consoleOrigin,
    adminAuditWriter: options.adminAuditWriter,
    idempotencyStore: options.idempotencyStore,
    authPolicyStore: options.authPolicyStore,
    protectedCorrelationRateLimiter: options.protectedCorrelationRateLimiter,
    idleTimeoutMs: options.options.consoleSessionIdleTimeoutMs ?? 30 * 60 * 1000,
    now: options.options.now,
    reportInternalError: options.options.reportApiV1InternalError,
    userContext: options.userContext ?? undefined,
  });
  return {
    router,
    mounted: options.apiV1MountState.mounted,
    markMounted: options.apiV1MountState.markMounted,
  };
}

function originFromPublicBaseUrl(publicBaseUrl: string | null): string {
  if (!publicBaseUrl) {
    throw new Error('Web console /api/v1 mount requires publicBaseUrl or consoleOrigin');
  }
  return new URL(publicBaseUrl).origin;
}

async function resolveProductionReadinessForActivation(
  activationProfile: WebConsoleActivationProfile,
  securityInvalidationReadiness: IConsoleSecurityInvalidationReadiness,
  portfolioSyncWorker: IConsolePortfolioSyncWorker | null,
  options: WebConsoleRegistrarOptions,
  container: DiContainerFacade,
  database: DatabaseInstance | undefined,
): Promise<WebConsoleProductionReadinessOptions | undefined> {
  if (activationProfile !== 'shared-hosted') return options.productionReadiness;
  const databaseReadiness = await resolveProductionDatabaseReadiness(options, container, database).getReadiness();
  return {
    ...options.productionReadiness,
    databaseVerificationReady: options.productionReadiness?.databaseVerificationReady ?? databaseReadiness.ready,
    securityInvalidationProcessorReady: (await securityInvalidationReadiness.getReadiness()).ready,
    portfolioSyncWorkerReady: options.productionReadiness?.portfolioSyncWorkerReady ?? portfolioSyncWorker?.isRunning() === true,
    accountAllowlistAuthorityCutoverComplete: options.productionReadiness?.accountAllowlistAuthorityCutoverComplete ??
      resolveAccountAllowlistAuthorityCutoverComplete(container),
  };
}

function resolveAccountAllowlistAuthorityCutoverComplete(container: DiContainerFacade): boolean {
  return container.hasRegistration('WebConsoleAccountAllowlistAuthorityCutoverComplete') &&
    container.resolve<boolean>('WebConsoleAccountAllowlistAuthorityCutoverComplete') === true;
}

function resolveProductionDatabaseReadiness(
  options: WebConsoleRegistrarOptions,
  container: DiContainerFacade,
  database: DatabaseInstance | undefined,
): IProductionDatabaseReadiness {
  if (options.productionDatabaseReadiness) return options.productionDatabaseReadiness;
  if (options.productionDatabaseVerification) {
    // Run the verifier over the APP connection ('DatabaseInstance'), not the
    // console's system/admin handle. expectedCurrentUser asserts the runtime
    // queries as the least-privilege NOBYPASSRLS role; checking it on the admin
    // connection would always observe the superuser and be meaningless.
    const verifierDb = container.hasRegistration('DatabaseInstance')
      ? container.resolve<DatabaseInstance>('DatabaseInstance')
      : database;
    if (verifierDb) {
      return createPostgresProductionDatabaseReadiness({
        db: verifierDb,
        ...options.productionDatabaseVerification,
      });
    }
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.productionDatabaseReadiness)) {
    return container.resolve<IProductionDatabaseReadiness>(WEB_CONSOLE_SERVICE_NAMES.productionDatabaseReadiness);
  }
  return productionDatabaseNotVerified();
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
  readonly securityInvalidationReadiness: IConsoleSecurityInvalidationReadiness;
  readonly routesMounted: () => boolean;
}): HealthReadinessChecks {
  return {
    sessionStorageAvailable: () => Boolean(options.stores.sessionStore),
    identityResolutionAvailable: () => Boolean(options.stores.identityResolver),
    securityInvalidationReady: async () => (await options.securityInvalidationReadiness.getReadiness()).ready,
    runtimeControlAvailable: () => Boolean(options.stores.runtimeSessionControlStore),
    databaseAvailable: () => Boolean(options.database),
    authServerAvailable: () => Boolean(options.authStorage),
    apiV1Mounted: () => options.routesMounted(),
  };
}

function createOperationHealthChecks(options: {
  readonly database: DatabaseInstance | undefined;
  readonly stores: ConsoleStoreSet;
  readonly authStorage: IAuthStorageLayer | null;
  readonly container: DiContainerFacade;
  readonly securityInvalidationReadiness: IConsoleSecurityInvalidationReadiness;
  readonly routesMounted: () => boolean;
}): OperationsHealthChecks {
  return {
    database: () => Boolean(options.database),
    authServer: () => Boolean(options.authStorage),
    gatekeeper: () => options.container.hasRegistration('gatekeeper'),
    runtimeControl: () => Boolean(options.stores.runtimeSessionControlStore),
    securityInvalidation: async () => operationHealthFromInvalidationReadiness(
      await options.securityInvalidationReadiness.getReadiness(),
    ),
    apiMount: () => options.routesMounted()
      ? {
        component: 'api_mount',
        status: 'ok',
        checked_at: new Date().toISOString(),
        failure_codes: [],
      }
      : {
        component: 'api_mount',
        status: 'not_ready',
        checked_at: new Date(0).toISOString(),
        failure_codes: ['api_v1_not_mounted'],
      },
  };
}

function operationHealthFromInvalidationReadiness(snapshot: Awaited<ReturnType<IConsoleSecurityInvalidationReadiness['getReadiness']>>) {
  return {
    component: 'security_invalidation' as const,
    status: snapshot.status,
    checked_at: snapshot.checkedAt.toISOString(),
    failure_codes: snapshot.failureCodes,
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
      sessionStore: markProductionAdapter(new PostgresConsoleSessionStore(database), 'PostgresConsoleSessionStore'),
      loginTransactionStore: markProductionAdapter(new PostgresLoginTransactionStore(database), 'PostgresLoginTransactionStore'),
      idempotencyStore: markProductionAdapter(new PostgresIdempotencyStore(database), 'PostgresIdempotencyStore'),
      factorStore: markProductionAdapter(new PostgresConsoleFactorStore(database), 'PostgresConsoleFactorStore'),
      accountAdminStore: markProductionAdapter(new PostgresConsoleAccountAdminStore(database), 'PostgresConsoleAccountAdminStore'),
      accountAllowlistStore: markProductionAdapter(
        new PostgresConsoleAccountAllowlistStore(database),
        'PostgresConsoleAccountAllowlistStore',
      ),
      integrationStore: markProductionAdapter(new PostgresUserIntegrationStore(database), 'PostgresUserIntegrationStore'),
      portfolioStore: new InMemoryPortfolioElementStore(),
      portfolioSyncJobStore: markProductionAdapter(
        new PostgresPortfolioSyncJobStore(database),
        'PostgresPortfolioSyncJobStore',
      ),
      securityInvalidationStore: markProductionAdapter(
        new PostgresConsoleSecurityInvalidationStore(database),
        'PostgresConsoleSecurityInvalidationStore',
      ),
      runtimeSessionControlStore: markProductionAdapter(
        new PostgresRuntimeSessionControlStore(database),
        'PostgresRuntimeSessionControlStore',
      ),
      identityResolver: markProductionAdapter(new PostgresConsoleIdentityResolver(database), 'PostgresConsoleIdentityResolver'),
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
  return markProductionAdapter(
    new PostgresAdminAuditWriter(database, container.resolve<AdminAuditHmacKeyResolver>('AuditHmacResolver')),
    'PostgresAdminAuditWriter',
  );
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
    return markProductionAdapter(
      new PostgresAdminAuditQuery(database, container.resolve<AdminAuditHmacKeyResolver>('AuditHmacResolver')),
      'PostgresAdminAuditQuery',
    );
  }
  return new InMemoryAdminAuditQuery();
}

function resolveApprovalAuditQuery(
  database: DatabaseInstance | undefined,
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IApprovalAuditQuery {
  if (options.approvalAuditQuery !== undefined) {
    return options.approvalAuditQuery ?? new InMemoryApprovalAuditQuery();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.approvalAuditQuery)) {
    return container.resolve<IApprovalAuditQuery>(WEB_CONSOLE_SERVICE_NAMES.approvalAuditQuery);
  }
  if (database) return markProductionAdapter(new PostgresApprovalAuditQuery(database), 'PostgresApprovalAuditQuery');
  return new InMemoryApprovalAuditQuery();
}

function resolveAuthenticationAuditQuery(
  database: DatabaseInstance | undefined,
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IAuthenticationAuditQuery {
  if (options.authenticationAuditQuery !== undefined) {
    return options.authenticationAuditQuery ?? new InMemoryAuthenticationAuditQuery();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.authenticationAuditQuery)) {
    return container.resolve<IAuthenticationAuditQuery>(WEB_CONSOLE_SERVICE_NAMES.authenticationAuditQuery);
  }
  if (database) return markProductionAdapter(new PostgresAuthenticationAuditQuery(database), 'PostgresAuthenticationAuditQuery');
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
    return markProductionAdapter(new PostgresAccountAdminMutationTransactionRunner({
      db: options.database,
      hmacKeyResolver: options.container.resolve<AdminAuditHmacKeyResolver>('AuditHmacResolver'),
    }), 'PostgresAccountAdminMutationTransactionRunner');
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
  return markProductionAdapter(
    new AeadSecretEncryptionService(key, options.retainedSecretEncryptionKeys ?? []),
    'AeadSecretEncryptionService',
  );
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
  return markProductionAdapter(new ConsoleProtectedCorrelationRateLimiter({
    store: container.resolve<IRateLimitStore>('RateLimitStore'),
    selectorHmacKey: Buffer.from(key),
    now: options.now,
  }), 'ConsoleProtectedCorrelationRateLimiter');
}

function resolveRateLimitStore(container: DiContainerFacade): IRateLimitStore | null {
  if (!container.hasRegistration('RateLimitStore')) return null;
  return markResolvedProductionAdapter(
    container.resolve<IRateLimitStore>('RateLimitStore'),
    'RateLimitStore',
  );
}

function resolveSessionActivationStateAdapter(
  container: DiContainerFacade,
  database: DatabaseInstance | undefined,
  options: WebConsoleRegistrarOptions,
): ISessionActivationStateAdapter {
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.sessionActivationStateAdapter)) {
    return container.resolve<ISessionActivationStateAdapter>(
      WEB_CONSOLE_SERVICE_NAMES.sessionActivationStateAdapter,
    );
  }
  if (database) {
    return markProductionAdapter(
      new PostgresSessionActivationStateAdapter(database, options.now),
      'PostgresSessionActivationStateAdapter',
    );
  }
  if (container.hasRegistration('SessionActivationRegistry')) {
    return new RegistrySessionActivationStateAdapter(
      container.resolve<SessionActivationRegistry>('SessionActivationRegistry'),
    );
  }
  return new InMemorySessionActivationStateAdapter();
}

function resolveSessionActivationEventSink(
  container: DiContainerFacade,
  database: DatabaseInstance | undefined,
): ISessionActivationEventSink {
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.sessionActivationEventSink)) {
    return container.resolve<ISessionActivationEventSink>(
      WEB_CONSOLE_SERVICE_NAMES.sessionActivationEventSink,
    );
  }
  if (database) return markProductionAdapter(new PostgresSessionActivationEventSink(database), 'PostgresSessionActivationEventSink');
  return new InMemorySessionActivationEventSink();
}

function resolveSessionApprovalStore(
  container: DiContainerFacade,
  database: DatabaseInstance | undefined,
  options: WebConsoleRegistrarOptions,
): SessionApprovalStore {
  if (options.approvalStore !== undefined) return options.approvalStore ?? new InMemorySessionApprovalStore();
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalStore)) {
    return container.resolve<SessionApprovalStore>(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalStore);
  }
  if (database) {
    return markProductionAdapter(new ConfirmationSessionApprovalStore(({ userId, sessionId }) => {
      const auditResolver = container.hasRegistration('AuditHmacResolver')
        ? container.resolve<AdminAuditHmacKeyResolver>('AuditHmacResolver')
        : undefined;
      return new DatabaseConfirmationStore(database, userId, sessionId, auditResolver);
    }), 'ConfirmationSessionApprovalStore');
  }
  if (container.hasRegistration('gatekeeper')) {
    return new GatekeeperSessionApprovalStore(container.resolve<Gatekeeper>('gatekeeper'));
  }
  return new InMemorySessionApprovalStore();
}

function resolveSessionApprovalEventSink(
  container: DiContainerFacade,
  database: DatabaseInstance | undefined,
  options: WebConsoleRegistrarOptions,
): ISessionApprovalEventSink {
  if (options.approvalEventSink !== undefined) {
    return options.approvalEventSink ?? new InMemorySessionApprovalEventSink();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalEventSink)) {
    return container.resolve<ISessionApprovalEventSink>(WEB_CONSOLE_SERVICE_NAMES.sessionApprovalEventSink);
  }
  if (database) return markProductionAdapter(new PostgresSessionApprovalEventSink(database), 'PostgresSessionApprovalEventSink');
  return new InMemorySessionApprovalEventSink();
}

function resolveSessionExecutionReader(
  container: DiContainerFacade,
  database: DatabaseInstance | undefined,
  options: WebConsoleRegistrarOptions,
): SessionExecutionReader {
  if (options.executionReader !== undefined) {
    return options.executionReader ?? new InMemorySessionExecutionReader();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.sessionExecutionReader)) {
    return container.resolve<SessionExecutionReader>(WEB_CONSOLE_SERVICE_NAMES.sessionExecutionReader);
  }
  if (database) return markProductionAdapter(new PostgresSessionExecutionReader(database), 'PostgresSessionExecutionReader');
  return new InMemorySessionExecutionReader();
}

function resolveSessionGatekeeperReader(
  container: DiContainerFacade,
  database: DatabaseInstance | undefined,
  options: WebConsoleRegistrarOptions,
): SessionGatekeeperReader {
  if (options.gatekeeperReader !== undefined) {
    return options.gatekeeperReader ?? new EmptySessionGatekeeperReader();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.sessionGatekeeperReader)) {
    return container.resolve<SessionGatekeeperReader>(WEB_CONSOLE_SERVICE_NAMES.sessionGatekeeperReader);
  }
  if (database) return markProductionAdapter(new PostgresSessionGatekeeperReader(database), 'PostgresSessionGatekeeperReader');
  if (container.hasRegistration('gatekeeper')) {
    return new GatekeeperSessionStateReader(container.resolve<Gatekeeper>('gatekeeper'));
  }
  return new EmptySessionGatekeeperReader();
}

function resolveTelemetryQuery(
  container: DiContainerFacade,
  database: DatabaseInstance | undefined,
  options: WebConsoleRegistrarOptions,
): IConsoleTelemetryQuery {
  if (options.telemetryQuery !== undefined) {
    return options.telemetryQuery ?? new InMemoryConsoleTelemetryQuery();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.telemetryQuery)) {
    return container.resolve<IConsoleTelemetryQuery>(WEB_CONSOLE_SERVICE_NAMES.telemetryQuery);
  }
  if (database) {
    return markProductionAdapter(new PostgresConsoleTelemetryQuery(database, {
      replicaId: resolveTelemetryReplicaId(container),
      now: options.now,
    }), 'PostgresConsoleTelemetryQuery');
  }
  return new InMemoryConsoleTelemetryQuery();
}

function resolveOwnedActivityQuery(
  container: DiContainerFacade,
  database: DatabaseInstance | undefined,
  options: WebConsoleRegistrarOptions,
): IOwnedActivityQuery {
  if (options.ownedActivityQuery !== undefined) {
    return options.ownedActivityQuery ?? new InMemoryOwnedActivityQuery();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.ownedActivityQuery)) {
    return container.resolve<IOwnedActivityQuery>(WEB_CONSOLE_SERVICE_NAMES.ownedActivityQuery);
  }
  if (database) return markProductionAdapter(new PostgresOwnedActivityQuery(database), 'PostgresOwnedActivityQuery');
  return new InMemoryOwnedActivityQuery();
}

function resolveOwnedMetricQuery(
  container: DiContainerFacade,
  database: DatabaseInstance | undefined,
  options: WebConsoleRegistrarOptions,
): IOwnedMetricQuery {
  if (options.ownedMetricQuery !== undefined) {
    return options.ownedMetricQuery ?? new InMemoryOwnedMetricQuery({ now: options.now });
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.ownedMetricQuery)) {
    return container.resolve<IOwnedMetricQuery>(WEB_CONSOLE_SERVICE_NAMES.ownedMetricQuery);
  }
  if (database) return markProductionAdapter(new PostgresOwnedMetricQuery(database, { now: options.now }), 'PostgresOwnedMetricQuery');
  return new InMemoryOwnedMetricQuery({ now: options.now });
}

function resolveTelemetryReplicaId(container: DiContainerFacade): string {
  if (container.hasRegistration('WebConsoleReplicaId')) {
    return container.resolve<string>('WebConsoleReplicaId');
  }
  return resolveWebConsoleReplicaId();
}

function resolveUserConfigStore(
  database: DatabaseInstance | undefined,
  container: DiContainerFacade,
): IUserConfigStore {
  if (container.hasRegistration('UserConfigStore')) {
    return markResolvedProductionAdapter(
      container.resolve<IUserConfigStore>('UserConfigStore'),
      'UserConfigStore',
    );
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
    return markResolvedProductionAdapter(
      container.resolve<IOperatorConfigStore>(WEB_CONSOLE_SERVICE_NAMES.operatorConfigStore),
      'OperatorConfigStore',
    );
  }
  if (container.hasRegistration('OperatorConfigStore')) {
    return markResolvedProductionAdapter(
      container.resolve<IOperatorConfigStore>('OperatorConfigStore'),
      'OperatorConfigStore',
    );
  }
  return database
    ? markProductionAdapter(new PostgresOperatorConfigStore({ db: database }), 'PostgresOperatorConfigStore')
    : new InMemoryOperatorConfigStore();
}

function resolveSigningKeyStore(
  database: DatabaseInstance | undefined,
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): ISigningKeyStore {
  if (options.signingKeyStore !== undefined) {
    return options.signingKeyStore
      ? markResolvedProductionAdapter(options.signingKeyStore, 'SigningKeyStore')
      : new InMemorySigningKeyStore();
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.signingKeyStore)) {
    return markResolvedProductionAdapter(
      container.resolve<ISigningKeyStore>(WEB_CONSOLE_SERVICE_NAMES.signingKeyStore),
      'SigningKeyStore',
    );
  }
  if (container.hasRegistration('SigningKeyStore')) {
    return markResolvedProductionAdapter(
      container.resolve<ISigningKeyStore>('SigningKeyStore'),
      'SigningKeyStore',
    );
  }
  if (database) {
    throw new Error('Web console PostgreSQL security-admin signing keys require SigningKeyStore');
  }
  return new InMemorySigningKeyStore();
}

async function resolveAuthPolicyStore(
  database: DatabaseInstance | undefined,
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): Promise<IConsoleAuthPolicyStore> {
  if (options.authPolicyStore !== undefined) return options.authPolicyStore ?? new InMemoryConsoleAuthPolicyStore();
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.authPolicyStore)) {
    return container.resolve<IConsoleAuthPolicyStore>(WEB_CONSOLE_SERVICE_NAMES.authPolicyStore);
  }
  if (database) {
    const { PostgresConsoleAuthPolicyStore } = await import('./stores/PostgresConsoleAuthPolicyStore.js');
    return markProductionAdapter(new PostgresConsoleAuthPolicyStore(database), 'PostgresConsoleAuthPolicyStore');
  }
  return new InMemoryConsoleAuthPolicyStore();
}

async function resolveSecurityInvalidationRuntime(options: {
  readonly activationProfile: WebConsoleActivationProfile;
  readonly container: DiContainerFacade;
  readonly options: WebConsoleRegistrarOptions;
  readonly stores: ConsoleStoreSet;
  readonly storageBackend: 'memory' | 'postgres';
}): Promise<{
  readonly readiness: IConsoleSecurityInvalidationReadiness;
  readonly processor: IConsoleSecurityInvalidationProcessor | null;
}> {
  if (options.options.securityInvalidationReadiness !== undefined) {
    return {
      readiness: options.options.securityInvalidationReadiness ??
        new StaticConsoleSecurityInvalidationReadiness(false, options.options.now),
      processor: null,
    };
  }
  if (options.container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.securityInvalidationReadiness)) {
    return {
      readiness: options.container.resolve<IConsoleSecurityInvalidationReadiness>(
        WEB_CONSOLE_SERVICE_NAMES.securityInvalidationReadiness,
      ),
      processor: null,
    };
  }
  if (options.activationProfile !== 'shared-hosted' || options.storageBackend !== 'postgres') {
    return {
      readiness: new StaticConsoleSecurityInvalidationReadiness(false, options.options.now),
      processor: null,
    };
  }
  const replicaId = resolveSecurityInvalidationReplicaId(options.container, options.options);
  if (!options.container.hasRegistration('LifecycleService')) {
    throw new Error('Hosted/shared security invalidation processor registration requires LifecycleService');
  }
  const processor = new ConsoleSecurityInvalidationProcessor({
    store: options.stores.securityInvalidationStore,
    sessionStore: options.stores.sessionStore,
    replicaId,
    intervalMs: options.options.securityInvalidationProcessorIntervalMs,
    leaseDurationMs: options.options.securityInvalidationProcessorLeaseDurationMs,
    batchSize: options.options.securityInvalidationProcessorBatchSize,
    now: options.options.now,
    reportError: options.options.reportSecurityInvalidationProcessorError,
  });
  processor.register(options.container.resolve('LifecycleService'));
  await processor.runUntilDrained(options.options.securityInvalidationInitialDrainMaxEvents);
  return {
    readiness: new StoreBackedConsoleSecurityInvalidationReadiness({
      store: options.stores.securityInvalidationStore,
      replicaId,
      processorReady: () => processor.isRunning(),
      now: options.options.now,
    }),
    processor,
  };
}

function resolveSecurityInvalidationReplicaId(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): string {
  if (options.securityInvalidationReplicaId) return options.securityInvalidationReplicaId;
  if (container.hasRegistration('WebConsoleSecurityInvalidationReplicaId')) {
    return container.resolve<string>('WebConsoleSecurityInvalidationReplicaId');
  }
  if (container.hasRegistration('WebConsoleReplicaId')) {
    return container.resolve<string>('WebConsoleReplicaId');
  }
  return resolveStableWebConsoleReplicaId();
}

function resolvePortfolioSyncWorker(options: {
  readonly activationProfile: WebConsoleActivationProfile;
  readonly container: DiContainerFacade;
  readonly options: WebConsoleRegistrarOptions;
  readonly stores: ConsoleStoreSet;
  readonly secretEncryption: ISecretEncryptionService | null;
  readonly storageBackend: 'memory' | 'postgres';
}): IConsolePortfolioSyncWorker | null {
  if (options.options.portfolioSyncWorker !== undefined) {
    return options.options.portfolioSyncWorker;
  }
  if (options.container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.portfolioSyncWorker)) {
    return options.container.resolve<IConsolePortfolioSyncWorker>(WEB_CONSOLE_SERVICE_NAMES.portfolioSyncWorker);
  }
  if (options.activationProfile !== 'shared-hosted' || options.storageBackend !== 'postgres') {
    return null;
  }
  if (!options.container.hasRegistration('LifecycleService')) {
    throw new Error('Hosted/shared portfolio sync worker registration requires LifecycleService');
  }
  const executor = options.options.portfolioSyncJobExecutor ??
    resolvePortfolioSyncJobExecutor(
      options.container,
      options.stores,
      options.secretEncryption,
      options.options.portfolioSyncRepositoryName,
    );
  const worker = new ConsolePortfolioSyncWorker({
    store: options.stores.portfolioSyncJobStore,
    workerId: resolvePortfolioSyncWorkerId(options.container, options.options),
    executor,
    intervalMs: options.options.portfolioSyncWorkerIntervalMs,
    leaseDurationMs: options.options.portfolioSyncWorkerLeaseDurationMs,
    batchSize: options.options.portfolioSyncWorkerBatchSize,
    now: options.options.now,
    reportError: options.options.reportPortfolioSyncWorkerError,
  });
  worker.register(options.container.resolve('LifecycleService'));
  return worker;
}

function resolvePortfolioSyncJobExecutor(
  container: DiContainerFacade,
  stores: ConsoleStoreSet,
  secretEncryption: ISecretEncryptionService | null,
  repositoryName?: string,
): IPortfolioSyncJobExecutor | undefined {
  if (!secretEncryption) return undefined;
  return markProductionAdapter(
    new ConsolePortfolioSyncExecutor({
      integrationStore: stores.integrationStore,
      portfolioStore: stores.portfolioStore,
      secretEncryption,
      repositoryName,
      ...resolveConsolePortfolioSyncContext(container),
    }),
    'ConsolePortfolioSyncExecutor',
  );
}

function resolveConsolePortfolioSyncContext(container: DiContainerFacade) {
  const userContext = resolveConsoleUserContext(container);
  if (!userContext) return {};
  return {
    contextTracker: userContext.contextTracker,
    sessionActivationRegistry: userContext.sessionActivationRegistry,
  };
}

function resolvePortfolioSyncWorkerId(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): string {
  if (options.portfolioSyncWorkerId) return options.portfolioSyncWorkerId;
  if (container.hasRegistration('WebConsolePortfolioSyncWorkerId')) {
    return container.resolve<string>('WebConsolePortfolioSyncWorkerId');
  }
  if (container.hasRegistration('WebConsoleReplicaId')) {
    return container.resolve<string>('WebConsoleReplicaId');
  }
  return resolveStableWebConsoleReplicaId();
}

function resolveOAuthGrantRevocationService(options: {
  readonly container: DiContainerFacade;
  readonly options: WebConsoleRegistrarOptions;
  readonly database: DatabaseInstance | undefined;
  readonly authStorage: IAuthStorageLayer | null;
},
): IOAuthGrantRevocationService | null {
  if (options.options.oauthGrantRevocationService !== undefined) return options.options.oauthGrantRevocationService;
  if (options.container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.oauthGrantRevocationService)) {
    return options.container.resolve<IOAuthGrantRevocationService>(WEB_CONSOLE_SERVICE_NAMES.oauthGrantRevocationService);
  }
  if (options.database && options.authStorage) {
    return markProductionAdapter(new ConsoleOAuthGrantRevocationService(
      new PostgresConsoleOAuthSubjectResolver(options.database),
      options.authStorage,
    ), 'ConsoleOAuthGrantRevocationService');
  }
  return null;
}

function resolveConsoleOAuthClient(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IConsoleOAuthClient | null {
  if (options.consoleOAuthClient !== undefined) return options.consoleOAuthClient;
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.consoleOAuthClient)) {
    return container.resolve<IConsoleOAuthClient>(WEB_CONSOLE_SERVICE_NAMES.consoleOAuthClient);
  }
  if (options.publicBaseUrl) {
    return markProductionAdapter(new EmbeddedAsConsoleOAuthClient({
      publicBaseUrl: options.publicBaseUrl,
    }), 'EmbeddedAsConsoleOAuthClient');
  }
  return null;
}

function resolveAuthStorage(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IAuthStorageLayer | null {
  if (options.authStorage !== undefined) {
    return options.authStorage
      ? markResolvedProductionAdapter(options.authStorage, 'AuthStorage')
      : null;
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.authStorage)) {
    return markResolvedProductionAdapter(
      container.resolve<IAuthStorageLayer>(WEB_CONSOLE_SERVICE_NAMES.authStorage),
      'AuthStorage',
    );
  }
  // Transitional bridge for the embedded AS bootstrap wiring, which still
  // publishes its storage under the legacy container key.
  if (container.hasRegistration('AuthStorage')) {
    return markResolvedProductionAdapter(
      container.resolve<IAuthStorageLayer>('AuthStorage'),
      'AuthStorage',
    );
  }
  return null;
}

function resolveAccountInviteIssuer(input: {
  readonly container: DiContainerFacade;
  readonly options: WebConsoleRegistrarOptions;
  readonly database: DatabaseInstance | undefined;
  readonly signingKeyStore: ISigningKeyStore;
  readonly publicBaseUrl: string | null;
}): IConsoleAccountInviteIssuer | null {
  const { container, options } = input;
  if (options.accountInviteIssuer !== undefined) return options.accountInviteIssuer;
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.accountInviteIssuer)) {
    return container.resolve<IConsoleAccountInviteIssuer>(WEB_CONSOLE_SERVICE_NAMES.accountInviteIssuer);
  }
  if (input.database && input.publicBaseUrl) {
    return markProductionAdapter(new PostgresConsoleAccountInviteIssuer({
      db: input.database,
      signingKeyStore: input.signingKeyStore,
      publicBaseUrl: input.publicBaseUrl,
    }), 'PostgresConsoleAccountInviteIssuer');
  }
  return null;
}

function resolveGitHubIntegrationProvider(
  container: DiContainerFacade,
  options: WebConsoleRegistrarOptions,
): IGitHubIntegrationProvider | null {
  if (options.githubIntegrationProvider !== undefined) return options.githubIntegrationProvider;
  const config = resolveGitHubIntegrationProviderConfig(options);
  if (config) {
    return markProductionAdapter(new GitHubAppIntegrationProvider(config), 'GitHubAppIntegrationProvider');
  }
  if (container.hasRegistration(WEB_CONSOLE_SERVICE_NAMES.githubIntegrationProvider)) {
    return container.resolve<IGitHubIntegrationProvider>(WEB_CONSOLE_SERVICE_NAMES.githubIntegrationProvider);
  }
  return null;
}

function resolveGitHubIntegrationProviderConfig(
  options: WebConsoleRegistrarOptions,
): GitHubAppIntegrationProviderConfig | null {
  if (options.githubIntegrationProviderConfig !== undefined) {
    return options.githubIntegrationProviderConfig;
  }
  if (!env.DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID || !env.DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_SECRET) {
    return null;
  }
  return {
    clientId: env.DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID,
    clientSecret: env.DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_SECRET,
  };
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
  if (options.enableManagerBackedPortfolioStore !== false) {
    const store = createManagerBackedPortfolioElementStore(container);
    if (store) return markProductionAdapter(store, 'ManagerBackedPortfolioElementStore');
  }
  return fallback;
}

function createManagerBackedPortfolioElementStore(
  container: DiContainerFacade,
): ManagerBackedPortfolioElementStore | null {
  const requiredServices = [
    'UserIdResolver',
    'PersonaManager',
    'SkillManager',
    'TemplateManager',
    'AgentManager',
    'MemoryManager',
    'EnsembleManager',
  ];
  if (!requiredServices.every(serviceName => container.hasRegistration(serviceName))) return null;
  const managers: ManagerBackedPortfolioManagers = {
    personas: container.resolve<BaseElementManager<IElement>>('PersonaManager'),
    skills: container.resolve<BaseElementManager<IElement>>('SkillManager'),
    templates: container.resolve<BaseElementManager<IElement>>('TemplateManager'),
    agents: container.resolve<BaseElementManager<IElement>>('AgentManager'),
    memories: container.resolve<BaseElementManager<IElement>>('MemoryManager'),
    ensembles: container.resolve<BaseElementManager<IElement>>('EnsembleManager'),
  };
  return new ManagerBackedPortfolioElementStore({
    managers,
    getCurrentUserId: container.resolve<UserIdResolver>('UserIdResolver'),
  });
}

function resolveConsoleUserContext(container: DiContainerFacade) {
  if (!container.hasRegistration('ContextTracker') || !container.hasRegistration('SessionActivationRegistry')) {
    return null;
  }
  return {
    contextTracker: container.resolve<ContextTracker>('ContextTracker'),
    sessionActivationRegistry: container.resolve<SessionActivationRegistry>('SessionActivationRegistry'),
  };
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

function markProductionAdapter<T extends object>(
  adapter: T,
  adapterName: string,
): T {
  return markWebConsoleProductionAdapter(adapter, {
    productionReady: true,
    adapterName,
  });
}

function markResolvedProductionAdapter<T extends object>(
  adapter: T,
  adapterName: string,
): T {
  if (hasKnownUnsafeAdapterName(adapter)) return adapter;
  return markProductionAdapter(adapter, adapterName);
}

function hasKnownUnsafeAdapterName(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as { readonly constructor?: { readonly name?: unknown } } | null;
  const constructorName = typeof prototype?.constructor?.name === 'string'
    ? prototype.constructor.name
    : 'unknown';
  return constructorName === 'unknown' ||
    constructorName.startsWith('InMemory') ||
    constructorName.startsWith('Empty') ||
    constructorName === 'GatekeeperSessionApprovalStore' ||
    constructorName === 'GatekeeperSessionStateReader';
}
