import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import type { DrizzleTx } from '../../../database/db-utils.js';
import type { ConsoleAdminAuditEvent , IAdminAuditWriter } from '../../audit/IAdminAuditWriter.js';
import {
  appendConsoleAdminAuditEventWithTx,
  type AdminAuditHmacKeyResolver,
} from '../../audit/PostgresAdminAuditWriter.js';
import {
  deleteConsolePrincipalWithTx,
  disableConsolePrincipalWithTx,
  enableConsolePrincipalWithTx,
  grantConsoleAdminRoleWithTx,
  linkConsoleIdentityWithTx,
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
  IdentityLinkInput,
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
 IConsoleAccountAdminStore } from '../../stores/IConsoleAccountAdminStore.js';
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

export interface MutationTransactionBaseContext {
  appendSecurityInvalidationEvent(input: SecurityInvalidationEventInput): Promise<SecurityInvalidationEvent>;
  writeAdminAuditEvent(event: ConsoleAdminAuditEvent): Promise<void>;
}

export interface AccountAdminMutationTransactionContext extends MutationTransactionBaseContext {
  grantRole(input: RoleGrantInput): Promise<ConsoleRoleAssignment>;
  revokeRole(input: RoleRevokeInput): Promise<ConsoleRoleAssignment | null>;
  disablePrincipal(input: PrincipalDisableInput): Promise<PrincipalStateChange | null>;
  enablePrincipal(input: PrincipalEnableInput): Promise<PrincipalStateChange | null>;
  bumpPrincipalAuthzVersion(input: PrincipalAuthzVersionBumpInput): Promise<PrincipalStateChange | null>;
  deletePrincipal(input: PrincipalDeletionInput): Promise<PrincipalDeletionOutcome | null>;
  linkIdentity(input: IdentityLinkInput): Promise<IdentityMutationResult | null>;
  unlinkIdentity(input: IdentityUnlinkInput): Promise<IdentityMutationResult | null>;
  addAllowlistEntry(input: AllowlistAddInput): Promise<ConsoleAccountAllowlistEntry>;
  updateAllowlistEntry(input: AllowlistUpdateInput): Promise<ConsoleAccountAllowlistEntry | null>;
  removeAllowlistEntry(input: AllowlistRemoveInput): Promise<ConsoleAccountAllowlistEntry | null>;
}

export interface IAccountAdminMutationTransactionRunner {
  /**
   * Executes account-admin mutation work in one system transaction.
   *
   * Successful administrative mutations must append their durable audit event in
   * this callback. Write the audit event after domain/invalidation writes to
   * keep lock acquisition ordered consistently across mutation services.
   */
  run<T>(operation: (tx: AccountAdminMutationTransactionContext) => Promise<T>): Promise<T>;
}

export interface PostgresAccountAdminMutationTransactionRunnerOptions {
  readonly db: DatabaseInstance;
  readonly hmacKeyResolver: AdminAuditHmacKeyResolver;
}

export class PostgresAccountAdminMutationTransactionRunner
implements IAccountAdminMutationTransactionRunner {
  constructor(private readonly options: PostgresAccountAdminMutationTransactionRunnerOptions) {}

  async run<T>(operation: (tx: AccountAdminMutationTransactionContext) => Promise<T>): Promise<T> {
    return withSystemContext(this.options.db, async tx => {
      const auditState = { writes: 0 };
      const result = await operation(this.contextFor(tx, () => {
        auditState.writes += 1;
      }));
      if (auditState.writes === 0) throw new Error('account-admin mutation transaction completed without admin audit');
      return result;
    });
  }

  private contextFor(tx: DrizzleTx, markAuditWritten: () => void): AccountAdminMutationTransactionContext {
    return {
      grantRole: input => grantConsoleAdminRoleWithTx(tx, input),
      revokeRole: input => revokeConsoleAdminRoleWithTx(tx, input),
      disablePrincipal: input => disableConsolePrincipalWithTx(tx, input),
      enablePrincipal: input => enableConsolePrincipalWithTx(tx, input),
      bumpPrincipalAuthzVersion: input => bumpConsolePrincipalAuthzVersionWithTx(tx, input),
      deletePrincipal: input => deleteConsolePrincipalWithTx(tx, input),
      linkIdentity: input => linkConsoleIdentityWithTx(tx, input),
      unlinkIdentity: input => unlinkConsoleIdentityWithTx(tx, input),
      addAllowlistEntry: input => addAccountAllowlistEntryWithTx(tx, input),
      updateAllowlistEntry: input => updateAccountAllowlistEntryWithTx(tx, input),
      removeAllowlistEntry: input => removeAccountAllowlistEntryWithTx(tx, input),
      appendSecurityInvalidationEvent: input => appendSecurityInvalidationEventWithTx(tx, input),
      writeAdminAuditEvent: async event => {
        await appendConsoleAdminAuditEventWithTx(tx, event, this.options.hmacKeyResolver);
        markAuditWritten();
      },
    };
  }
}

export interface InMemoryAccountAdminMutationTransactionRunnerOptions {
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly accountAllowlistStore: IConsoleAccountAllowlistStore;
  readonly securityInvalidationStore: IConsoleSecurityInvalidationStore;
  readonly adminAuditWriter: IAdminAuditWriter;
}

export class InMemoryAccountAdminMutationTransactionRunner
implements IAccountAdminMutationTransactionRunner {
  constructor(private readonly options: InMemoryAccountAdminMutationTransactionRunnerOptions) {}

  async run<T>(operation: (tx: AccountAdminMutationTransactionContext) => Promise<T>): Promise<T> {
    const auditState = { writes: 0 };
    const result = await operation({
      grantRole: input => this.options.accountAdminStore.grantRole(input),
      revokeRole: input => this.options.accountAdminStore.revokeRole(input),
      disablePrincipal: input => this.options.accountAdminStore.disablePrincipal(input),
      enablePrincipal: input => this.options.accountAdminStore.enablePrincipal(input),
      bumpPrincipalAuthzVersion: input => this.options.accountAdminStore.bumpPrincipalAuthzVersion(input),
      deletePrincipal: input => this.options.accountAdminStore.deletePrincipal(input),
      linkIdentity: input => this.options.accountAdminStore.linkIdentity(input),
      unlinkIdentity: input => this.options.accountAdminStore.unlinkIdentity(input),
      addAllowlistEntry: input => this.options.accountAllowlistStore.add(input),
      updateAllowlistEntry: input => this.options.accountAllowlistStore.update(input),
      removeAllowlistEntry: input => this.options.accountAllowlistStore.remove(input),
      appendSecurityInvalidationEvent: input => this.options.securityInvalidationStore.appendEvent(input),
      writeAdminAuditEvent: async event => {
        await this.options.adminAuditWriter.write(event);
        auditState.writes += 1;
      },
    });
    if (auditState.writes === 0) throw new Error('account-admin mutation transaction completed without admin audit');
    return result;
  }
}
