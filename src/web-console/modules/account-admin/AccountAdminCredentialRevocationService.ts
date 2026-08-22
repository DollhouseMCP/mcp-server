import type { ConsoleAdminAuditResult } from '../../audit/IAdminAuditWriter.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { ConsoleHandlerResult, ConsoleRequest, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import type {
  ConsoleOAuthGrantRevocationSummary,
  ConsoleOAuthSubjectRevocationSummary,
  IOAuthGrantRevocationService,
} from '../../services/oauth/IConsoleOAuthGrantRevocationService.js';
import type { IConsoleSessionStore } from '../../stores/IConsoleSessionStore.js';
import type { IConsoleSecurityInvalidationStore } from '../../services/invalidation/IConsoleSecurityInvalidationStore.js';
import { waitForSecurityInvalidationAcknowledgements } from '../../services/invalidation/ConsoleSecurityInvalidationAcknowledgement.js';
import type {
  ConsolePrincipalSummary,
  IConsoleAccountAdminStore,
} from '../../stores/IConsoleAccountAdminStore.js';
import type { IAccountAdminMutationTransactionRunner } from './AccountAdminMutationTransaction.js';
import { rolesActorMayNotManage } from './AccountAdminRoleAuthority.js';
import { serializeAccountPrincipalLifecycle } from './AccountAdminDtos.js';
import {
  emptyRuntimeTerminationSummary,
  runtimeTerminationErrorCode,
  type AccountAdminRuntimeTerminationService,
  type AccountRuntimeTerminationSummary,
} from './AccountAdminRuntimeTerminationService.js';

export interface AccountAdminCredentialRevocationServiceOptions {
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly sessionStore: IConsoleSessionStore;
  readonly oauthGrantRevocationService: IOAuthGrantRevocationService | null;
  readonly transactionRunner: IAccountAdminMutationTransactionRunner;
  readonly securityInvalidationStore?: Pick<IConsoleSecurityInvalidationStore,
    'listLiveReplicaIds' | 'listAcknowledgedReplicaIds'> | null;
  readonly invalidationAcknowledgementTimeoutMs?: number;
  readonly runtimeTerminationService?: AccountAdminRuntimeTerminationService | null;
  readonly now?: () => Date;
}

export class AccountAdminCredentialRevocationService {
  constructor(private readonly options: AccountAdminCredentialRevocationServiceOptions) {}

  async revokeAllCredentials(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
  ): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const requestOccurredAt = this.now();
    const before = await this.options.accountAdminStore.findPrincipal(userId);
    if (!before) {
      await this.writeAttemptAudit(req, route, 'failed', 'not_found', userId, {});
      return problem(404, 'not_found', 'Not found', 'User principal was not found.');
    }
    if (!this.options.oauthGrantRevocationService) {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, {
        dependency: 'oauth_grant_revocation',
      });
      return serviceUnavailable('OAuth grant revocation service is unavailable.');
    }
    const unauthorizedRoles = rolesActorMayNotManage(req, protectedCredentialRoles(before.roles));
    if (unauthorizedRoles.length > 0) {
      await this.writeAttemptAudit(req, route, 'rejected', 'insufficient_role_authority', userId, {
        operation: 'credentials_revoke_all', roles: unauthorizedRoles,
      });
      return insufficientRoleAuthorityProblem();
    }

    let changed = withAuthzVersion(before, before.authzVersion);
    let invalidationEventId: string | null = null;
    let browserSessionsRevokedInTransaction: number | null = null;
    let oauthSummaryInTransaction: ConsoleOAuthGrantRevocationSummary | null = null;
    let revocationCutoff = requestOccurredAt;
    try {
      await this.options.transactionRunner.run(async tx => {
        const lockedPrincipal = await tx.lockPrincipal(userId);
        if (!lockedPrincipal) throw new Error('credential revoke-all principal disappeared during mutation');
        const lockedUnauthorizedRoles = rolesActorMayNotManage(req, protectedCredentialRoles(lockedPrincipal.roles));
        if (lockedUnauthorizedRoles.length > 0) {
          await tx.writeAdminAuditEvent(buildCredentialAuditEvent({
            route,
            req,
            result: 'rejected',
            errorCode: 'insufficient_role_authority',
            occurredAt: this.now(),
            userId,
            argsRedacted: { operation: 'credentials_revoke_all', roles: lockedUnauthorizedRoles },
            resultDetailRedacted: null,
          }));
          return;
        }
        const identities = await tx.lockLinkedAuthSubjects(userId);
        // Any issuance for these subjects must complete before this instant or
        // wait until the transaction commits. The cutoff therefore covers all
        // credentials that existed when revoke-all took effect.
        revocationCutoff = this.now();
        if (tx.revokeOAuthSubjectGrants) {
          const subjects: ConsoleOAuthSubjectRevocationSummary[] = [];
          let grantCount = 0;
          for (const identity of identities) {
            const revoked = await tx.revokeOAuthSubjectGrants(identity.sub);
            grantCount += revoked;
            subjects.push({ sub: identity.sub, grantsDiscovered: revoked, grantsRevoked: revoked });
          }
          oauthSummaryInTransaction = {
            userId,
            revokedAt: revocationCutoff,
            linkedSubjectsProcessed: identities.length,
            oauthGrantFamiliesDiscovered: grantCount,
            oauthGrantFamiliesRevoked: grantCount,
            subjects,
          };
        }
        if (tx.revokeBrowserSessionsForUser) {
          browserSessionsRevokedInTransaction = await tx.revokeBrowserSessionsForUser(userId, revocationCutoff);
        }
        const change = await tx.bumpPrincipalAuthzVersion({ userId, bumpedAt: revocationCutoff });
        if (!change) throw new Error('credential revoke-all authz-version bump did not update a row');
        changed = withAuthzVersion(before, change.authzVersion);
        // Incident-response credential revocation must be acknowledged by the
        // invalidation runtime so authz-version caches are bypassed cluster-wide.
        const invalidationEvent = await tx.appendSecurityInvalidationEvent({
          kind: 'principal_credentials_revoked',
          urgency: 'acknowledged',
          userId,
          authzVersion: change.authzVersion,
          reason: 'account_admin_credentials_revoke_all',
          payload: {
            revokedGrants: true,
            authzVersionBumped: true,
          },
          createdAt: revocationCutoff,
          createdByUserId: actor.userId,
        });
        invalidationEventId = invalidationEvent.eventId;
        await tx.writeAdminAuditEvent(buildCredentialAuditEvent({
          route,
          req,
          result: 'approved',
          errorCode: null,
          occurredAt: revocationCutoff,
          userId,
          argsRedacted: { operation: 'credentials_revoke_all', phase: 'state_committed' },
          resultDetailRedacted: {
            previousAuthzVersion: before.authzVersion,
            newAuthzVersion: change.authzVersion,
            oauthRevokedInTransaction: oauthSummaryInTransaction !== null,
          },
        }));
      }, actor);
    } catch {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, {
        operation: 'credentials_revoke_all',
        phase: 'transactional_revocation',
      });
      return serviceUnavailable('Credential revocation could not be committed atomically.');
    }

    if (changed.authzVersion === before.authzVersion) {
      return insufficientRoleAuthorityProblem();
    }

    let browserSessionsRevoked = browserSessionsRevokedInTransaction ?? 0;
    let oauthSummary: ConsoleOAuthGrantRevocationSummary | null = oauthSummaryInTransaction;
    let browserRevocationFailed = false;
    let oauthRevocationFailed = false;
    if (browserSessionsRevokedInTransaction === null) {
      try {
        browserSessionsRevoked = await this.options.sessionStore.revokeForUser(userId, revocationCutoff);
      } catch {
        browserRevocationFailed = true;
      }
    }
    if (oauthSummaryInTransaction === null) {
      try {
        oauthSummary = await this.options.oauthGrantRevocationService.revokePrincipalGrants({
          userId,
          revokedAt: revocationCutoff,
        });
      } catch {
        oauthRevocationFailed = true;
      }
    }
    const acknowledged = !invalidationEventId || await waitForSecurityInvalidationAcknowledgements({
      store: this.options.securityInvalidationStore,
      eventId: invalidationEventId,
      occurredAt: revocationCutoff,
      timeoutMs: this.options.invalidationAcknowledgementTimeoutMs,
    });
    if (browserRevocationFailed || oauthRevocationFailed || !oauthSummary || !acknowledged) {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, {
        operation: 'credentials_revoke_all',
        phase: !acknowledged ? 'invalidation_acknowledgement' : 'post_commit_revocation',
        browserSessionRevocationFailed: browserRevocationFailed,
        oauthGrantRevocationFailed: oauthRevocationFailed,
      });
      return serviceUnavailable(
        !acknowledged
          ? 'Credential state was invalidated, but cluster acknowledgement timed out.'
          : 'Credential revocation dependency failed after account state was invalidated.',
      );
    }

    try {
      await this.writeAttemptAudit(req, route, 'approved', null, userId, {
        operation: 'credentials_revoke_all',
        phase: 'post_commit_revocation',
      }, {
        browserSessionsRevoked,
        oauthSubjectsProcessed: oauthSummary.linkedSubjectsProcessed,
        oauthGrantFamiliesDiscovered: oauthSummary.oauthGrantFamiliesDiscovered,
        oauthGrantFamiliesRevoked: oauthSummary.oauthGrantFamiliesRevoked,
      });
      const runtimeSummary = await this.terminateRuntimeSessions(req, route, userId, actor.userId);
      const revocationSummary = {
        browser_sessions_revoked: browserSessionsRevoked,
        mcp_oauth_grants_revoked: oauthSummary.oauthGrantFamiliesRevoked,
        mcp_sessions_terminated: runtimeSummary.terminated + runtimeSummary.alreadyAbsent,
        mcp_sessions_termination_requested: runtimeSummary.requested,
        mcp_sessions_termination_acknowledged: runtimeSummary.acknowledged,
        mcp_sessions_termination_failed: runtimeSummary.failed,
        mcp_sessions_termination_timed_out: runtimeSummary.timedOut,
        authz_version_bumped: true,
        new_authz_version: changed.authzVersion,
      };
      const runtimeFailed = runtimeSummary.timedOut > 0 || runtimeSummary.failed > 0;
      await this.writeAttemptAudit(
        req,
        route,
        runtimeFailed ? 'failed' : 'approved',
        runtimeTerminationErrorCode(runtimeSummary),
        userId,
        {
          operation: 'credentials_revoke_all',
          phase: 'post_commit_runtime_termination',
        },
        {
          runtimeSessionsRequested: runtimeSummary.requested,
          runtimeSessionsAcknowledged: runtimeSummary.acknowledged,
          runtimeSessionsTimedOut: runtimeSummary.timedOut,
          runtimeSessionsFailed: runtimeSummary.failed,
        },
      );
      return {
        status: runtimeSummary.timedOut > 0 || runtimeSummary.failed > 0 ? 503 : 200,
        body: serializeAccountPrincipalLifecycle(changed, revocationSummary),
      };
    } catch {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, {
        operation: 'credentials_revoke_all',
        phase: 'post_commit_revocation',
      });
      return serviceUnavailable('Credential revocation dependency failed after account state was invalidated.');
    }
  }

  private async writeAttemptAudit(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    result: ConsoleAdminAuditResult,
    errorCode: string | null,
    targetUserId: string | null,
    argsRedacted: Readonly<Record<string, unknown>>,
    resultDetailRedacted: Readonly<Record<string, unknown>> | null = null,
  ): Promise<void> {
    await this.options.transactionRunner.run(tx => tx.writeAdminAuditEvent(buildCredentialAuditEvent({
      route,
      req,
      result,
      errorCode,
      occurredAt: this.now(),
      userId: targetUserId,
      argsRedacted,
      resultDetailRedacted,
    })));
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async terminateRuntimeSessions(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
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
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, {
        operation: 'credentials_revoke_all',
        phase: 'post_commit_runtime_termination',
      });
      return {
        ...emptyRuntimeTerminationSummary(),
        failed: 1,
      };
    }
  }
}

function protectedCredentialRoles(roles: readonly string[]): readonly 'admin'[] {
  return roles.includes('admin') ? ['admin'] : [];
}

interface CredentialAuditEventInput {
  readonly route: ConsoleRouteDefinition;
  readonly req: ConsoleRequest;
  readonly result: ConsoleAdminAuditResult;
  readonly errorCode: string | null;
  readonly occurredAt: Date;
  readonly userId: string | null;
  readonly argsRedacted: Readonly<Record<string, unknown>>;
  readonly resultDetailRedacted: Readonly<Record<string, unknown>> | null;
}

function buildCredentialAuditEvent(input: CredentialAuditEventInput) {
  const { route, req, result, errorCode, occurredAt, userId, argsRedacted, resultDetailRedacted } = input;
  return buildConsoleAdminAuditEvent(route, route.auditOperation ?? '', req, result, errorCode, occurredAt, {
    resourceKind: 'account_principal',
    resourceId: userId,
    targetUserId: userId,
    argsRedacted,
    resultDetailRedacted,
  });
}

function withAuthzVersion(principal: ConsolePrincipalSummary, authzVersion: number): ConsolePrincipalSummary {
  return {
    ...principal,
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

function serviceUnavailable(detail: string): ConsoleHandlerResult {
  return problem(503, 'service_unavailable', 'Service unavailable', detail);
}

function insufficientRoleAuthorityProblem(): ConsoleHandlerResult {
  return {
    status: 403,
    body: {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      code: 'insufficient_role_authority',
      detail: 'The target has an administrative role that this account cannot manage.',
    },
  };
}
