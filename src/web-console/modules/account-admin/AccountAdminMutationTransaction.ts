import { and, eq, isNotNull, or, sql } from 'drizzle-orm';

import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import type { DrizzleTx } from '../../../database/db-utils.js';
import { lockAuthPrincipalsWithTx } from '../../../database/authPrincipalLock.js';
import { consoleLoginTransactions, userIntegrations } from '../../../database/schema/index.js';
import {
  attachSharedInMemoryTransactionGate,
  type InMemoryTransactionGate,
} from '../../../utils/InMemoryTransactionGate.js';
import type { SigningKey, SigningKeyWrite, ISigningKeyStore } from '../../../storage/signingKeys/ISigningKeyStore.js';
import { isSigningKeyLifecycleConflictError } from '../../../storage/signingKeys/signingKeyLifecycle.js';
import type {
  PostgresSigningKeyTransactionAdapter,
  PostgresSigningKeyTransactionProvider,
} from '../../../storage/signingKeys/PostgresSigningKeyStore.js';
import type { ConsoleAdminAuditEvent , IAdminAuditWriter } from '../../audit/IAdminAuditWriter.js';
import {
  appendConsoleAdminAuditEventWithTx,
  fixedKeyResolver,
  type AdminAuditHmacKeyResolver,
} from '../../audit/PostgresAdminAuditWriter.js';
import {
  deleteConsolePrincipalWithTx,
  disableConsolePrincipalWithTx,
  enableConsolePrincipalWithTx,
  findConsolePrincipalForUpdateWithTx,
  grantConsoleAdminRoleWithTx,
  listConsoleLinkedIdentitiesWithTx,
  linkConsoleIdentityWithTx,
  finalizeConsoleIdentityLinkWithTx,
  bumpConsolePrincipalAuthzVersionWithTx,
  revokeConsoleAdminRoleWithTx,
  unlinkConsoleIdentityWithTx,
} from '../../stores/PostgresConsoleAccountAdminStore.js';
import {
  addAccountAllowlistEntryWithTx,
  removeAccountAllowlistEntryWithTx,
  updateAccountAllowlistEntryWithTx,
} from '../../stores/PostgresConsoleAccountAllowlistStore.js';
import type {
  ConsoleRoleAssignment,
  IdentityLinkFinalizationResult,
  IdentityLinkInput,
  IdentityLinkPreparationResult,
  IdentityMutationResult,
  IdentityUnlinkInput,
  PrincipalAuthzVersionBumpInput,
  PrincipalDeletionInput,
  PrincipalDeletionOutcome,
  PrincipalDisableInput,
  PrincipalEnableInput,
  PrincipalStateChange,
  RoleGrantInput,
  RoleRevokeInput,
  ConsolePrincipalSummary,
  IConsoleAccountAdminStore,
  LinkedIdentity,
} from '../../stores/IConsoleAccountAdminStore.js';
import type {
  AllowlistAddInput,
  AllowlistRemoveInput,
  AllowlistUpdateInput,
  ConsoleAccountAllowlistEntry,
  IConsoleAccountAllowlistStore,
} from '../../stores/IConsoleAccountAllowlistStore.js';
import {
  appendSecurityInvalidationEventWithTx,
} from '../../services/invalidation/PostgresConsoleSecurityInvalidationStore.js';
import type {
  IConsoleSecurityInvalidationStore,
  SecurityInvalidationEvent,
  SecurityInvalidationEventInput,
} from '../../services/invalidation/IConsoleSecurityInvalidationStore.js';
import type { ConsoleAuthPolicy, IConsoleAuthPolicyStore } from '../../stores/IConsoleAuthPolicyStore.js';
import type { ConsoleAuthenticatedContext } from '../../platform/ConsolePlatformTypes.js';
import {
  loadConsoleAuthPolicyWithTx,
  PostgresConsoleAuthPolicyStore,
  saveConsoleAuthPolicyWithTx,
} from '../../stores/PostgresConsoleAuthPolicyStore.js';
import type { IConsoleFactorStore } from '../../stores/IConsoleFactorStore.js';
import type { IUserIntegrationStore } from '../../stores/IUserIntegrationStore.js';
import type { ILoginTransactionStore } from '../../stores/ILoginTransactionStore.js';
import { disableActiveTotpWithTx } from '../../stores/PostgresConsoleFactorStore.js';
import { revokeConsoleSessionsForUserWithTx } from '../../stores/PostgresConsoleSessionStore.js';
import {
  findAuthGrantIdsByAccountIdWithTx,
  revokeAuthGrantByIdWithTx,
} from '../../../auth/embedded-as/storage/PostgresAuthStorageLayer.js';
import type {
  ConsoleAccountInviteIssueInput,
  ConsoleAccountInviteIssueResult,
  IConsoleAccountInviteIssuer,
  PreparedConsoleAccountInviteIssue,
} from './AccountAdminInviteService.js';
import type {
  IRuntimeSessionControlStore,
  RuntimeSessionPresence,
  RuntimeTerminationCommand,
  RuntimeTerminationCommandInput,
} from '../../services/runtime/IRuntimeSessionControlStore.js';
import {
  createRuntimeTerminationCommandWithTx,
  findRuntimePresenceWithTx,
  listAllRuntimePresenceByUserWithTx,
  PostgresRuntimeSessionControlStore,
} from '../../services/runtime/PostgresRuntimeSessionControlStore.js';
import type { IOperatorConfigStore, OperatorConfig } from '../../../storage/operatorConfig/IOperatorConfigStore.js';
import {
  loadOperatorConfigWithTx,
  PostgresOperatorConfigStore,
  saveOperatorConfigWithTx,
} from '../../../storage/operatorConfig/PostgresOperatorConfigStore.js';

export interface MutationTransactionBaseContext {
  appendSecurityInvalidationEvent(input: SecurityInvalidationEventInput): Promise<SecurityInvalidationEvent>;
  writeAdminAuditEvent(event: ConsoleAdminAuditEvent): Promise<void>;
}

export interface AccountAdminMutationTransactionContext extends MutationTransactionBaseContext {
  lockPrincipal(userId: string): Promise<ConsolePrincipalSummary | null>;
  /** Called only after lockPrincipal so connect/disconnect shares the same user-row fence. */
  hasIntegrationCredentialMaterial(userId: string): Promise<boolean>;
  /** Called after lockPrincipal; consumed OAuth callbacks must settle before deletion. */
  hasInFlightIntegrationAuthorization(userId: string): Promise<boolean>;
  listLinkedIdentities(userId: string): Promise<LinkedIdentity[]>;
  /** Lock every currently linked auth subject before establishing a revocation cutoff. */
  lockLinkedAuthSubjects(userId: string): Promise<LinkedIdentity[]>;
  grantRole(input: RoleGrantInput): Promise<ConsoleRoleAssignment>;
  revokeRole(input: RoleRevokeInput): Promise<ConsoleRoleAssignment | null>;
  disablePrincipal(input: PrincipalDisableInput): Promise<PrincipalStateChange | null>;
  enablePrincipal(input: PrincipalEnableInput): Promise<PrincipalStateChange | null>;
  bumpPrincipalAuthzVersion(input: PrincipalAuthzVersionBumpInput): Promise<PrincipalStateChange | null>;
  deletePrincipal(input: PrincipalDeletionInput): Promise<PrincipalDeletionOutcome | null>;
  linkIdentity(input: IdentityLinkInput): Promise<IdentityLinkPreparationResult>;
  finalizeIdentityLink(input: IdentityLinkInput): Promise<IdentityLinkFinalizationResult>;
  unlinkIdentity(input: IdentityUnlinkInput): Promise<IdentityMutationResult | null>;
  /** Use the transaction connection when supported, avoiding nested pool acquisition. */
  revokeBrowserSessionsForUser?(userId: string, revokedAt: Date): Promise<number>;
  /** Use the transaction connection when supported, avoiding nested pool acquisition. */
  revokeOAuthSubjectGrants?(sub: string): Promise<number>;
  addAllowlistEntry(input: AllowlistAddInput): Promise<ConsoleAccountAllowlistEntry>;
  updateAllowlistEntry(input: AllowlistUpdateInput): Promise<ConsoleAccountAllowlistEntry | null>;
  removeAllowlistEntry(input: AllowlistRemoveInput): Promise<ConsoleAccountAllowlistEntry | null>;
  getSigningKeyByKid(kid: string): Promise<SigningKey | null>;
  rotateSigningKey(write: SigningKeyWrite): Promise<SigningKey>;
  retireSigningKey(kid: string, retiredAt?: number): Promise<SigningKey | null>;
  deleteSigningKey(kid: string, options?: { readonly force?: boolean }): Promise<boolean>;
  loadAuthPolicy(): Promise<ConsoleAuthPolicy>;
  saveAuthPolicy(
    policy: Pick<ConsoleAuthPolicy, 'maxAdminElevationSeconds'>,
    options?: { readonly expectedUpdatedAt?: Date },
  ): Promise<ConsoleAuthPolicy>;
  disableActiveTotp(userId: string, disabledAt?: Date): Promise<boolean>;
  issueInvite(input: ConsoleAccountInviteIssueInput): Promise<ConsoleAccountInviteIssueResult>;
  findRuntimePresence(sessionId: string, now?: Date): Promise<RuntimeSessionPresence | null>;
  listAllRuntimePresenceByUser(userId: string, now?: Date): Promise<RuntimeSessionPresence[]>;
  createRuntimeTerminationCommand(input: RuntimeTerminationCommandInput): Promise<RuntimeTerminationCommand>;
  loadOperatorConfig(): Promise<OperatorConfig>;
  saveOperatorConfig(
    config: Omit<OperatorConfig, 'updatedAt'> & { updatedAt?: number },
    options?: { readonly expectedUpdatedAt?: number },
  ): Promise<void>;
}

export interface IAccountAdminMutationTransactionRunner {
  /**
   * Executes account-admin mutation work in one system transaction.
   *
   * Successful administrative mutations must append their durable audit event in
   * this callback. Write the audit event after domain/invalidation writes to
   * keep lock acquisition ordered consistently across mutation services.
   */
  run<T>(
    operation: (tx: AccountAdminMutationTransactionContext) => Promise<T>,
    actor?: Pick<ConsoleAuthenticatedContext, 'userId' | 'authzVersion'>,
  ): Promise<T>;
  /**
   * Runs the invite-only transaction path. Implementations may prebind signing
   * material before opening a one-connection PostgreSQL transaction or stage
   * post-commit delivery for an in-memory transaction.
   */
  runInvite<T>(
    operation: (tx: AccountAdminMutationTransactionContext) => Promise<T>,
    actor?: Pick<ConsoleAuthenticatedContext, 'userId' | 'authzVersion'>,
  ): Promise<T>;
}

/** The account committed, but the post-commit credential delivery hook failed. */
export class CommittedAccountInviteDeliveryError extends Error {
  constructor(
    readonly result: ConsoleAccountInviteIssueResult,
    readonly deliveryCause: unknown,
  ) {
    super('Account invite committed but credential delivery requires manual completion');
    this.name = 'CommittedAccountInviteDeliveryError';
  }
}

export interface PostgresAccountAdminMutationTransactionRunnerOptions {
  readonly db: DatabaseInstance;
  readonly hmacKeyResolver: AdminAuditHmacKeyResolver;
  readonly signingKeyStore: ISigningKeyStore;
  readonly authPolicyStore: IConsoleAuthPolicyStore;
  readonly runtimeSessionControlStore?: IRuntimeSessionControlStore;
  readonly operatorConfigStore?: IOperatorConfigStore;
  readonly inviteIssuer?: IConsoleAccountInviteIssuer | null;
}

export class PostgresAccountAdminMutationTransactionRunner
implements IAccountAdminMutationTransactionRunner {
  private static readonly INVITE_LIFECYCLE_RETRY_LIMIT = 3;
  private readonly signingKeyTransactions: PostgresSigningKeyTransactionAdapter;

  constructor(private readonly options: PostgresAccountAdminMutationTransactionRunnerOptions) {
    this.signingKeyTransactions = resolvePostgresSigningKeyTransactionAdapter(
      options.signingKeyStore,
      options.db,
    );
    assertPostgresMutationStoreCompatibility(
      options.authPolicyStore,
      PostgresConsoleAuthPolicyStore,
      options.db,
      'auth-policy',
    );
    if (options.runtimeSessionControlStore) {
      assertPostgresMutationStoreCompatibility(
        options.runtimeSessionControlStore,
        PostgresRuntimeSessionControlStore,
        options.db,
        'runtime-session',
      );
    }
    if (options.operatorConfigStore) {
      assertPostgresMutationStoreCompatibility(
        options.operatorConfigStore,
        PostgresOperatorConfigStore,
        options.db,
        'operator-config',
      );
    }
  }

  async run<T>(
    operation: (tx: AccountAdminMutationTransactionContext) => Promise<T>,
    actor?: Pick<ConsoleAuthenticatedContext, 'userId' | 'authzVersion'>,
  ): Promise<T> {
    return this.runPrepared(operation, null, actor);
  }

  async runInvite<T>(
    operation: (tx: AccountAdminMutationTransactionContext) => Promise<T>,
    actor?: Pick<ConsoleAuthenticatedContext, 'userId' | 'authzVersion'>,
  ): Promise<T> {
    const inviteIssuer = requiredInviteIssuer(this.options.inviteIssuer);
    if (!inviteIssuer.prepareIssueInviteWithTx) {
      throw new Error('PostgreSQL invite issuer does not support one-pool-safe transaction composition');
    }
    for (let attempt = 1; attempt <= PostgresAccountAdminMutationTransactionRunner.INVITE_LIFECYCLE_RETRY_LIMIT; attempt += 1) {
      // Prebinding can need the same single connection as the mutation. Resolve
      // it before opening the transaction, but only for the invite endpoint.
      const preparedIssueInvite = await inviteIssuer.prepareIssueInviteWithTx();
      try {
        return await this.runPrepared(operation, preparedIssueInvite, actor);
      } catch (error) {
        const canRetry = isSigningKeyLifecycleConflictError(error)
          && attempt < PostgresAccountAdminMutationTransactionRunner.INVITE_LIFECYCLE_RETRY_LIMIT;
        if (!canRetry) throw error;
      }
    }
    throw new Error('unreachable invite lifecycle retry state');
  }

  private async runPrepared<T>(
    operation: (tx: AccountAdminMutationTransactionContext) => Promise<T>,
    preparedIssueInvite: ((
      tx: DrizzleTx,
      input: ConsoleAccountInviteIssueInput,
    ) => Promise<ConsoleAccountInviteIssueResult>) | null,
    actor?: Pick<ConsoleAuthenticatedContext, 'userId' | 'authzVersion'>,
  ): Promise<T> {
    // Resolving a DB-backed audit key can itself need a connection. Do it before
    // the mutation transaction owns a pool slot so a pool of size one cannot
    // deadlock waiting for itself.
    const auditKeyResolver = fixedKeyResolver(await this.options.hmacKeyResolver.resolve());
    return withSystemContext(this.options.db, async tx => {
      if (actor) await assertActorAuthorityWithTx(tx, actor);
      const auditState = { writes: 0 };
      const result = await operation(this.contextFor(tx, auditKeyResolver, preparedIssueInvite, () => {
        auditState.writes += 1;
      }));
      if (auditState.writes !== 1) throw new Error('administrative mutation transaction must append exactly one admin audit event');
      return result;
    });
  }

  private contextFor(
    tx: DrizzleTx,
    auditKeyResolver: AdminAuditHmacKeyResolver,
    preparedIssueInvite: ((
      tx: DrizzleTx,
      input: ConsoleAccountInviteIssueInput,
    ) => Promise<ConsoleAccountInviteIssueResult>) | null,
    markAuditWritten: () => void,
  ): AccountAdminMutationTransactionContext {
    return {
      lockPrincipal: userId => findConsolePrincipalForUpdateWithTx(tx, userId),
      hasIntegrationCredentialMaterial: async userId => {
        const rows = await tx.select({ id: userIntegrations.id }).from(userIntegrations).where(and(
          eq(userIntegrations.userId, userId),
          or(
            isNotNull(userIntegrations.accessTokenCiphertext),
            isNotNull(userIntegrations.refreshTokenCiphertext),
          ),
        )).limit(1);
        return rows.length > 0;
      },
      hasInFlightIntegrationAuthorization: async userId => {
        const rows = await tx.select({ idHash: consoleLoginTransactions.idHash })
          .from(consoleLoginTransactions).where(and(
            eq(consoleLoginTransactions.flowKind, 'integration_link'),
            eq(consoleLoginTransactions.userId, userId),
            isNotNull(consoleLoginTransactions.consumedAt),
            sql`${consoleLoginTransactions.expiresAt} > statement_timestamp()`,
          )).limit(1);
        return rows.length > 0;
      },
      listLinkedIdentities: userId => listConsoleLinkedIdentitiesWithTx(tx, userId),
      lockLinkedAuthSubjects: async userId => {
        const identities = await listConsoleLinkedIdentitiesWithTx(tx, userId);
        await lockAuthPrincipalsWithTx(tx, identities.map(identity => identity.sub));
        return identities;
      },
      grantRole: input => grantConsoleAdminRoleWithTx(tx, input),
      revokeRole: input => revokeConsoleAdminRoleWithTx(tx, input),
      disablePrincipal: input => disableConsolePrincipalWithTx(tx, input),
      enablePrincipal: input => enableConsolePrincipalWithTx(tx, input),
      bumpPrincipalAuthzVersion: input => bumpConsolePrincipalAuthzVersionWithTx(tx, input),
      deletePrincipal: input => deleteConsolePrincipalWithTx(tx, input),
      linkIdentity: input => linkConsoleIdentityWithTx(tx, input),
      finalizeIdentityLink: input => finalizeConsoleIdentityLinkWithTx(tx, input),
      unlinkIdentity: input => unlinkConsoleIdentityWithTx(tx, input),
      revokeBrowserSessionsForUser: (userId, revokedAt) =>
        revokeConsoleSessionsForUserWithTx(tx, userId, revokedAt),
      revokeOAuthSubjectGrants: async sub => {
        await lockAuthPrincipalsWithTx(tx, [sub]);
        const grantIds = [...new Set(await findAuthGrantIdsByAccountIdWithTx(tx, sub))];
        for (const grantId of grantIds) await revokeAuthGrantByIdWithTx(tx, grantId);
        return grantIds.length;
      },
      addAllowlistEntry: input => addAccountAllowlistEntryWithTx(tx, input),
      updateAllowlistEntry: input => updateAccountAllowlistEntryWithTx(tx, input),
      removeAllowlistEntry: input => removeAccountAllowlistEntryWithTx(tx, input),
      getSigningKeyByKid: kid => this.signingKeyTransactions.getByKid(tx, kid),
      rotateSigningKey: write => this.signingKeyTransactions.rotate(tx, write),
      retireSigningKey: (kid, retiredAt) => this.signingKeyTransactions.retire(tx, kid, retiredAt),
      deleteSigningKey: (kid, options) => this.signingKeyTransactions.delete(tx, kid, options),
      loadAuthPolicy: () => loadConsoleAuthPolicyWithTx(tx),
      saveAuthPolicy: (policy, options) => saveConsoleAuthPolicyWithTx(tx, policy, options),
      disableActiveTotp: (userId, disabledAt) => disableActiveTotpWithTx(tx, userId, disabledAt),
      issueInvite: input => {
        if (!preparedIssueInvite) {
          throw new Error('Invite issuance requires the dedicated runInvite transaction path');
        }
        return preparedIssueInvite(tx, input);
      },
      findRuntimePresence: (sessionId, now) => {
        this.requireRuntimeStore();
        return findRuntimePresenceWithTx(tx, sessionId, now);
      },
      listAllRuntimePresenceByUser: (userId, now) => {
        this.requireRuntimeStore();
        return listAllRuntimePresenceByUserWithTx(tx, userId, now);
      },
      createRuntimeTerminationCommand: input => {
        this.requireRuntimeStore();
        return createRuntimeTerminationCommandWithTx(tx, input);
      },
      loadOperatorConfig: () => {
        this.requireOperatorConfigStore();
        return loadOperatorConfigWithTx(tx);
      },
      saveOperatorConfig: (config, options) => {
        this.requireOperatorConfigStore();
        return saveOperatorConfigWithTx(tx, config, options);
      },
      appendSecurityInvalidationEvent: input => appendSecurityInvalidationEventWithTx(tx, input),
      writeAdminAuditEvent: async event => {
        await appendConsoleAdminAuditEventWithTx(tx, event, auditKeyResolver);
        markAuditWritten();
      },
    };
  }

  private requireRuntimeStore(): void {
    if (!this.options.runtimeSessionControlStore) {
      throw new Error('administrative runtime mutation transaction requires runtimeSessionControlStore');
    }
  }

  private requireOperatorConfigStore(): void {
    if (!this.options.operatorConfigStore) {
      throw new Error('administrative config mutation transaction requires operatorConfigStore');
    }
  }
}

type PostgresStoreConstructor<T extends object> = abstract new (...args: never[]) => T;

function resolvePostgresSigningKeyTransactionAdapter(
  store: ISigningKeyStore,
  database: DatabaseInstance,
): PostgresSigningKeyTransactionAdapter {
  const provider = store as Partial<PostgresSigningKeyTransactionProvider>;
  if (typeof provider.createPostgresTransactionAdapter !== 'function') {
    throw new Error(
      'PostgreSQL account-admin signing-key mutations require a transaction-capable store; ' +
      'register WebConsoleAccountAdminMutationTransactionRunner to compose a custom store adapter',
    );
  }
  return provider.createPostgresTransactionAdapter.call(store, database);
}

function assertPostgresMutationStoreCompatibility<T extends object>(
  store: object,
  expectedConstructor: PostgresStoreConstructor<T>,
  database: DatabaseInstance,
  label: string,
): void {
  const storeRecord = store as { readonly db?: unknown };
  if (Object.getPrototypeOf(store) !== expectedConstructor.prototype || storeRecord.db !== database) {
    throw new Error(
      `PostgreSQL account-admin ${label} mutations require the canonical store for the configured database; ` +
      'register WebConsoleAccountAdminMutationTransactionRunner to compose a custom store adapter',
    );
  }
}

export interface InMemoryAccountAdminMutationTransactionRunnerOptions {
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly accountAllowlistStore: IConsoleAccountAllowlistStore;
  readonly securityInvalidationStore: IConsoleSecurityInvalidationStore;
  readonly adminAuditWriter: IAdminAuditWriter;
  readonly signingKeyStore?: ISigningKeyStore;
  readonly authPolicyStore?: IConsoleAuthPolicyStore;
  readonly factorStore?: IConsoleFactorStore;
  readonly runtimeSessionControlStore?: IRuntimeSessionControlStore;
  readonly operatorConfigStore?: IOperatorConfigStore;
  readonly inviteIssuer?: IConsoleAccountInviteIssuer | null;
  readonly integrationStore?: IUserIntegrationStore;
  readonly loginTransactionStore?: ILoginTransactionStore;
}

export class InMemoryAccountAdminMutationTransactionRunner
implements IAccountAdminMutationTransactionRunner {
  private readonly transactionGate: InMemoryTransactionGate;
  private readonly runtimeSessionControlStore: IRuntimeSessionControlStore | undefined;
  private readonly operatorConfigStore: IOperatorConfigStore | undefined;

  constructor(private readonly options: InMemoryAccountAdminMutationTransactionRunnerOptions) {
    this.runtimeSessionControlStore = options.runtimeSessionControlStore;
    this.operatorConfigStore = options.operatorConfigStore;
    this.transactionGate = attachSharedInMemoryTransactionGate([
      options.integrationStore,
      options.loginTransactionStore,
      options.accountAdminStore,
      options.accountAllowlistStore,
      options.securityInvalidationStore,
      options.adminAuditWriter,
      options.signingKeyStore,
      options.authPolicyStore,
      options.factorStore,
      this.runtimeSessionControlStore,
      this.operatorConfigStore,
      options.inviteIssuer,
    ]);
    options.integrationStore?.configurePrincipalLifecycleFence?.({
      isPrincipalActive: async userId => {
        const principal = await options.accountAdminStore.findPrincipal(userId);
        return principal !== null && principal.disabledAt === null;
      },
    });
    options.loginTransactionStore?.configurePrincipalLifecycleFence?.({
      isPrincipalActive: async userId => {
        const principal = await options.accountAdminStore.findPrincipal(userId);
        return principal !== null && principal.disabledAt === null;
      },
    });
  }

  async run<T>(
    operation: (tx: AccountAdminMutationTransactionContext) => Promise<T>,
    actor?: Pick<ConsoleAuthenticatedContext, 'userId' | 'authzVersion'>,
  ): Promise<T> {
    return this.runWithInviteCapability(operation, false, actor);
  }

  async runInvite<T>(
    operation: (tx: AccountAdminMutationTransactionContext) => Promise<T>,
    actor?: Pick<ConsoleAuthenticatedContext, 'userId' | 'authzVersion'>,
  ): Promise<T> {
    return this.runWithInviteCapability(operation, true, actor);
  }

  private async runWithInviteCapability<T>(
    operation: (tx: AccountAdminMutationTransactionContext) => Promise<T>,
    inviteEnabled: boolean,
    actor?: Pick<ConsoleAuthenticatedContext, 'userId' | 'authzVersion'>,
  ): Promise<T> {
    const preparedInvites: PreparedConsoleAccountInviteIssue[] = [];
    const result = await this.transactionGate.runTransaction(
      () => this.runExclusive(operation, preparedInvites, inviteEnabled, actor),
    );
    for (const prepared of preparedInvites) {
      try {
        await prepared.commit();
      } catch (error) {
        throw new CommittedAccountInviteDeliveryError(prepared.result, error);
      }
    }
    return result;
  }

  private async runExclusive<T>(
    operation: (tx: AccountAdminMutationTransactionContext) => Promise<T>,
    preparedInvites: PreparedConsoleAccountInviteIssue[],
    inviteEnabled: boolean,
    actor?: Pick<ConsoleAuthenticatedContext, 'userId' | 'authzVersion'>,
  ): Promise<T> {
    if (actor) await assertInMemoryActorAuthority(this.options.accountAdminStore, actor);
    const snapshots = [
      captureInMemorySnapshot(this.options.accountAdminStore, 'accountAdminStore'),
      captureInMemorySnapshot(this.options.accountAllowlistStore, 'accountAllowlistStore'),
      captureInMemorySnapshot(this.options.securityInvalidationStore, 'securityInvalidationStore'),
      captureInMemorySnapshot(this.options.adminAuditWriter, 'adminAuditWriter'),
      ...optionalInMemorySnapshots([
        ['signingKeyStore', this.options.signingKeyStore],
        ['authPolicyStore', this.options.authPolicyStore],
        ['factorStore', this.options.factorStore],
        ['integrationStore', this.options.integrationStore],
        ['runtimeSessionControlStore', this.runtimeSessionControlStore],
        ['operatorConfigStore', this.operatorConfigStore],
      ]),
      ...optionalInviteIssuerSnapshot(this.options.inviteIssuer),
    ];
    const auditState = { writes: 0 };
    try {
      const result = await operation({
        lockPrincipal: userId => this.options.accountAdminStore.findPrincipal(userId),
        hasIntegrationCredentialMaterial: userId => this.options.integrationStore
          ? this.options.integrationStore.hasAnyCredentialMaterial(userId)
          : Promise.resolve(false),
        hasInFlightIntegrationAuthorization: userId => this.options.loginTransactionStore
          ?.hasInFlightIntegrationAuthorization?.(userId) ?? Promise.resolve(false),
        listLinkedIdentities: userId => this.options.accountAdminStore.listLinkedIdentities(userId),
        lockLinkedAuthSubjects: userId => this.options.accountAdminStore.listLinkedIdentities(userId),
        grantRole: input => this.options.accountAdminStore.grantRole(input),
        revokeRole: input => this.options.accountAdminStore.revokeRole(input),
        disablePrincipal: input => this.options.accountAdminStore.disablePrincipal(input),
        enablePrincipal: input => this.options.accountAdminStore.enablePrincipal(input),
        bumpPrincipalAuthzVersion: input => this.options.accountAdminStore.bumpPrincipalAuthzVersion(input),
        deletePrincipal: input => this.options.accountAdminStore.deletePrincipal(input),
        linkIdentity: input => this.options.accountAdminStore.linkIdentity(input),
        finalizeIdentityLink: input => this.options.accountAdminStore.finalizeIdentityLink(input),
        unlinkIdentity: input => this.options.accountAdminStore.unlinkIdentity(input),
        addAllowlistEntry: input => this.options.accountAllowlistStore.add(input),
        updateAllowlistEntry: input => this.options.accountAllowlistStore.update(input),
        removeAllowlistEntry: input => this.options.accountAllowlistStore.remove(input),
        getSigningKeyByKid: kid => requiredSecurityStore(this.options.signingKeyStore, 'signingKeyStore').getByKid(kid),
        rotateSigningKey: write => requiredSecurityStore(this.options.signingKeyStore, 'signingKeyStore').rotate(write),
        retireSigningKey: (kid, retiredAt) => requiredSecurityStore(this.options.signingKeyStore, 'signingKeyStore').retire(kid, retiredAt),
        deleteSigningKey: (kid, options) => requiredSecurityStore(this.options.signingKeyStore, 'signingKeyStore').delete(kid, options),
        loadAuthPolicy: () => requiredSecurityStore(this.options.authPolicyStore, 'authPolicyStore').load(),
        saveAuthPolicy: (policy, options) => requiredSecurityStore(this.options.authPolicyStore, 'authPolicyStore').save(policy, options),
        disableActiveTotp: (userId, disabledAt) => requiredSecurityStore(this.options.factorStore, 'factorStore').disableActiveTotp(userId, disabledAt),
        issueInvite: async input => {
          if (!inviteEnabled) {
            throw new Error('Invite issuance requires the dedicated runInvite transaction path');
          }
          const issuer = requiredTransactionalInviteIssuer(this.options.inviteIssuer);
          const prepared = await issuer.prepareIssueInvite(input);
          preparedInvites.push(prepared);
          return prepared.result;
        },
        findRuntimePresence: (sessionId, now) => requiredSecurityStore(
          this.runtimeSessionControlStore,
          'runtimeSessionControlStore',
        ).findPresence(sessionId, now),
        listAllRuntimePresenceByUser: (userId, now) => requiredSecurityStore(
          this.runtimeSessionControlStore,
          'runtimeSessionControlStore',
        ).listAllPresenceByUser(userId, now),
        createRuntimeTerminationCommand: input => requiredSecurityStore(
          this.runtimeSessionControlStore,
          'runtimeSessionControlStore',
        ).createTerminationCommand(input),
        loadOperatorConfig: () => requiredSecurityStore(
          this.operatorConfigStore,
          'operatorConfigStore',
        ).load(),
        saveOperatorConfig: (config, options) => requiredSecurityStore(
          this.operatorConfigStore,
          'operatorConfigStore',
        ).save(config, options),
        appendSecurityInvalidationEvent: input => this.options.securityInvalidationStore.appendEvent(input),
        writeAdminAuditEvent: async event => {
          await this.options.adminAuditWriter.write(event);
          auditState.writes += 1;
        },
      });
      if (auditState.writes !== 1) throw new Error('administrative mutation transaction must append exactly one admin audit event');
      return result;
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const snapshot of [...snapshots].reverse()) {
        try {
          snapshot.participant.restoreTransactionSnapshot(snapshot.value);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], 'in-memory account-admin transaction rollback failed');
      }
      throw error;
    }
  }
}

interface InMemoryTransactionParticipant {
  createTransactionSnapshot(): unknown;
  restoreTransactionSnapshot(snapshot: unknown): void;
}

interface CapturedInMemorySnapshot {
  readonly participant: InMemoryTransactionParticipant;
  readonly value: unknown;
}

function captureInMemorySnapshot(value: unknown, name: string): CapturedInMemorySnapshot {
  if (!isInMemoryTransactionParticipant(value)) {
    throw new Error(`in-memory mutation runner requires transactional ${name}`);
  }
  return { participant: value, value: value.createTransactionSnapshot() };
}

function optionalInMemorySnapshots(
  entries: readonly (readonly [string, unknown])[],
): CapturedInMemorySnapshot[] {
  return entries
    .filter((entry): entry is readonly [string, object] => entry[1] !== undefined)
    .map(([name, value]) => captureInMemorySnapshot(value, name));
}

function optionalInviteIssuerSnapshot(
  issuer: IConsoleAccountInviteIssuer | null | undefined,
): CapturedInMemorySnapshot[] {
  return isInMemoryTransactionParticipant(issuer)
    ? [{ participant: issuer, value: issuer.createTransactionSnapshot() }]
    : [];
}

function isInMemoryTransactionParticipant(value: unknown): value is InMemoryTransactionParticipant {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InMemoryTransactionParticipant>;
  return typeof candidate.createTransactionSnapshot === 'function'
    && typeof candidate.restoreTransactionSnapshot === 'function';
}

function requiredSecurityStore<T>(store: T | undefined, name: string): T {
  if (!store) throw new Error(`in-memory mutation runner requires ${name} for security-admin mutations`);
  return store;
}

function requiredInviteIssuer(issuer: IConsoleAccountInviteIssuer | null | undefined): IConsoleAccountInviteIssuer {
  if (!issuer) throw new Error('mutation runner requires accountInviteIssuer for invite mutations');
  return issuer;
}

function requiredTransactionalInviteIssuer(
  issuer: IConsoleAccountInviteIssuer | null | undefined,
): IConsoleAccountInviteIssuer & InMemoryTransactionParticipant & Required<Pick<
  IConsoleAccountInviteIssuer,
  'prepareIssueInvite'
>> {
  const required = requiredInviteIssuer(issuer);
  if (!isTransactionalInMemoryInviteIssuer(required)) {
    throw new Error('in-memory invite issuer must support transaction snapshots and staged delivery');
  }
  return required;
}

function isTransactionalInMemoryInviteIssuer(
  issuer: IConsoleAccountInviteIssuer,
): issuer is IConsoleAccountInviteIssuer & InMemoryTransactionParticipant & Required<Pick<
  IConsoleAccountInviteIssuer,
  'prepareIssueInvite'
>> {
  return isInMemoryTransactionParticipant(issuer)
    && typeof issuer.prepareIssueInvite === 'function';
}

async function assertActorAuthorityWithTx(
  tx: DrizzleTx,
  actor: Pick<ConsoleAuthenticatedContext, 'userId' | 'authzVersion'>,
): Promise<void> {
  const live = await findConsolePrincipalForUpdateWithTx(tx, actor.userId);
  assertActorAuthority(live, actor);
}

async function assertInMemoryActorAuthority(
  store: IConsoleAccountAdminStore,
  actor: Pick<ConsoleAuthenticatedContext, 'userId' | 'authzVersion'>,
): Promise<void> {
  assertActorAuthority(await store.findPrincipal(actor.userId), actor);
}

function assertActorAuthority(
  live: ConsolePrincipalSummary | null,
  actor: Pick<ConsoleAuthenticatedContext, 'userId' | 'authzVersion'>,
): void {
  if (!live || live.disabledAt !== null || live.authzVersion !== actor.authzVersion) {
    throw new Error('administrative actor authority changed before mutation commit');
  }
}
