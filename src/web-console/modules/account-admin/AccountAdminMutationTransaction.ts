import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import type { DrizzleTx } from '../../../database/db-utils.js';
import type { ConsoleAdminAuditEvent } from '../../audit/IAdminAuditWriter.js';
import {
  appendConsoleAdminAuditEventWithTx,
  type AdminAuditHmacKeyResolver,
} from '../../audit/PostgresAdminAuditWriter.js';
import {
  disableConsolePrincipalWithTx,
  enableConsolePrincipalWithTx,
  grantConsoleAdminRoleWithTx,
  bumpConsolePrincipalAuthzVersionWithTx,
  revokeConsoleAdminRoleWithTx,
} from '../../stores/PostgresConsoleAccountAdminStore.js';
import type {
  ConsoleRoleAssignment,
  PrincipalAuthzVersionBumpInput,
  PrincipalDisableInput,
  PrincipalEnableInput,
  PrincipalStateChange,
  RoleGrantInput,
  RoleRevokeInput,
} from '../../stores/IConsoleAccountAdminStore.js';
import {
  appendSecurityInvalidationEventWithTx,
} from '../../services/invalidation/PostgresConsoleSecurityInvalidationStore.js';
import type { IAdminAuditWriter } from '../../audit/IAdminAuditWriter.js';
import type {
  IConsoleSecurityInvalidationStore,
  SecurityInvalidationEvent,
  SecurityInvalidationEventInput,
} from '../../services/invalidation/IConsoleSecurityInvalidationStore.js';
import type { IConsoleAccountAdminStore } from '../../stores/IConsoleAccountAdminStore.js';

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
