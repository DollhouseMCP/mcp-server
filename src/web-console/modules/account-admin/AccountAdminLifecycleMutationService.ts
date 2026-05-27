import type { ConsoleAdminAuditResult } from '../../audit/IAdminAuditWriter.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { ConsoleHandlerResult, ConsoleRequest, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import type {
  ConsolePrincipalSummary,
  IConsoleAccountAdminStore,
} from '../../stores/IConsoleAccountAdminStore.js';
import type { IAccountAdminMutationTransactionRunner } from './AccountAdminMutationTransaction.js';
import { serializeAccountPrincipalLifecycle } from './AccountAdminDtos.js';

export interface AccountAdminLifecycleMutationServiceOptions {
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly transactionRunner: IAccountAdminMutationTransactionRunner;
  readonly now?: () => Date;
}

export class AccountAdminLifecycleMutationService {
  constructor(private readonly options: AccountAdminLifecycleMutationServiceOptions) {}

  async disablePrincipal(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
  ): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const occurredAt = this.now();
    const before = await this.options.accountAdminStore.findPrincipal(userId);
    if (!before) {
      await this.writeAttemptAudit(req, route, 'failed', 'not_found', userId, {});
      return problem(404, 'not_found', 'Not found', 'User principal was not found.');
    }
    if (before.disabledAt) {
      await this.writeAttemptAudit(req, route, 'conflict', 'conflict', userId, { already_disabled: true });
      return problem(409, 'conflict', 'Conflict', 'User principal is already disabled.');
    }

    let disabledAuthzVersion = before.authzVersion;
    try {
      await this.options.transactionRunner.run(async tx => {
        const change = await tx.disablePrincipal({ userId, disabledAt: occurredAt });
        if (!change) throw new DisablePrincipalNoChangeError();
        disabledAuthzVersion = change.authzVersion;
        await tx.appendSecurityInvalidationEvent({
          kind: 'principal_disabled',
          urgency: 'eventual',
          userId,
          authzVersion: change.authzVersion,
          reason: 'account_admin_principal_disabled',
          createdAt: occurredAt,
          createdByUserId: actor.userId,
        });
        await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
          route,
          req,
          result: 'approved',
          errorCode: null,
          occurredAt,
          userId,
          argsRedacted: { operation: 'disable' },
          resultDetailRedacted: {
            previousAuthzVersion: before.authzVersion,
            newAuthzVersion: change.authzVersion,
          },
        }));
      });
    } catch (error) {
      if (error instanceof DisablePrincipalNoChangeError) {
        return this.handleDisableNoChange(req, route, userId);
      }
      throw error;
    }

    return {
      status: 200,
      body: serializeAccountPrincipalLifecycle(
        withLifecycleState(before, occurredAt, disabledAuthzVersion),
      ),
    };
  }

  async enablePrincipal(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
  ): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const occurredAt = this.now();
    const before = await this.options.accountAdminStore.findPrincipal(userId);
    if (!before) {
      await this.writeAttemptAudit(req, route, 'failed', 'not_found', userId, {});
      return problem(404, 'not_found', 'Not found', 'User principal was not found.');
    }
    if (!before.disabledAt) {
      await this.writeAttemptAudit(req, route, 'conflict', 'conflict', userId, { already_enabled: true });
      return problem(409, 'conflict', 'Conflict', 'User principal is already enabled.');
    }

    let enabledAuthzVersion = before.authzVersion;
    await this.options.transactionRunner.run(async tx => {
      const change = await tx.enablePrincipal({ userId, enabledAt: occurredAt });
      if (!change) throw new Error('enabled principal mutation did not update a row');
      enabledAuthzVersion = change.authzVersion;
      await tx.appendSecurityInvalidationEvent({
        kind: 'principal_reenabled',
        urgency: 'eventual',
        userId,
        authzVersion: change.authzVersion,
        reason: 'account_admin_principal_reenabled',
        createdAt: occurredAt,
        createdByUserId: actor.userId,
      });
      await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
        route,
        req,
        result: 'approved',
        errorCode: null,
        occurredAt,
        userId,
        argsRedacted: { operation: 'enable' },
        resultDetailRedacted: {
          previousAuthzVersion: before.authzVersion,
          newAuthzVersion: change.authzVersion,
        },
      }));
    });

    return {
      status: 200,
      body: serializeAccountPrincipalLifecycle(withLifecycleState(before, null, enabledAuthzVersion)),
    };
  }

  private async handleDisableNoChange(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
  ): Promise<ConsoleHandlerResult> {
    const current = await this.options.accountAdminStore.findPrincipal(userId);
    if (!current) {
      await this.writeAttemptAudit(req, route, 'failed', 'not_found', userId, { operation: 'disable' });
      return problem(404, 'not_found', 'Not found', 'User principal was not found.');
    }
    if (current.disabledAt) {
      await this.writeAttemptAudit(req, route, 'conflict', 'conflict', userId, {
        operation: 'disable',
        already_disabled: true,
      });
      return problem(409, 'conflict', 'Conflict', 'User principal is already disabled.');
    }
    await this.writeAttemptAudit(
      req,
      route,
      'rejected',
      'would_orphan_accounts_admin',
      userId,
      { operation: 'disable' },
    );
    return problem(
      422,
      'would_orphan_accounts_admin',
      'Validation failed',
      'Disabling this principal would leave zero enabled account administrators.',
    );
  }

  private async writeAttemptAudit(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    result: ConsoleAdminAuditResult,
    errorCode: string | null,
    targetUserId: string | null,
    argsRedacted: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.options.transactionRunner.run(tx => tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
      route,
      req,
      result,
      errorCode,
      occurredAt: this.now(),
      userId: targetUserId,
      argsRedacted,
      resultDetailRedacted: null,
    })));
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

interface LifecycleAuditEventInput {
  readonly route: ConsoleRouteDefinition;
  readonly req: ConsoleRequest;
  readonly result: ConsoleAdminAuditResult;
  readonly errorCode: string | null;
  readonly occurredAt: Date;
  readonly userId: string | null;
  readonly argsRedacted: Readonly<Record<string, unknown>>;
  readonly resultDetailRedacted: Readonly<Record<string, unknown>> | null;
}

function buildLifecycleAuditEvent(input: LifecycleAuditEventInput) {
  const { route, req, result, errorCode, occurredAt, userId, argsRedacted, resultDetailRedacted } = input;
  return buildConsoleAdminAuditEvent(route, route.auditOperation ?? '', req, result, errorCode, occurredAt, {
    resourceKind: 'account_principal',
    resourceId: userId,
    targetUserId: userId,
    argsRedacted,
    resultDetailRedacted,
  });
}

function withLifecycleState(
  principal: ConsolePrincipalSummary,
  disabledAt: Date | null,
  authzVersion: number,
): ConsolePrincipalSummary {
  return {
    ...principal,
    disabledAt: disabledAt ? new Date(disabledAt.getTime()) : null,
    authzVersion,
  };
}

function problem(status: number, code: string, title: string, detail: string): ConsoleHandlerResult {
  return {
    status,
    body: {
      type: 'about:blank',
      title,
      status,
      code,
      detail,
    },
  };
}

class DisablePrincipalNoChangeError extends Error {
  constructor() {
    super('principal disable mutation did not update a row');
    this.name = 'DisablePrincipalNoChangeError';
  }
}
