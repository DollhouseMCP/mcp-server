import type { ConsoleAdminAuditResult } from '../../audit/IAdminAuditWriter.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { ConsoleHandlerResult, ConsoleRequest, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import type {
  ConsolePrincipalSummary,
  IConsoleAccountAdminStore,
} from '../../stores/IConsoleAccountAdminStore.js';
import type {
  AccountAdminMutationTransactionContext,
  IAccountAdminMutationTransactionRunner,
} from './AccountAdminMutationTransaction.js';
import type {
  ConsoleOAuthGrantRevocationSummary,
  IOAuthGrantRevocationService,
} from '../../services/oauth/IConsoleOAuthGrantRevocationService.js';
import type { IConsoleSecurityInvalidationStore } from '../../services/invalidation/IConsoleSecurityInvalidationStore.js';
import { waitForSecurityInvalidationAcknowledgements } from '../../services/invalidation/ConsoleSecurityInvalidationAcknowledgement.js';
import type { IConsoleSessionStore } from '../../stores/IConsoleSessionStore.js';
import type { RuntimeTerminationCommand } from '../../services/runtime/IRuntimeSessionControlStore.js';
import { rolesActorMayNotManage } from './AccountAdminRoleAuthority.js';
import { serializeAccountPrincipalLifecycle } from './AccountAdminDtos.js';
import {
  emptyRuntimeTerminationSummary,
  runtimeTerminationErrorCode,
  type AccountAdminRuntimeTerminationService,
  type AccountRuntimeTerminationSummary,
} from './AccountAdminRuntimeTerminationService.js';

export interface AccountAdminLifecycleMutationServiceOptions {
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly transactionRunner: IAccountAdminMutationTransactionRunner;
  readonly sessionStore: Pick<IConsoleSessionStore, 'revokeForUser'>;
  readonly securityInvalidationStore?: Pick<IConsoleSecurityInvalidationStore,
    'listLiveReplicaIds' | 'listAcknowledgedReplicaIds'> | null;
  readonly invalidationAcknowledgementTimeoutMs?: number;
  readonly runtimeTerminationService?: AccountAdminRuntimeTerminationService | null;
  readonly oauthGrantRevocationService?: IOAuthGrantRevocationService | null;
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

    let committedBefore = before;
    let disabledAuthzVersion = before.authzVersion;
    let invalidationEventId: string | null = null;
    try {
      const rejection = await this.options.transactionRunner.run(async tx => {
        const lockedPrincipal = await tx.lockPrincipal(userId);
        if (!lockedPrincipal) {
          await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
            route, req, result: 'failed', errorCode: 'not_found', occurredAt, userId,
            argsRedacted: { operation: 'disable' }, resultDetailRedacted: null,
          }));
          return problem(404, 'not_found', 'Not found', 'User principal was not found.');
        }
        if (lockedPrincipal.disabledAt) {
          await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
            route, req, result: 'conflict', errorCode: 'conflict', occurredAt, userId,
            argsRedacted: { operation: 'disable', already_disabled: true }, resultDetailRedacted: null,
          }));
          return problem(409, 'conflict', 'Conflict', 'User principal is already disabled.');
        }
        const unauthorizedRoles = rolesActorMayNotManage(req, lockedPrincipal.roles);
        if (unauthorizedRoles.length > 0) {
          await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
            route, req, result: 'rejected', errorCode: 'insufficient_role_authority', occurredAt, userId,
            argsRedacted: { operation: 'disable', roles: unauthorizedRoles }, resultDetailRedacted: null,
          }));
          return insufficientRoleAuthorityProblem();
        }
        committedBefore = lockedPrincipal;
        const change = await tx.disablePrincipal({ userId, disabledAt: occurredAt });
        if (!change) throw new DisablePrincipalNoChangeError();
        disabledAuthzVersion = change.authzVersion;
        const invalidationEvent = await tx.appendSecurityInvalidationEvent({
          kind: 'principal_disabled',
          urgency: 'acknowledged',
          userId,
          authzVersion: change.authzVersion,
          reason: 'account_admin_principal_disabled',
          payload: {
            terminatedRuntimeSessions: Boolean(this.options.runtimeTerminationService),
          },
          createdAt: occurredAt,
          createdByUserId: actor.userId,
        });
        invalidationEventId = invalidationEvent.eventId;
        await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
          route,
          req,
          result: 'approved',
          errorCode: null,
          occurredAt,
          userId,
          argsRedacted: { operation: 'disable' },
          resultDetailRedacted: {
            previousAuthzVersion: lockedPrincipal.authzVersion,
            newAuthzVersion: change.authzVersion,
          },
        }));
        return null;
      }, actor);
      if (rejection) return rejection;
    } catch (error) {
      if (error instanceof DisablePrincipalNoChangeError) {
        return this.handleDisableNoChange(req, route, userId);
      }
      throw error;
    }

    const disabled = withLifecycleState(committedBefore, occurredAt, disabledAuthzVersion);
    let browserSessionsRevoked = 0;
    let browserSessionRevocationFailed = false;
    try {
      browserSessionsRevoked = await this.options.sessionStore.revokeForUser(userId, occurredAt);
    } catch {
      browserSessionRevocationFailed = true;
    }
    const invalidationAcknowledged = !invalidationEventId || await waitForSecurityInvalidationAcknowledgements({
      store: this.options.securityInvalidationStore,
      eventId: invalidationEventId,
      occurredAt,
      timeoutMs: this.options.invalidationAcknowledgementTimeoutMs,
    });
    if (browserSessionRevocationFailed) {
      return problem(
        503,
        'service_unavailable',
        'Service unavailable',
        'The principal is disabled, but browser-session revocation must be retried before re-enabling.',
      );
    }
    if (!invalidationAcknowledged) {
      return problem(
        503,
        'service_unavailable',
        'Service unavailable',
        'The principal is disabled, but cluster session invalidation has not yet been acknowledged.',
      );
    }
    const oauthSummary = await this.revokePrincipalGrants(req, route, userId, occurredAt, 'disable');
    const runtimeSummary = await this.terminateRuntimeSessions(req, route, userId, actor.userId, 'disable');
    if (!oauthSummary || runtimeSummary.timedOut > 0 || runtimeSummary.failed > 0) {
      return {
        status: 503,
        body: serializeAccountPrincipalLifecycle(
          disabled,
          runtimeRevocationSummary(
            runtimeSummary,
            disabledAuthzVersion,
            browserSessionsRevoked,
            oauthSummary?.oauthGrantFamiliesRevoked ?? 0,
          ),
        ),
      };
    }
    return {
      status: 200,
      body: serializeAccountPrincipalLifecycle(
        disabled,
        runtimeRevocationSummary(
          runtimeSummary,
          disabledAuthzVersion,
          browserSessionsRevoked,
          oauthSummary.oauthGrantFamiliesRevoked,
        ),
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
    const unauthorizedRoles = rolesActorMayNotManage(req, before.roles);
    if (unauthorizedRoles.length > 0) {
      await this.writeAttemptAudit(req, route, 'rejected', 'insufficient_role_authority', userId, {
        operation: 'enable', roles: unauthorizedRoles,
      });
      return insufficientRoleAuthorityProblem();
    }
    const runtimePreflight = await this.requestEnableRuntimeTermination(
      req,
      route,
      userId,
      actor,
      occurredAt,
    );
    if ('status' in runtimePreflight) return runtimePreflight;
    const runtimeSummary = await this.awaitEnableRuntimeTermination(
      req,
      route,
      userId,
      runtimePreflight.commands,
    );
    if (runtimeSummary.timedOut > 0 || runtimeSummary.failed > 0) {
      return problem(
        503,
        'service_unavailable',
        'Service unavailable',
        'MCP runtime sessions could not be terminated; the principal remains disabled.',
      );
    }
    let committedBefore = before;
    let enabledAuthzVersion = before.authzVersion;
    const rejection = await this.options.transactionRunner.run(async tx => {
      const lockedPrincipal = await tx.lockPrincipal(userId);
      if (!lockedPrincipal) {
        await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
          route, req, result: 'failed', errorCode: 'not_found', occurredAt, userId,
          argsRedacted: { operation: 'enable' }, resultDetailRedacted: null,
        }));
        return problem(404, 'not_found', 'Not found', 'User principal was not found.');
      }
      if (!lockedPrincipal.disabledAt) {
        await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
          route, req, result: 'conflict', errorCode: 'conflict', occurredAt, userId,
          argsRedacted: { operation: 'enable', already_enabled: true }, resultDetailRedacted: null,
        }));
        return problem(409, 'conflict', 'Conflict', 'User principal is already enabled.');
      }
      const unauthorizedRoles = rolesActorMayNotManage(req, lockedPrincipal.roles);
      if (unauthorizedRoles.length > 0) {
        await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
          route, req, result: 'rejected', errorCode: 'insufficient_role_authority', occurredAt, userId,
          argsRedacted: { operation: 'enable', roles: unauthorizedRoles }, resultDetailRedacted: null,
        }));
        return insufficientRoleAuthorityProblem();
      }
      const linkedSubjects = (await tx.listLinkedIdentities(userId)).map(identity => identity.sub);
      try {
        await this.revokeBrowserSessionsWithTx(tx, userId, occurredAt);
      } catch {
        await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
          route, req, result: 'failed', errorCode: 'service_unavailable', occurredAt, userId,
          argsRedacted: { operation: 'enable', phase: 'browser_session_revocation' },
          resultDetailRedacted: null,
        }));
        return problem(
          503,
          'service_unavailable',
          'Service unavailable',
          'Browser sessions could not be revoked; the principal remains disabled.',
        );
      }
      try {
        for (const sub of linkedSubjects) {
          await this.revokeSubjectGrantsWithTx(tx, sub, occurredAt);
        }
      } catch {
        await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
          route, req, result: 'failed', errorCode: 'service_unavailable', occurredAt, userId,
          argsRedacted: { operation: 'enable', phase: 'oauth_grant_revocation' },
          resultDetailRedacted: null,
        }));
        return problem(
          503,
          'service_unavailable',
          'Service unavailable',
          'OAuth credentials could not be revoked; the principal remains disabled.',
        );
      }
      committedBefore = lockedPrincipal;
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
          previousAuthzVersion: lockedPrincipal.authzVersion,
          newAuthzVersion: change.authzVersion,
        },
      }));
      return null;
    }, actor);
    if (rejection) return rejection;

    return {
      status: 200,
      body: serializeAccountPrincipalLifecycle(withLifecycleState(committedBefore, null, enabledAuthzVersion)),
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

  private async revokeBrowserSessionsWithTx(
    tx: AccountAdminMutationTransactionContext,
    userId: string,
    revokedAt: Date,
  ): Promise<number> {
    return tx.revokeBrowserSessionsForUser
      ? tx.revokeBrowserSessionsForUser(userId, revokedAt)
      : this.options.sessionStore.revokeForUser(userId, revokedAt);
  }

  private async revokeSubjectGrantsWithTx(
    tx: AccountAdminMutationTransactionContext,
    sub: string,
    revokedAt: Date,
  ): Promise<void> {
    if (tx.revokeOAuthSubjectGrants) {
      await tx.revokeOAuthSubjectGrants(sub);
      return;
    }
    const revoke = this.options.oauthGrantRevocationService?.revokeSubjectGrants;
    if (!revoke) throw new Error('OAuth subject grant revocation is unavailable');
    await revoke.call(this.options.oauthGrantRevocationService, sub, revokedAt);
  }

  private async terminateRuntimeSessions(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
    actorUserId: string,
    operation: string,
  ): Promise<AccountRuntimeTerminationSummary> {
    if (!this.options.runtimeTerminationService) return emptyRuntimeTerminationSummary();
    try {
      const summary = await this.options.runtimeTerminationService.terminatePrincipalSessions({
        userId,
        requestedByUserId: actorUserId,
        reason: 'admin_disabled',
      });
      await this.writeAttemptAudit(
        req,
        route,
        summary.timedOut > 0 || summary.failed > 0 ? 'failed' : 'approved',
        runtimeTerminationErrorCode(summary),
        userId,
        {
          operation,
          phase: 'post_commit_runtime_termination',
        },
      );
      return summary;
    } catch {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, {
        operation,
        phase: 'post_commit_runtime_termination',
      });
      return {
        ...emptyRuntimeTerminationSummary(),
        failed: 1,
      };
    }
  }

  private async requestEnableRuntimeTermination(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
    actor: ReturnType<typeof requireConsoleAuthentication>,
    occurredAt: Date,
  ): Promise<ConsoleHandlerResult | {
    readonly commands: readonly Pick<RuntimeTerminationCommand, 'commandId'>[];
  }> {
    if (!this.options.runtimeTerminationService) return { commands: [] };
    let commands: readonly Pick<RuntimeTerminationCommand, 'commandId'>[] = [];
    const rejection = await this.options.transactionRunner.run(async tx => {
      const lockedPrincipal = await tx.lockPrincipal(userId);
      if (!lockedPrincipal) {
        await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
          route, req, result: 'failed', errorCode: 'not_found', occurredAt, userId,
          argsRedacted: { operation: 'enable', phase: 'runtime_termination_request' },
          resultDetailRedacted: null,
        }));
        return problem(404, 'not_found', 'Not found', 'User principal was not found.');
      }
      if (!lockedPrincipal.disabledAt) {
        await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
          route, req, result: 'conflict', errorCode: 'conflict', occurredAt, userId,
          argsRedacted: {
            operation: 'enable', phase: 'runtime_termination_request', already_enabled: true,
          },
          resultDetailRedacted: null,
        }));
        return problem(409, 'conflict', 'Conflict', 'User principal is already enabled.');
      }
      const unauthorizedRoles = rolesActorMayNotManage(req, lockedPrincipal.roles);
      if (unauthorizedRoles.length > 0) {
        await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
          route, req, result: 'rejected', errorCode: 'insufficient_role_authority', occurredAt, userId,
          argsRedacted: {
            operation: 'enable', phase: 'runtime_termination_request', roles: unauthorizedRoles,
          },
          resultDetailRedacted: null,
        }));
        return insufficientRoleAuthorityProblem();
      }
      const sessions = await tx.listAllRuntimePresenceByUser(userId, occurredAt);
      commands = await Promise.all(sessions.map(session => tx.createRuntimeTerminationCommand({
        sessionId: session.sessionId,
        targetReplicaId: session.replicaId,
        reason: 'admin_disabled',
        requestedAt: occurredAt,
        requestedBy: { kind: 'admin', userId: actor.userId },
      })));
      await tx.writeAdminAuditEvent(buildLifecycleAuditEvent({
        route, req, result: 'approved', errorCode: null, occurredAt, userId,
        argsRedacted: { operation: 'enable', phase: 'runtime_termination_request' },
        resultDetailRedacted: { commandsCreated: commands.length },
      }));
      return null;
    }, actor);
    return rejection ?? { commands };
  }

  private async awaitEnableRuntimeTermination(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
    commands: readonly Pick<RuntimeTerminationCommand, 'commandId'>[],
  ): Promise<AccountRuntimeTerminationSummary> {
    if (!this.options.runtimeTerminationService) return emptyRuntimeTerminationSummary();
    try {
      const summary = await this.options.runtimeTerminationService.awaitTerminationCommands(commands);
      await this.writeAttemptAudit(
        req,
        route,
        summary.timedOut > 0 || summary.failed > 0 ? 'failed' : 'approved',
        runtimeTerminationErrorCode(summary),
        userId,
        { operation: 'enable', phase: 'runtime_termination_acknowledgement' },
      );
      return summary;
    } catch {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, {
        operation: 'enable', phase: 'runtime_termination_acknowledgement',
      });
      return { ...emptyRuntimeTerminationSummary(), failed: 1 };
    }
  }

  private async revokePrincipalGrants(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
    revokedAt: Date,
    operation: 'disable' | 'enable',
  ): Promise<ConsoleOAuthGrantRevocationSummary | null> {
    const service = this.options.oauthGrantRevocationService;
    if (!service) {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, {
        operation,
        phase: 'oauth_grant_revocation',
      });
      return null;
    }
    try {
      return await service.revokePrincipalGrants({ userId, revokedAt });
    } catch {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, {
        operation,
        phase: 'oauth_grant_revocation',
      });
      return null;
    }
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
    disabledAt: disabledAt ? new Date(disabledAt) : null,
    authzVersion,
  };
}

function runtimeRevocationSummary(
  summary: AccountRuntimeTerminationSummary,
  authzVersion: number,
  browserSessionsRevoked: number,
  oauthGrantFamiliesRevoked: number,
) {
  return {
    browser_sessions_revoked: browserSessionsRevoked,
    mcp_oauth_grants_revoked: oauthGrantFamiliesRevoked,
    mcp_sessions_terminated: summary.terminated + summary.alreadyAbsent,
    mcp_sessions_termination_requested: summary.requested,
    mcp_sessions_termination_acknowledged: summary.acknowledged,
    mcp_sessions_termination_failed: summary.failed,
    mcp_sessions_termination_timed_out: summary.timedOut,
    authz_version_bumped: true,
    new_authz_version: authzVersion,
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

function insufficientRoleAuthorityProblem(): ConsoleHandlerResult {
  return problem(
    403,
    'insufficient_role_authority',
    'Forbidden',
    'Actor cannot manage a principal whose active roles are outside their assigned capability tier.',
  );
}

class DisablePrincipalNoChangeError extends Error {
  constructor() {
    super('principal disable mutation did not update a row');
    this.name = 'DisablePrincipalNoChangeError';
  }
}
