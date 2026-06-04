import type { ConsoleAdminAuditResult } from '../../audit/IAdminAuditWriter.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { ConsoleHandlerResult, ConsoleRequest, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import type { IConsoleAccountAdminStore } from '../../stores/IConsoleAccountAdminStore.js';
import type { IAccountAdminMutationTransactionRunner } from './AccountAdminMutationTransaction.js';
import {
  serializeAccountIdentityList,
  serializeAccountIdentityMutation,
} from './AccountAdminIdentityDtos.js';

export interface AccountAdminIdentityServiceOptions {
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly transactionRunner: IAccountAdminMutationTransactionRunner;
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
    requireConsoleAuthentication(req);
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
    if (target.linkedUserId === userId) {
      await this.writeAttemptAudit(req, route, 'conflict', 'already_linked', userId, sub, 'link');
      return problem(409, 'already_linked', 'Conflict', 'That login is already linked to this account.');
    }
    if (target.linkedUserId !== null) {
      await this.writeAttemptAudit(req, route, 'conflict', 'linked_elsewhere', userId, sub, 'link');
      return problem(409, 'linked_elsewhere', 'Conflict', 'That login is linked to another account; unlink it there first.');
    }

    const occurredAt = this.now();
    const linked = await this.options.transactionRunner.run(async tx => {
      const result = await tx.linkIdentity({ userId, sub, linkedAt: occurredAt });
      const ok = result !== null;
      await tx.writeAdminAuditEvent(buildIdentityAuditEvent({
        route,
        req,
        result: ok ? 'approved' : 'conflict',
        errorCode: ok ? null : 'linked_elsewhere',
        occurredAt,
        userId,
        sub,
        argsRedacted: { operation: 'link', provider: target.provider, sub },
        resultDetailRedacted: { linked: ok },
      }));
      return ok;
    });
    if (!linked) {
      return problem(409, 'linked_elsewhere', 'Conflict', 'That login was linked to another account concurrently.');
    }
    return { status: 200, body: serializeAccountIdentityMutation(userId, sub, true) };
  }

  async unlinkIdentity(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
  ): Promise<ConsoleHandlerResult> {
    requireConsoleAuthentication(req);
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
    const unlinked = await this.options.transactionRunner.run(async tx => {
      const result = await tx.unlinkIdentity({ userId, sub, unlinkedAt: occurredAt });
      const ok = result !== null;
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
      return ok;
    });
    if (!unlinked) {
      return problem(404, 'not_found', 'Not found', 'That login is not linked to this account.');
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
