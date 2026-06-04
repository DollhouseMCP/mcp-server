import type { ConsoleAdminAuditResult } from '../../audit/IAdminAuditWriter.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { ConsoleHandlerResult, ConsoleRequest, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import type { IOAuthGrantRevocationService } from '../../services/oauth/IConsoleOAuthGrantRevocationService.js';
import type { IConsoleSessionStore } from '../../stores/IConsoleSessionStore.js';
import type { IConsoleAccountAdminStore, PrincipalDeletionOutcome } from '../../stores/IConsoleAccountAdminStore.js';
import type { IAccountAdminMutationTransactionRunner } from './AccountAdminMutationTransaction.js';
import { serializeAccountDeletion, type AccountDeletionDto } from './AccountAdminDtos.js';
import {
  emptyRuntimeTerminationSummary,
  type AccountAdminRuntimeTerminationService,
  type AccountRuntimeTerminationSummary,
} from './AccountAdminRuntimeTerminationService.js';

export interface AccountAdminDeletionServiceOptions {
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly sessionStore: IConsoleSessionStore;
  readonly oauthGrantRevocationService: IOAuthGrantRevocationService | null;
  readonly transactionRunner: IAccountAdminMutationTransactionRunner;
  readonly runtimeTerminationService?: AccountAdminRuntimeTerminationService | null;
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
    if (!this.options.oauthGrantRevocationService) {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, {
        dependency: 'oauth_grant_revocation',
      });
      return problem(503, 'service_unavailable', 'Service unavailable', 'OAuth grant revocation service is unavailable.');
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

    // Revoke sessions/grants/runtime BEFORE removing the identity: grant
    // revocation resolves the user's auth_accounts subjects, which the delete
    // then removes. A failure here aborts before any destructive write.
    let browserSessionsRevoked = 0;
    let oauthGrantsRevoked = 0;
    let runtimeSummary: AccountRuntimeTerminationSummary = emptyRuntimeTerminationSummary();
    try {
      browserSessionsRevoked = await this.options.sessionStore.revokeForUser(userId, occurredAt);
      const oauthSummary = await this.options.oauthGrantRevocationService.revokePrincipalGrants({
        userId,
        revokedAt: occurredAt,
      });
      oauthGrantsRevoked = oauthSummary.oauthGrantFamiliesRevoked;
      runtimeSummary = await this.terminateRuntimeSessions(userId, actor.userId);
    } catch {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, {
        phase: 'pre_delete_revocation',
      });
      return problem(503, 'service_unavailable', 'Service unavailable', 'Credential revocation failed before the account was removed.');
    }

    let deletion: PrincipalDeletionOutcome;
    try {
      deletion = await this.options.transactionRunner.run(async tx => {
        const result = await tx.deletePrincipal({ userId, deletedAt: occurredAt });
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
        return result;
      });
    } catch (error) {
      if (error instanceof PrincipalVanishedError) {
        await this.writeAttemptAudit(req, route, 'failed', 'not_found', userId, {});
        return problem(404, 'not_found', 'Not found', 'User principal was not found.');
      }
      throw error;
    }

    const runtimeFailed = runtimeSummary.timedOut > 0 || runtimeSummary.failed > 0;
    const body: AccountDeletionDto = serializeAccountDeletion({
      userId,
      outcome: deletion.outcome,
      deletedAt: occurredAt,
      revocationSummary: {
        browser_sessions_revoked: browserSessionsRevoked,
        mcp_oauth_grants_revoked: oauthGrantsRevoked,
        mcp_sessions_terminated: runtimeSummary.terminated + runtimeSummary.alreadyAbsent,
        mcp_sessions_termination_requested: runtimeSummary.requested,
        mcp_sessions_termination_acknowledged: runtimeSummary.acknowledged,
        mcp_sessions_termination_failed: runtimeSummary.failed,
        mcp_sessions_termination_timed_out: runtimeSummary.timedOut,
        authz_version_bumped: deletion.outcome === 'anonymized',
        new_authz_version: deletion.authzVersion ?? undefined,
      },
    });
    return { status: runtimeFailed ? 503 : 200, body };
  }

  private async terminateRuntimeSessions(
    userId: string,
    actorUserId: string,
  ): Promise<AccountRuntimeTerminationSummary> {
    if (!this.options.runtimeTerminationService) return emptyRuntimeTerminationSummary();
    try {
      return await this.options.runtimeTerminationService.terminatePrincipalSessions({
        userId,
        requestedByUserId: actorUserId,
        reason: 'credential_revoked',
      });
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

class PrincipalVanishedError extends Error {
  constructor() {
    super('user principal disappeared during deletion');
    this.name = 'PrincipalVanishedError';
  }
}
