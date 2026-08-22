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
import { rolesActorMayNotManage } from './AccountAdminRoleAuthority.js';
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
    return this.mutateRoles(req, route, userId, [parsed.role], 'grant');
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
    return this.mutateRoles(req, route, userId, [parsed.role], 'revoke');
  }

  private async mutateRoles(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    userId: string,
    requestedRoles: readonly ConsoleAdminRole[],
    operation: 'replace' | 'grant' | 'revoke',
  ): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const occurredAt = this.now();
    try {
      const result = await this.options.transactionRunner.run(async tx => {
        const before = await tx.lockPrincipal(userId);
        if (!before) {
          await tx.writeAdminAuditEvent(buildMutationAuditEvent({
            route, req, result: 'failed', errorCode: 'not_found', occurredAt, userId,
            argsRedacted: { operation, roles: [...requestedRoles] }, resultDetailRedacted: null,
          }));
          return problem(404, 'not_found', 'Not found', 'User principal was not found.');
        }
        const desiredRoles = operation === 'replace'
          ? requestedRoles
          : operation === 'grant'
            ? uniqueSortedRoles([...before.roles, requestedRoles[0]])
            : before.roles.filter(role => role !== requestedRoles[0]);
        const grants = desiredRoles.filter(role => !before.roles.includes(role));
        const revokes = before.roles.filter(role => !desiredRoles.includes(role));

        const rejection = roleMutationRejection(req, actor.userId, userId, operation, grants, revokes);
        if (rejection) {
          await tx.writeAdminAuditEvent(buildMutationAuditEvent({
            route, req, result: rejection.result, errorCode: rejection.code, occurredAt, userId,
            argsRedacted: rejection.args, resultDetailRedacted: null,
          }));
          return rejection.response;
        }
        if (operation === 'grant' && grants.length === 0) {
          await tx.writeAdminAuditEvent(buildMutationAuditEvent({
            route, req, result: 'conflict', errorCode: 'conflict', occurredAt, userId,
            argsRedacted: { operation, role: requestedRoles[0] }, resultDetailRedacted: null,
          }));
          return problem(409, 'conflict', 'Conflict', 'Administrative role is already active for principal.');
        }
        if (operation === 'revoke' && revokes.length === 0) {
          await tx.writeAdminAuditEvent(buildMutationAuditEvent({
            route, req, result: 'failed', errorCode: 'not_found', occurredAt, userId,
            argsRedacted: { operation, role: requestedRoles[0] }, resultDetailRedacted: null,
          }));
          return problem(404, 'not_found', 'Not found', 'Active administrative role was not found.');
        }
        const changed = grants.length > 0 || revokes.length > 0;
        const nextAuthzVersion = before.authzVersion + grants.length + revokes.length;
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
        return { status: 200, body: serializeAccountRoleList(userId, desiredRoles) };
      }, actor);
      return result;
    } catch (error) {
      if (error instanceof WouldOrphanAccountsAdminError) {
        await this.writeAttemptAudit(
          req,
          route,
          'rejected',
          'would_orphan_accounts_admin',
          userId,
          { operation, roles: [...requestedRoles] },
        );
        return problem(
          422,
          'would_orphan_accounts_admin',
          'Validation failed',
          'Role mutation would leave zero enabled account administrators.',
        );
      }
      if (error instanceof ConsoleStoreConflictError) {
        await this.writeAttemptAudit(req, route, 'conflict', 'conflict', userId, { operation, roles: [...requestedRoles] });
        return problem(409, 'conflict', 'Conflict', 'Administrative role mutation conflicted with current state.');
      }
      throw error;
    }

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
  return [...new Set(roles)].sort((a, b) => a.localeCompare(b));
}

function roleMutationRejection(
  req: ConsoleRequest,
  actorUserId: string,
  targetUserId: string,
  operation: 'replace' | 'grant' | 'revoke',
  grants: readonly ConsoleAdminRole[],
  revokes: readonly ConsoleAdminRole[],
): {
  readonly result: ConsoleAdminAuditResult;
  readonly code: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly response: ConsoleHandlerResult;
} | null {
  if (actorUserId === targetUserId && grants.length > 0) {
    return {
      result: 'rejected',
      code: 'self_escalation_denied',
      args: { operation, grants },
      response: problem(403, 'self_escalation_denied', 'Forbidden',
        'Administrators cannot grant additional roles to their own principal.'),
    };
  }
  const unauthorizedGrants = rolesActorMayNotManage(req, grants);
  if (unauthorizedGrants.length > 0) {
    return {
      result: 'rejected',
      code: 'insufficient_role_authority',
      args: { operation, grants: unauthorizedGrants },
      response: problem(403, 'insufficient_role_authority', 'Forbidden',
        'Actor cannot grant administrative roles outside their assigned capability tier.'),
    };
  }
  const unauthorizedRevokes = rolesActorMayNotManage(req, revokes);
  if (unauthorizedRevokes.length > 0) {
    return {
      result: 'rejected',
      code: 'insufficient_role_authority',
      args: { operation, revokes: unauthorizedRevokes },
      response: problem(403, 'insufficient_role_authority', 'Forbidden',
        'Actor cannot revoke administrative roles outside their assigned capability tier.'),
    };
  }
  return null;
}

function isConsoleAdminRole(value: string): value is ConsoleAdminRole {
  return (CONSOLE_ADMIN_ROLES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
