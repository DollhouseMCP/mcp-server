import type { ConsoleAdminAuditResult } from '../../audit/IAdminAuditWriter.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import type { ConsoleHandlerResult, ConsoleRequest, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import {
  CONSOLE_ADMIN_ROLES,
  type ConsoleAdminRole,
  type IConsoleAccountAdminStore,
} from '../../stores/IConsoleAccountAdminStore.js';
import { ConsoleStoreConflictError } from '../../stores/ConsoleStoreValidation.js';
import type { IAccountAdminMutationTransactionRunner } from './AccountAdminMutationTransaction.js';
import { serializeAccountRoleList } from './AccountAdminDtos.js';

export interface AccountAdminRoleMutationServiceOptions {
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly transactionRunner: IAccountAdminMutationTransactionRunner;
  readonly now?: () => Date;
}

export class AccountAdminRoleMutationService {
  constructor(private readonly options: AccountAdminRoleMutationServiceOptions) {}

  async replaceRoles(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
  ): Promise<ConsoleHandlerResult> {
    const parsed = parseRolesBody(req.body);
    if (parsed.kind === 'invalid') {
      await this.writeAttemptAudit(req, route, 'rejected', 'validation_failed', userId, parsed.auditArgs);
      return validationProblem(parsed.detail);
    }
    return this.mutateRoles(req, route, userId, parsed.roles, 'replace');
  }

  async grantRole(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
  ): Promise<ConsoleHandlerResult> {
    const parsed = parseRoleBody(req.body);
    if (parsed.kind === 'invalid') {
      await this.writeAttemptAudit(req, route, 'rejected', 'validation_failed', userId, parsed.auditArgs);
      return validationProblem(parsed.detail);
    }
    const current = await this.currentRolesOrNotFound(req, route, userId, { role: parsed.role });
    if (current.kind === 'problem') return current.result;
    if (current.roles.includes(parsed.role)) {
      await this.writeAttemptAudit(req, route, 'conflict', 'conflict', userId, { role: parsed.role });
      return problem(409, 'conflict', 'Conflict', 'Administrative role is already active for principal.');
    }
    return this.mutateRoles(req, route, userId, uniqueSortedRoles([...current.roles, parsed.role]), 'grant');
  }

  async revokeRole(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
  ): Promise<ConsoleHandlerResult> {
    const parsed = parseRoleBody(req.body);
    if (parsed.kind === 'invalid') {
      await this.writeAttemptAudit(req, route, 'rejected', 'validation_failed', userId, parsed.auditArgs);
      return validationProblem(parsed.detail);
    }
    const current = await this.currentRolesOrNotFound(req, route, userId, { role: parsed.role });
    if (current.kind === 'problem') return current.result;
    if (!current.roles.includes(parsed.role)) {
      await this.writeAttemptAudit(req, route, 'failed', 'not_found', userId, { role: parsed.role });
      return problem(404, 'not_found', 'Not found', 'Active administrative role was not found.');
    }
    return this.mutateRoles(
      req,
      route,
      userId,
      current.roles.filter(role => role !== parsed.role),
      'revoke',
    );
  }

  private async mutateRoles(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
    desiredRoles: readonly ConsoleAdminRole[],
    operation: 'replace' | 'grant' | 'revoke',
  ): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const occurredAt = this.now();
    const before = await this.options.accountAdminStore.findPrincipal(userId);
    if (!before) {
      await this.writeAttemptAudit(req, route, 'failed', 'not_found', userId, { operation, roles: [...desiredRoles] });
      return problem(404, 'not_found', 'Not found', 'User principal was not found.');
    }

    const grants = desiredRoles.filter(role => !before.roles.includes(role));
    const revokes = before.roles.filter(role => !desiredRoles.includes(role));
    if (actor.userId === userId && grants.length > 0) {
      await this.writeAttemptAudit(
        req,
        route,
        'rejected',
        'self_escalation_denied',
        userId,
        { operation, grants },
      );
      return problem(
        403,
        'self_escalation_denied',
        'Forbidden',
        'Administrators cannot grant additional roles to their own principal.',
      );
    }

    if (await this.wouldOrphanAccountsAdmin(before.roles, desiredRoles, before.disabledAt === null)) {
      await this.writeAttemptAudit(
        req,
        route,
        'rejected',
        'would_orphan_accounts_admin',
        userId,
        { operation, roles: [...desiredRoles] },
      );
      return problem(
        422,
        'would_orphan_accounts_admin',
        'Validation failed',
        'Role mutation would leave zero enabled account administrators.',
      );
    }

    const changed = grants.length > 0 || revokes.length > 0;
    const nextAuthzVersion = before.authzVersion + grants.length + revokes.length;

    try {
      await this.options.transactionRunner.run(async tx => {
        for (const role of grants) {
          await tx.grantRole({
            userId,
            role,
            grantedByUserId: actor.userId,
            grantedAt: occurredAt,
          });
        }
        for (const role of revokes) {
          const revoked = await tx.revokeRole({
            userId,
            role,
            revokedByUserId: actor.userId,
            revokedAt: occurredAt,
          });
          if (!revoked) throw new WouldOrphanAccountsAdminError();
        }
        if (changed) {
          await tx.appendSecurityInvalidationEvent({
            kind: 'principal_authz_changed',
            urgency: 'eventual',
            userId,
            authzVersion: nextAuthzVersion,
            reason: 'account_admin_role_mutation',
            payload: {
              previousAuthzVersion: before.authzVersion,
              newAuthzVersion: nextAuthzVersion,
            },
            createdAt: occurredAt,
            createdByUserId: actor.userId,
          });
        }
        await tx.writeAdminAuditEvent(buildMutationAuditEvent({
          route,
          req,
          result: 'approved',
          errorCode: null,
          occurredAt,
          userId,
          argsRedacted: { operation, grants, revokes, roles: [...desiredRoles] },
          resultDetailRedacted: { changed, invalidation_appended: changed },
        }));
      });
    } catch (error) {
      if (error instanceof WouldOrphanAccountsAdminError) {
        await this.writeAttemptAudit(
          req,
          route,
          'rejected',
          'would_orphan_accounts_admin',
          userId,
          { operation, roles: [...desiredRoles] },
        );
        return problem(
          422,
          'would_orphan_accounts_admin',
          'Validation failed',
          'Role mutation would leave zero enabled account administrators.',
        );
      }
      if (error instanceof ConsoleStoreConflictError) {
        await this.writeAttemptAudit(req, route, 'conflict', 'conflict', userId, { operation, roles: [...desiredRoles] });
        return problem(409, 'conflict', 'Conflict', 'Administrative role mutation conflicted with current state.');
      }
      throw error;
    }

    const after = await this.options.accountAdminStore.findPrincipal(userId);
    if (!after) throw new Error('mutated principal could not be reloaded');
    return { status: 200, body: serializeAccountRoleList(userId, after.roles) };
  }

  private async currentRolesOrNotFound(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
    auditArgs: Readonly<Record<string, unknown>>,
  ): Promise<
    | { readonly kind: 'roles'; readonly roles: readonly ConsoleAdminRole[] }
    | { readonly kind: 'problem'; readonly result: ConsoleHandlerResult }
  > {
    const principal = await this.options.accountAdminStore.findPrincipal(userId);
    if (!principal) {
      await this.writeAttemptAudit(req, route, 'failed', 'not_found', userId, auditArgs);
      return { kind: 'problem', result: problem(404, 'not_found', 'Not found', 'User principal was not found.') };
    }
    return { kind: 'roles', roles: principal.roles };
  }

  private async wouldOrphanAccountsAdmin(
    beforeRoles: readonly ConsoleAdminRole[],
    desiredRoles: readonly ConsoleAdminRole[],
    targetEnabled: boolean,
  ): Promise<boolean> {
    if (!targetEnabled || !hasAccountsAdminRole(beforeRoles) || hasAccountsAdminRole(desiredRoles)) return false;
    return await this.options.accountAdminStore.countEnabledAccountsAdmins() <= 1;
  }

  private async writeAttemptAudit(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    result: ConsoleAdminAuditResult,
    errorCode: string | null,
    targetUserId: string | null,
    argsRedacted: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.options.transactionRunner.run(tx => tx.writeAdminAuditEvent(buildMutationAuditEvent({
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

interface MutationAuditEventInput {
  readonly route: ConsoleRouteDefinition;
  readonly req: ConsoleRequest;
  readonly result: ConsoleAdminAuditResult;
  readonly errorCode: string | null;
  readonly occurredAt: Date;
  readonly userId: string | null;
  readonly argsRedacted: Readonly<Record<string, unknown>>;
  readonly resultDetailRedacted: Readonly<Record<string, unknown>> | null;
}

function buildMutationAuditEvent(input: MutationAuditEventInput) {
  const { route, req, result, errorCode, occurredAt, userId, argsRedacted, resultDetailRedacted } = input;
  return buildConsoleAdminAuditEvent(route, route.auditOperation ?? '', req, result, errorCode, occurredAt, {
    resourceKind: 'account_principal_roles',
    resourceId: userId,
    targetUserId: userId,
    argsRedacted,
    resultDetailRedacted,
  });
}

function parseRoleBody(body: unknown):
  | { readonly kind: 'valid'; readonly role: ConsoleAdminRole }
  | { readonly kind: 'invalid'; readonly detail: string; readonly auditArgs: Readonly<Record<string, unknown>> } {
  if (!isRecord(body) || typeof body.role !== 'string') {
    return { kind: 'invalid', detail: 'Request body must contain a role string.', auditArgs: {} };
  }
  if (!isConsoleAdminRole(body.role)) {
    return {
      kind: 'invalid',
      detail: 'Request body contains an unknown administrative role.',
      auditArgs: { role_invalid: true, role_length: body.role.length },
    };
  }
  return { kind: 'valid', role: body.role };
}

function parseRolesBody(body: unknown):
  | { readonly kind: 'valid'; readonly roles: readonly ConsoleAdminRole[] }
  | { readonly kind: 'invalid'; readonly detail: string; readonly auditArgs: Readonly<Record<string, unknown>> } {
  if (!isRecord(body) || !Array.isArray(body.roles)) {
    return { kind: 'invalid', detail: 'Request body must contain a roles array.', auditArgs: {} };
  }
  for (const role of body.roles) {
    if (typeof role !== 'string' || !isConsoleAdminRole(role)) {
      return {
        kind: 'invalid',
        detail: 'Roles array contains an unknown administrative role.',
        auditArgs: { roles_count: body.roles.length },
      };
    }
  }
  return { kind: 'valid', roles: uniqueSortedRoles(body.roles) };
}

function uniqueSortedRoles(roles: readonly ConsoleAdminRole[]): ConsoleAdminRole[] {
  return [...new Set(roles)].sort();
}

function isConsoleAdminRole(value: string): value is ConsoleAdminRole {
  return (CONSOLE_ADMIN_ROLES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasAccountsAdminRole(roles: readonly ConsoleAdminRole[]): boolean {
  return roles.includes('admin') || roles.includes('account_admin');
}

function validationProblem(detail: string): ConsoleHandlerResult {
  return problem(422, 'validation_failed', 'Validation failed', detail);
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

class WouldOrphanAccountsAdminError extends Error {
  constructor() {
    super('role mutation would orphan account administrators');
    this.name = 'WouldOrphanAccountsAdminError';
  }
}
