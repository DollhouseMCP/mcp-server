import type { ConsoleAdminAuditResult } from '../../audit/IAdminAuditWriter.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { ConsoleHandlerResult, ConsoleRequest, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import {
  CannotUnlinkLastIdentityError,
  type IdentityLinkPreparationResult,
  type IConsoleAccountAdminStore,
} from '../../stores/IConsoleAccountAdminStore.js';
import type {
  AccountAdminMutationTransactionContext,
  IAccountAdminMutationTransactionRunner,
} from './AccountAdminMutationTransaction.js';
import type { IOAuthGrantRevocationService } from '../../services/oauth/IConsoleOAuthGrantRevocationService.js';
import type { IConsoleSessionStore } from '../../stores/IConsoleSessionStore.js';
import type { IConsoleSecurityInvalidationStore } from '../../services/invalidation/IConsoleSecurityInvalidationStore.js';
import { waitForSecurityInvalidationAcknowledgements } from '../../services/invalidation/ConsoleSecurityInvalidationAcknowledgement.js';
import { rolesActorMayNotManage } from './AccountAdminRoleAuthority.js';
import {
  serializeAccountIdentityList,
  serializeAccountIdentityMutation,
} from './AccountAdminIdentityDtos.js';
import {
  emptyRuntimeTerminationSummary,
  type AccountAdminRuntimeTerminationService,
  type AccountRuntimeTerminationSummary,
} from './AccountAdminRuntimeTerminationService.js';

export interface AccountAdminIdentityServiceOptions {
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly transactionRunner: IAccountAdminMutationTransactionRunner;
  readonly sessionStore: Pick<IConsoleSessionStore, 'revokeForUser'>;
  readonly securityInvalidationStore?: Pick<IConsoleSecurityInvalidationStore,
    'listLiveReplicaIds' | 'listAcknowledgedReplicaIds'> | null;
  readonly invalidationAcknowledgementTimeoutMs?: number;
  readonly oauthGrantRevocationService?: IOAuthGrantRevocationService | null;
  readonly runtimeTerminationService?: AccountAdminRuntimeTerminationService | null;
  readonly now?: () => Date;
}

/**
 * Manage the many-logins-to-one-account mapping (`auth_accounts.user_id`):
 * list a user's linked provider logins, attach an unlinked login, or detach
 * one. This is the human-visible "4 machines, one identity" surface.
 */
export class AccountAdminIdentityService {
  constructor(private readonly options: AccountAdminIdentityServiceOptions) {}

  async listIdentities(userId: string): Promise<ConsoleHandlerResult> {
    const principal = await this.options.accountAdminStore.findPrincipal(userId);
    if (!principal) return problem(404, 'not_found', 'Not found', 'User principal was not found.');
    const identities = await this.options.accountAdminStore.listLinkedIdentities(userId);
    return { status: 200, body: serializeAccountIdentityList(userId, identities) };
  }

  async linkIdentity(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
  ): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const sub = readSub(req.body);
    if (!sub) return problem(400, 'invalid_request', 'Invalid request', 'sub is required.');

    const principal = await this.options.accountAdminStore.findPrincipal(userId);
    if (!principal) {
      await this.writeAttemptAudit(req, route, 'failed', 'not_found', userId, sub, 'link');
      return problem(404, 'not_found', 'Not found', 'User principal was not found.');
    }
    const target = await this.options.accountAdminStore.findIdentityBySub(sub);
    if (!target) {
      await this.writeAttemptAudit(req, route, 'failed', 'not_found', userId, sub, 'link');
      return problem(404, 'not_found', 'Not found', 'No login with that subject exists.');
    }
    const resumingProvisionalLink = target.linkedUserId === userId
      && await this.options.accountAdminStore.isIdentityRevocationFenced(sub);
    if (target.linkedUserId === userId && !resumingProvisionalLink) {
      await this.writeAttemptAudit(req, route, 'conflict', 'already_linked', userId, sub, 'link');
      return problem(409, 'already_linked', 'Conflict', 'That login is already linked to this account.');
    }
    if (target.linkedUserId !== null && target.linkedUserId !== userId) {
      await this.writeAttemptAudit(req, route, 'conflict', 'linked_elsewhere', userId, sub, 'link');
      return problem(409, 'linked_elsewhere', 'Conflict', 'That login is linked to another account; unlink it there first.');
    }
    if (rolesActorMayNotManage(req, principal.roles).length > 0) {
      await this.writeAttemptAudit(req, route, 'rejected', 'insufficient_role_authority', userId, sub, 'link');
      return insufficientRoleAuthorityProblem();
    }

    const occurredAt = this.now();
    const rejection = await this.options.transactionRunner.run(async tx => {
      const lockedPrincipal = await tx.lockPrincipal(userId);
      if (!lockedPrincipal) {
        await tx.writeAdminAuditEvent(buildIdentityAuditEvent({
          route, req, result: 'failed', errorCode: 'not_found', occurredAt, userId, sub,
          argsRedacted: { operation: 'link', provider: target.provider, sub },
          resultDetailRedacted: null,
        }));
        return problem(404, 'not_found', 'Not found', 'User principal was not found.');
      }
      const unauthorizedRoles = rolesActorMayNotManage(req, lockedPrincipal.roles);
      if (unauthorizedRoles.length > 0) {
        await tx.writeAdminAuditEvent(buildIdentityAuditEvent({
          route, req, result: 'rejected', errorCode: 'insufficient_role_authority', occurredAt, userId, sub,
          argsRedacted: { operation: 'link', roles: unauthorizedRoles, provider: target.provider, sub },
          resultDetailRedacted: null,
        }));
        return insufficientRoleAuthorityProblem();
      }
      const preparation = await tx.linkIdentity({ userId, sub, linkedAt: occurredAt });
      if (preparation.outcome !== 'provisional') {
        const errorCode = identityLinkPreparationErrorCode(preparation.outcome);
        const conflict = identityLinkPreparationProblem(preparation.outcome);
        await tx.writeAdminAuditEvent(buildIdentityAuditEvent({
          route,
          req,
          result: preparation.outcome === 'subject_deleted' ? 'rejected' : 'conflict',
          errorCode,
          occurredAt,
          userId,
          sub,
          argsRedacted: { operation: 'link', provider: target.provider, sub },
          resultDetailRedacted: { linked: false, preparation: preparation.outcome },
        }));
        return conflict;
      }
      if (!await this.revokeBrowserSessionsWithTx(tx, userId, occurredAt)) {
        await tx.writeAdminAuditEvent(buildIdentityAuditEvent({
          route, req, result: 'failed', errorCode: 'service_unavailable', occurredAt, userId, sub,
          argsRedacted: { operation: 'link', phase: 'browser_session_revocation', provider: target.provider, sub },
          resultDetailRedacted: null,
        }));
        return problem(
          503,
          'service_unavailable',
          'Service unavailable',
          'Existing browser sessions could not be revoked; the provisional login remains fenced for retry.',
        );
      }
      if (!await this.revokeSubjectGrantsWithTx(tx, sub, occurredAt)) {
        await tx.writeAdminAuditEvent(buildIdentityAuditEvent({
          route, req, result: 'failed', errorCode: 'service_unavailable', occurredAt, userId, sub,
          argsRedacted: { operation: 'link', phase: 'oauth_grant_revocation', provider: target.provider, sub },
          resultDetailRedacted: null,
        }));
        return problem(
          503,
          'service_unavailable',
          'Service unavailable',
          'OAuth credentials could not be revoked; the provisional login remains fenced for retry.',
        );
      }
      await tx.writeAdminAuditEvent(buildIdentityAuditEvent({
        route,
        req,
        result: 'approved',
        errorCode: null,
        occurredAt,
        userId,
        sub,
        argsRedacted: { operation: 'link', provider: target.provider, sub },
        resultDetailRedacted: { linked: true, authorityFenced: true },
      }));
      return null;
    }, actor);
    if (rejection) return rejection;

    // The provisional link is visible only behind its durable subject fence.
    // Runtime cleanup therefore cannot race a newly-authorized target subject,
    // and a failed cleanup leaves a safe state that this endpoint can resume.
    const runtimeSummary = await this.terminateRuntimeSessions(userId, actor.userId);
    if (runtimeSummary.timedOut > 0 || runtimeSummary.failed > 0) {
      return problem(
        503,
        'service_unavailable',
        'Service unavailable',
        'The login remains fenced until MCP runtime cleanup succeeds; retry this link operation.',
      );
    }

    const finalizedAt = this.now();
    const finalizationActor = actor.userId === userId
      ? await this.refreshActorAuthority(actor, userId)
      : actor;
    const finalizationRejection = await this.options.transactionRunner.run(async tx => {
      const lockedPrincipal = await tx.lockPrincipal(userId);
      if (!lockedPrincipal) {
        await tx.writeAdminAuditEvent(buildIdentityAuditEvent({
          route, req, result: 'failed', errorCode: 'not_found', occurredAt: finalizedAt, userId, sub,
          argsRedacted: { operation: 'link', phase: 'authority_finalization', provider: target.provider, sub },
          resultDetailRedacted: null,
        }));
        return problem(404, 'not_found', 'Not found', 'User principal was not found.');
      }
      const unauthorizedRoles = rolesActorMayNotManage(req, lockedPrincipal.roles);
      if (unauthorizedRoles.length > 0) {
        await tx.writeAdminAuditEvent(buildIdentityAuditEvent({
          route, req, result: 'rejected', errorCode: 'insufficient_role_authority', occurredAt: finalizedAt, userId, sub,
          argsRedacted: {
            operation: 'link',
            phase: 'authority_finalization',
            roles: unauthorizedRoles,
            provider: target.provider,
            sub,
          },
          resultDetailRedacted: { authorityFenced: true },
        }));
        return insufficientRoleAuthorityProblem();
      }
      const result = await tx.finalizeIdentityLink({ userId, sub, linkedAt: finalizedAt });
      const ok = result.outcome === 'finalized' || result.outcome === 'already_finalized';
      await tx.writeAdminAuditEvent(buildIdentityAuditEvent({
        route,
        req,
        result: ok ? 'approved' : 'failed',
        errorCode: ok ? null : 'service_unavailable',
        occurredAt: finalizedAt,
        userId,
        sub,
        argsRedacted: { operation: 'link', phase: 'authority_finalization', provider: target.provider, sub },
        resultDetailRedacted: { linked: ok, authorityFenced: !ok, finalization: result.outcome },
      }));
      return ok
        ? null
        : problem(
            503,
            'service_unavailable',
            'Service unavailable',
            'The login remains fenced because link finalization could not be completed; retry this operation.',
          );
    }, finalizationActor);
    if (finalizationRejection) return finalizationRejection;
    return { status: 200, body: serializeAccountIdentityMutation(userId, sub, true) };
  }

  async unlinkIdentity(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
  ): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const sub = readSub(req.body);
    if (!sub) return problem(400, 'invalid_request', 'Invalid request', 'sub is required.');

    const principal = await this.options.accountAdminStore.findPrincipal(userId);
    if (!principal) {
      await this.writeAttemptAudit(req, route, 'failed', 'not_found', userId, sub, 'unlink');
      return problem(404, 'not_found', 'Not found', 'User principal was not found.');
    }
    const linkedIdentities = await this.options.accountAdminStore.listLinkedIdentities(userId);
    const target = linkedIdentities.find(identity => identity.sub === sub);
    if (!target) {
      await this.writeAttemptAudit(req, route, 'failed', 'not_found', userId, sub, 'unlink');
      return problem(404, 'not_found', 'Not found', 'That login is not linked to this account.');
    }
    if (linkedIdentities.length <= 1) {
      await this.writeAttemptAudit(req, route, 'rejected', 'cannot_unlink_last_identity', userId, sub, 'unlink');
      return problem(
        422,
        'cannot_unlink_last_identity',
        'Validation failed',
        'You cannot unlink the only login on an account; delete the account instead.',
      );
    }

    const occurredAt = this.now();
    let unlinked = false;
    let invalidationEventId: string | null = null;
    try {
      const rejection = await this.options.transactionRunner.run(async tx => {
        const lockedPrincipal = await tx.lockPrincipal(userId);
        if (!lockedPrincipal) {
          await tx.writeAdminAuditEvent(buildIdentityAuditEvent({
            route, req, result: 'failed', errorCode: 'not_found', occurredAt, userId, sub,
            argsRedacted: { operation: 'unlink', provider: target.provider, sub },
            resultDetailRedacted: null,
          }));
          return problem(404, 'not_found', 'Not found', 'User principal was not found.');
        }
        const unauthorizedRoles = rolesActorMayNotManage(req, lockedPrincipal.roles);
        if (unauthorizedRoles.length > 0) {
          await tx.writeAdminAuditEvent(buildIdentityAuditEvent({
            route, req, result: 'rejected', errorCode: 'insufficient_role_authority', occurredAt, userId, sub,
            argsRedacted: { operation: 'unlink', roles: unauthorizedRoles, provider: target.provider, sub },
            resultDetailRedacted: null,
          }));
          return insufficientRoleAuthorityProblem();
        }
        const result = await tx.unlinkIdentity({ userId, sub, unlinkedAt: occurredAt });
        const ok = result !== null;
        if (ok) {
          const changedPrincipal = await tx.lockPrincipal(userId);
          if (!changedPrincipal) throw new Error('unlinked principal disappeared during mutation');
          const invalidationEvent = await tx.appendSecurityInvalidationEvent({
            kind: 'principal_credentials_revoked',
            urgency: 'acknowledged',
            userId,
            authzVersion: changedPrincipal.authzVersion,
            reason: 'account_admin_identity_unlinked',
            payload: { revokedGrants: true, authzVersionBumped: true },
            createdAt: occurredAt,
            createdByUserId: requireConsoleAuthentication(req).userId,
          });
          invalidationEventId = invalidationEvent.eventId;
        }
        await tx.writeAdminAuditEvent(buildIdentityAuditEvent({
          route,
          req,
          result: ok ? 'approved' : 'failed',
          errorCode: ok ? null : 'not_found',
          occurredAt,
          userId,
          sub,
          argsRedacted: { operation: 'unlink', provider: target.provider, sub },
          resultDetailRedacted: { unlinked: ok },
        }));
        unlinked = ok;
        return ok ? null : problem(404, 'not_found', 'Not found', 'That login is not linked to this account.');
      }, requireConsoleAuthentication(req));
      if (rejection) return rejection;
    } catch (error) {
      if (!(error instanceof CannotUnlinkLastIdentityError)) throw error;
      await this.writeAttemptAudit(req, route, 'rejected', 'cannot_unlink_last_identity', userId, sub, 'unlink');
      return problem(
        422,
        'cannot_unlink_last_identity',
        'Validation failed',
        'You cannot unlink the only login on an account; delete the account instead.',
      );
    }
    if (!unlinked) {
      return problem(404, 'not_found', 'Not found', 'That login is not linked to this account.');
    }
    const browserSessionsRevoked = await this.revokeBrowserSessions(userId, occurredAt);
    const subjectGrantsRevoked = await this.revokeSubjectGrants(sub, occurredAt);
    const runtimeSummary = await this.terminateRuntimeSessions(userId, actor.userId);
    const acknowledged = !invalidationEventId || await waitForSecurityInvalidationAcknowledgements({
      store: this.options.securityInvalidationStore,
      eventId: invalidationEventId,
      occurredAt,
      timeoutMs: this.options.invalidationAcknowledgementTimeoutMs,
    });
    if (!browserSessionsRevoked) {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, sub, 'unlink');
      return problem(503, 'service_unavailable', 'Service unavailable', 'The login was unlinked and fenced, but browser-session cleanup must be retried before relinking.');
    }
    if (!subjectGrantsRevoked) {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, sub, 'unlink');
      return problem(
        503,
        'service_unavailable',
        'Service unavailable',
        'The login was unlinked and fenced, but its OAuth grant cleanup must be retried before relinking.',
      );
    }
    if (runtimeSummary.timedOut > 0 || runtimeSummary.failed > 0) {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, sub, 'unlink');
      return problem(
        503,
        'service_unavailable',
        'Service unavailable',
        'The login was unlinked and fenced, but MCP runtime cleanup must be retried before relinking.',
      );
    }
    if (!acknowledged) {
      await this.writeAttemptAudit(req, route, 'failed', 'service_unavailable', userId, sub, 'unlink');
      return problem(
        503,
        'service_unavailable',
        'Service unavailable',
        'The login was unlinked and fenced, but cluster credential invalidation has not yet been acknowledged.',
      );
    }
    return { status: 200, body: serializeAccountIdentityMutation(userId, sub, false) };
  }

  private async writeAttemptAudit(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    result: ConsoleAdminAuditResult,
    errorCode: string | null,
    userId: string,
    sub: string,
    operation: 'link' | 'unlink',
  ): Promise<void> {
    await this.options.transactionRunner.run(tx => tx.writeAdminAuditEvent(buildIdentityAuditEvent({
      route,
      req,
      result,
      errorCode,
      occurredAt: this.now(),
      userId,
      sub,
      argsRedacted: { operation, sub },
      resultDetailRedacted: null,
    })));
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async refreshActorAuthority(
    actor: ReturnType<typeof requireConsoleAuthentication>,
    userId: string,
  ): Promise<ReturnType<typeof requireConsoleAuthentication>> {
    const live = await this.options.accountAdminStore.findPrincipal(userId);
    if (!live || live.disabledAt !== null) {
      throw new Error('administrative actor authority changed during identity mutation');
    }
    return { ...actor, authzVersion: live.authzVersion };
  }

  private async revokeSubjectGrants(sub: string, revokedAt: Date): Promise<boolean> {
    const revoke = this.options.oauthGrantRevocationService?.revokeSubjectGrants;
    if (!revoke) return false;
    try {
      await revoke.call(this.options.oauthGrantRevocationService, sub, revokedAt);
      return true;
    } catch {
      return false;
    }
  }

  private async revokeSubjectGrantsWithTx(
    tx: AccountAdminMutationTransactionContext,
    sub: string,
    revokedAt: Date,
  ): Promise<boolean> {
    if (tx.revokeOAuthSubjectGrants) {
      try {
        await tx.revokeOAuthSubjectGrants(sub);
        return true;
      } catch {
        return false;
      }
    }
    return this.revokeSubjectGrants(sub, revokedAt);
  }

  private async revokeBrowserSessions(userId: string, revokedAt: Date): Promise<boolean> {
    try {
      await this.options.sessionStore.revokeForUser(userId, revokedAt);
      return true;
    } catch {
      return false;
    }
  }

  private async revokeBrowserSessionsWithTx(
    tx: AccountAdminMutationTransactionContext,
    userId: string,
    revokedAt: Date,
  ): Promise<boolean> {
    if (tx.revokeBrowserSessionsForUser) {
      try {
        await tx.revokeBrowserSessionsForUser(userId, revokedAt);
        return true;
      } catch {
        return false;
      }
    }
    return this.revokeBrowserSessions(userId, revokedAt);
  }

  private async terminateRuntimeSessions(
    userId: string,
    requestedByUserId: string,
  ): Promise<AccountRuntimeTerminationSummary> {
    if (!this.options.runtimeTerminationService) return emptyRuntimeTerminationSummary();
    try {
      return await this.options.runtimeTerminationService.terminatePrincipalSessions({
        userId,
        requestedByUserId,
        reason: 'credential_revoked',
      });
    } catch {
      return { ...emptyRuntimeTerminationSummary(), failed: 1 };
    }
  }
}

interface IdentityAuditEventInput {
  readonly route: ConsoleRouteDefinition;
  readonly req: ConsoleRequest;
  readonly result: ConsoleAdminAuditResult;
  readonly errorCode: string | null;
  readonly occurredAt: Date;
  readonly userId: string;
  readonly sub: string;
  readonly argsRedacted: Readonly<Record<string, unknown>>;
  readonly resultDetailRedacted: Readonly<Record<string, unknown>> | null;
}

function buildIdentityAuditEvent(input: IdentityAuditEventInput) {
  const { route, req, result, errorCode, occurredAt, userId, sub, argsRedacted, resultDetailRedacted } = input;
  return buildConsoleAdminAuditEvent(route, route.auditOperation ?? '', req, result, errorCode, occurredAt, {
    resourceKind: 'account_identity',
    resourceId: sub,
    targetUserId: userId,
    argsRedacted,
    resultDetailRedacted,
  });
}

function readSub(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).sub;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 320 ? trimmed : null;
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

function identityLinkPreparationErrorCode(
  outcome: Exclude<IdentityLinkPreparationResult['outcome'], 'provisional'>,
): string {
  switch (outcome) {
    case 'already_linked': return 'already_linked';
    case 'linked_elsewhere': return 'linked_elsewhere';
    case 'subject_deleted': return 'subject_deleted';
    case 'not_found': return 'not_found';
  }
}

function identityLinkPreparationProblem(
  outcome: Exclude<IdentityLinkPreparationResult['outcome'], 'provisional'>,
): ConsoleHandlerResult {
  switch (outcome) {
    case 'already_linked':
      return problem(409, 'already_linked', 'Conflict', 'That login is already linked to this account.');
    case 'linked_elsewhere':
      return problem(409, 'linked_elsewhere', 'Conflict', 'That login was linked to another account concurrently.');
    case 'subject_deleted':
      return problem(409, 'subject_deleted', 'Conflict', 'That deleted login subject cannot be linked to an account.');
    case 'not_found':
      return problem(404, 'not_found', 'Not found', 'The account or login no longer exists.');
  }
}
