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
  revokeConsoleAdminRoleWithTx,
} from '../../stores/PostgresConsoleAccountAdminStore.js';
import type {
  ConsoleRoleAssignment,
  PrincipalDisableInput,
  PrincipalEnableInput,
  PrincipalStateChange,
  RoleGrantInput,
  RoleRevokeInput,
} from '../../stores/IConsoleAccountAdminStore.js';
import {
  appendSecurityInvalidationEventWithTx,
} from '../../services/invalidation/PostgresConsoleSecurityInvalidationStore.js';
import type {
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
    return withSystemContext(this.options.db, async tx => operation(this.contextFor(tx)));
  }

  private contextFor(tx: DrizzleTx): AccountAdminMutationTransactionContext {
    return {
      grantRole: input => grantConsoleAdminRoleWithTx(tx, input),
      revokeRole: input => revokeConsoleAdminRoleWithTx(tx, input),
      disablePrincipal: input => disableConsolePrincipalWithTx(tx, input),
      enablePrincipal: input => enableConsolePrincipalWithTx(tx, input),
      appendSecurityInvalidationEvent: input => appendSecurityInvalidationEventWithTx(tx, input),
      writeAdminAuditEvent: event => appendConsoleAdminAuditEventWithTx(tx, event, this.options.hmacKeyResolver),
    };
  }
}
