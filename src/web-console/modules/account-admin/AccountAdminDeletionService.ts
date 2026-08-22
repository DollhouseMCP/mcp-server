import type { ConsoleAdminAuditResult } from '../../audit/IAdminAuditWriter.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { ConsoleHandlerResult, ConsoleRequest, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import {
  WouldOrphanAccountsAdminError,
  type IConsoleAccountAdminStore,
  type PrincipalDeletionOutcome,
} from '../../stores/IConsoleAccountAdminStore.js';
import type { IAccountAdminMutationTransactionRunner } from './AccountAdminMutationTransaction.js';
import type { IConsoleSessionStore } from '../../stores/IConsoleSessionStore.js';
import type { IOAuthGrantRevocationService } from '../../services/oauth/IConsoleOAuthGrantRevocationService.js';
import type { RuntimeTerminationCommand } from '../../services/runtime/IRuntimeSessionControlStore.js';
import { rolesActorMayNotManage } from './AccountAdminRoleAuthority.js';
import { serializeAccountDeletion, type AccountDeletionDto } from './AccountAdminDtos.js';
import {
  emptyRuntimeTerminationSummary,
  type AccountAdminRuntimeTerminationService,
  type AccountRuntimeTerminationSummary,
} from './AccountAdminRuntimeTerminationService.js';

export interface AccountAdminDeletionServiceOptions {
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly transactionRunner: IAccountAdminMutationTransactionRunner;
  readonly runtimeTerminationService?: AccountAdminRuntimeTerminationService | null;
  readonly sessionStore?: Pick<IConsoleSessionStore, 'revokeForUser'> | null;
  readonly oauthGrantRevocationService?: IOAuthGrantRevocationService | null;
  readonly now?: () => Date;
}

/**
 * Hard account deletion. The account is always fully removed (login records,
 * factors, roles, sessions, OAuth grants); the `users` row is then either
 * hard-deleted or — when an audit/authorship RESTRICT reference forbids that —
 * scrubbed to a PII-free tombstone that anchors the tamper-evident audit chain.
 */
export class AccountAdminDeletionService {
  constructor(private readonly options: AccountAdminDeletionServiceOptions) {}

  async deletePrincipal(
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
    if (userId === actor.userId) {
      await this.writeAttemptAudit(req, route, 'rejected', 'cannot_delete_self', userId, {});
      return problem(422, 'cannot_delete_self', 'Validation failed', 'You cannot delete the account you are signed in as.');
    }
    const targetIsAccountsAdmin = before.roles.includes('admin') || before.roles.includes('account_admin');
    if (targetIsAccountsAdmin && await this.options.accountAdminStore.countEnabledAccountsAdmins() <= 1) {
      await this.writeAttemptAudit(req, route, 'rejected', 'would_orphan_accounts_admin', userId, {});
      return problem(
        422,
        'would_orphan_accounts_admin',
        'Validation failed',
        'Deleting this principal would leave zero enabled account administrators.',
      );
    }

    let deletion: PrincipalDeletionOutcome;
    let deletedLinkedSubjects: readonly string[] = [];
    let terminationCommands: readonly RuntimeTerminationCommand[] = [];
    try {
      const outcome = await this.options.transactionRunner.run(async tx => {
        const lockedPrincipal = await tx.lockPrincipal(userId);
        if (!lockedPrincipal) {
          await tx.writeAdminAuditEvent(buildDeletionAuditEvent({
            route, req, result: 'failed', errorCode: 'not_found', occurredAt,
            targetUserId: userId, resourceId: userId,
            argsRedacted: { operation: 'delete' }, resultDetailRedacted: null,
          }));
          return {
            kind: 'rejected',
            response: problem(404, 'not_found', 'Not found', 'User principal was not found.'),
          } as const;
        }
        if (await tx.hasIntegrationCredentialMaterial(userId)) {
          await tx.writeAdminAuditEvent(buildDeletionAuditEvent({
            route, req, result: 'rejected', errorCode: 'integration_credentials_present', occurredAt,
            targetUserId: userId, resourceId: userId,
            argsRedacted: { operation: 'delete' }, resultDetailRedacted: null,
          }));
          return {
            kind: 'rejected',
            response: problem(
              409,
              'integration_credentials_present',
              'Integration cleanup required',
              'Disconnect every external integration and finish provider credential cleanup before deleting this account.',
            ),
          } as const;
        }
        if (await tx.hasInFlightIntegrationAuthorization(userId)) {
          await tx.writeAdminAuditEvent(buildDeletionAuditEvent({
            route, req, result: 'rejected', errorCode: 'integration_authorization_in_flight', occurredAt,
            targetUserId: userId, resourceId: userId,
            argsRedacted: { operation: 'delete' }, resultDetailRedacted: null,
          }));
          return {
            kind: 'rejected',
            response: problem(
              409,
              'integration_authorization_in_flight',
              'Integration authorization in progress',
              'Wait for the external integration authorization to finish before deleting this account.',
            ),
          } as const;
        }
        const unauthorizedRoles = rolesActorMayNotManage(req, lockedPrincipal.roles);
        if (unauthorizedRoles.length > 0) {
          await tx.writeAdminAuditEvent(buildDeletionAuditEvent({
            route, req, result: 'rejected', errorCode: 'insufficient_role_authority', occurredAt,
            targetUserId: userId, resourceId: userId,
            argsRedacted: { operation: 'delete', roles: unauthorizedRoles }, resultDetailRedacted: null,
          }));
          return { kind: 'rejected', response: insufficientRoleAuthorityProblem() } as const;
        }
        const linkedSubjects = (await tx.listLinkedIdentities(userId)).map(identity => identity.sub);
        const runtimeTargets = this.options.runtimeTerminationService
          ? await tx.listAllRuntimePresenceByUser(userId, this.options.now?.())
          : [];
        const durableTerminationCommands = await Promise.all(runtimeTargets.map(session =>
          tx.createRuntimeTerminationCommand({
            sessionId: session.sessionId,
            targetReplicaId: session.replicaId,
            reason: 'credential_revoked',
            requestedAt: occurredAt,
            requestedBy: { kind: 'admin', userId: actor.userId },
          })));
        const result = await tx.deletePrincipal({
          userId,
          deletedByUserId: actor.userId,
          deletedAt: occurredAt,
        });
        if (!result) throw new PrincipalVanishedError();
        // The tombstone row still exists and can anchor an acknowledged
        // invalidation; a hard-deleted user has nothing left to invalidate.
        if (result.outcome === 'anonymized') {
          await tx.appendSecurityInvalidationEvent({
            kind: 'principal_credentials_revoked',
            urgency: 'acknowledged',
            userId,
            authzVersion: result.authzVersion ?? undefined,
            reason: 'account_admin_principal_deleted',
            payload: { revokedGrants: true, authzVersionBumped: true },
            createdAt: occurredAt,
            createdByUserId: actor.userId,
          });
        }
        await tx.writeAdminAuditEvent(buildDeletionAuditEvent({
          route,
          req,
          result: 'approved',
          errorCode: null,
          occurredAt,
          // A hard-deleted row cannot be FK-referenced as the target; record it
          // via the (FK-free) resourceId text field instead.
          targetUserId: result.outcome === 'anonymized' ? userId : null,
          resourceId: userId,
          argsRedacted: { operation: 'delete', outcome: result.outcome },
          resultDetailRedacted: { outcome: result.outcome, new_authz_version: result.authzVersion },
        }));
        return {
          kind: 'deleted',
          deletion: result,
          terminationCommands: durableTerminationCommands,
          linkedSubjects,
        } as const;
      }, actor);
      if (outcome.kind === 'rejected') return outcome.response;
      deletion = outcome.deletion;
      terminationCommands = outcome.terminationCommands;
      deletedLinkedSubjects = outcome.linkedSubjects;
    } catch (error) {
      if (error instanceof PrincipalVanishedError) {
        await this.writeAttemptAudit(req, route, 'failed', 'not_found', userId, {});
        return problem(404, 'not_found', 'Not found', 'User principal was not found.');
      }
      if (error instanceof WouldOrphanAccountsAdminError) {
        await this.writeAttemptAudit(req, route, 'rejected', 'would_orphan_accounts_admin', userId, {});
        return problem(
          422,
          'would_orphan_accounts_admin',
          'Validation failed',
          'Deleting this principal would leave zero enabled account administrators.',
        );
      }
      throw error;
    }

    const runtimeSummary = await this.awaitRuntimeTerminationCommands(terminationCommands);
    const runtimeFailed = runtimeSummary.timedOut > 0 || runtimeSummary.failed > 0;
    const credentialCleanup = await this.completeNonTransactionalCredentialCleanup(
      deletion,
      userId,
      deletedLinkedSubjects,
      occurredAt,
    );
    deletion = {
      ...deletion,
      browserSessionsRevoked: credentialCleanup.browserSessionsRevoked,
      oauthGrantFamiliesRevoked: credentialCleanup.oauthGrantFamiliesRevoked,
    };
    const body: AccountDeletionDto = serializeAccountDeletion({
      userId,
      outcome: deletion.outcome,
      deletedAt: occurredAt,
      revocationSummary: {
        browser_sessions_revoked: deletion.browserSessionsRevoked ?? 0,
        mcp_oauth_grants_revoked: deletion.oauthGrantFamiliesRevoked ?? 0,
        mcp_sessions_terminated: runtimeSummary.terminated + runtimeSummary.alreadyAbsent,
        mcp_sessions_termination_requested: runtimeSummary.requested,
        mcp_sessions_termination_acknowledged: runtimeSummary.acknowledged,
        mcp_sessions_termination_failed: runtimeSummary.failed,
        mcp_sessions_termination_timed_out: runtimeSummary.timedOut,
        authz_version_bumped: deletion.outcome === 'anonymized',
        new_authz_version: deletion.authzVersion ?? undefined,
      },
    });
    return { status: runtimeFailed || credentialCleanup.failed ? 503 : 200, body };
  }

  private async completeNonTransactionalCredentialCleanup(
    deletion: PrincipalDeletionOutcome,
    userId: string,
    linkedSubjects: readonly string[],
    revokedAt: Date,
  ): Promise<{
    readonly browserSessionsRevoked: number;
    readonly oauthGrantFamiliesRevoked: number;
    readonly failed: boolean;
  }> {
    let browserSessionsRevoked = deletion.browserSessionsRevoked ?? 0;
    let oauthGrantFamiliesRevoked = deletion.oauthGrantFamiliesRevoked ?? 0;
    let failed = false;

    if (deletion.browserSessionsRevoked === undefined && this.options.sessionStore) {
      try {
        browserSessionsRevoked = await this.options.sessionStore.revokeForUser(userId, revokedAt);
      } catch {
        failed = true;
      }
    }
    if (deletion.oauthGrantFamiliesRevoked === undefined && linkedSubjects.length > 0) {
      const revoke = this.options.oauthGrantRevocationService?.revokeSubjectGrants;
      if (!revoke) {
        failed = true;
      } else {
        try {
          for (const sub of linkedSubjects) {
            const summary = await revoke.call(this.options.oauthGrantRevocationService, sub, revokedAt);
            oauthGrantFamiliesRevoked += summary.grantsRevoked;
          }
        } catch {
          failed = true;
        }
      }
    }
    return { browserSessionsRevoked, oauthGrantFamiliesRevoked, failed };
  }

  private async awaitRuntimeTerminationCommands(
    commands: readonly Pick<RuntimeTerminationCommand, 'commandId'>[],
  ): Promise<AccountRuntimeTerminationSummary> {
    if (!this.options.runtimeTerminationService) return emptyRuntimeTerminationSummary();
    try {
      return await this.options.runtimeTerminationService.awaitTerminationCommands(commands);
    } catch {
      return { ...emptyRuntimeTerminationSummary(), failed: 1 };
    }
  }

  private async writeAttemptAudit(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    result: ConsoleAdminAuditResult,
    errorCode: string | null,
    targetUserId: string,
    argsRedacted: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.options.transactionRunner.run(tx => tx.writeAdminAuditEvent(buildDeletionAuditEvent({
      route,
      req,
      result,
      errorCode,
      occurredAt: this.now(),
      targetUserId,
      resourceId: targetUserId,
      argsRedacted: { operation: 'delete', ...argsRedacted },
      resultDetailRedacted: null,
    })));
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

interface DeletionAuditEventInput {
  readonly route: ConsoleRouteDefinition;
  readonly req: ConsoleRequest;
  readonly result: ConsoleAdminAuditResult;
  readonly errorCode: string | null;
  readonly occurredAt: Date;
  readonly targetUserId: string | null;
  readonly resourceId: string;
  readonly argsRedacted: Readonly<Record<string, unknown>>;
  readonly resultDetailRedacted: Readonly<Record<string, unknown>> | null;
}

function buildDeletionAuditEvent(input: DeletionAuditEventInput) {
  const { route, req, result, errorCode, occurredAt, targetUserId, resourceId, argsRedacted, resultDetailRedacted } = input;
  return buildConsoleAdminAuditEvent(route, route.auditOperation ?? '', req, result, errorCode, occurredAt, {
    resourceKind: 'account_principal',
    resourceId,
    targetUserId,
    argsRedacted,
    resultDetailRedacted,
  });
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

class PrincipalVanishedError extends Error {
  constructor() {
    super('user principal disappeared during deletion');
    this.name = 'PrincipalVanishedError';
  }
}
