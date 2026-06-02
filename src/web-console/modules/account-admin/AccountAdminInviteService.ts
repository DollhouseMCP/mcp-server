import type { IAuthStorageLayer } from '../../../auth/embedded-as/storage/IAuthStorageLayer.js';
import type { ConsoleAdminAuditResult } from '../../audit/IAdminAuditWriter.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { ConsoleHandlerResult, ConsoleRequest, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import {
  type ConsoleAdminRole,
  assertAdminRole,
} from '../../stores/IConsoleAccountAdminStore.js';
import { ConsoleStoreConflictError, ConsoleStoreValidationError } from '../../stores/ConsoleStoreValidation.js';
import type { IAccountAdminMutationTransactionRunner } from './AccountAdminMutationTransaction.js';
import { serializeAccountInvite } from './AccountAdminOnboardingDtos.js';
import { rolesActorMayNotManage } from './AccountAdminRoleAuthority.js';

export interface ConsoleAccountInviteIssueInput {
  readonly username: string;
  readonly email: string;
  readonly ttlMinutes: number;
  readonly roles: readonly ConsoleAdminRole[];
  readonly actorUserId: string;
  readonly issuedAt: Date;
}

export interface ConsoleAccountInviteIssueResult {
  readonly inviteUrl: string;
  readonly expiresAt: Date;
  readonly userId: string;
  readonly primarySub: string;
}

/**
 * Issues exactly one invite for the provided request. The secured console
 * kernel owns idempotency replay for identical Idempotency-Key/body pairs;
 * implementations should still avoid hidden retries that mint additional
 * credentials after a partial failure.
 */
export interface IConsoleAccountInviteIssuer {
  issueInvite(input: ConsoleAccountInviteIssueInput): Promise<ConsoleAccountInviteIssueResult>;
}

export interface AccountAdminInviteServiceOptions {
  readonly authStorage?: IAuthStorageLayer | null;
  readonly inviteIssuer?: IConsoleAccountInviteIssuer | null;
  readonly transactionRunner: IAccountAdminMutationTransactionRunner;
  readonly now?: () => Date;
}

export class AccountAdminInviteService {
  constructor(private readonly options: AccountAdminInviteServiceOptions) {}

  async invite(req: ConsoleRequest, route: ConsoleRouteDefinition): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const issuedAt = this.now();
    const parsed = parseInviteBody(req.body);
    if (parsed.kind === 'invalid') {
      await this.writeAudit(req, route, 'rejected', 'invalid_request', null, {
        operation: 'invite',
        invalid_body: true,
      });
      return problem(400, 'invalid_request', 'Invalid request', parsed.detail);
    }
    const unauthorizedRoles = rolesActorMayNotManage(req, parsed.value.roles);
    if (unauthorizedRoles.length > 0) {
      await this.writeAudit(req, route, 'rejected', 'insufficient_role_authority', null, {
        operation: 'invite',
        roles: unauthorizedRoles,
      });
      return problem(
        403,
        'insufficient_role_authority',
        'Forbidden',
        'Actor cannot invite principals with administrative roles outside their assigned capability tier.',
      );
    }
    if (!this.options.authStorage) {
      await this.writeAudit(req, route, 'failed', 'service_unavailable', null, {
        operation: 'invite',
        dependency: 'auth_storage',
      });
      return problem(503, 'service_unavailable', 'Service unavailable', 'Invite bootstrap storage is unavailable.');
    }
    const bootstrap = await this.options.authStorage.getBootstrapState();
    if (!bootstrap.completed) {
      await this.writeAudit(req, route, 'rejected', 'no_admin_yet', null, {
        operation: 'invite',
      });
      return problem(412, 'no_admin_yet', 'Precondition failed', 'CLI bootstrap must be completed before invites can be issued.');
    }
    if (!this.options.inviteIssuer) {
      await this.writeAudit(req, route, 'failed', 'service_unavailable', null, {
        operation: 'invite',
        dependency: 'account_invite_issuer',
      });
      return problem(503, 'service_unavailable', 'Service unavailable', 'Account invite issuer is unavailable.');
    }

    let issued: ConsoleAccountInviteIssueResult;
    try {
      issued = await this.options.inviteIssuer.issueInvite({
        ...parsed.value,
        actorUserId: actor.userId,
        issuedAt,
      });
    } catch (error) {
      if (error instanceof ConsoleStoreConflictError) {
        await this.writeAudit(req, route, 'conflict', 'conflict', null, {
          operation: 'invite',
        });
        return problem(409, 'conflict', 'Conflict', 'An account with this username or email already exists.');
      }
      await this.writeAudit(req, route, 'failed', 'issuer_error', null, {
        operation: 'invite',
        dependency: 'account_invite_issuer',
      });
      return problem(503, 'service_unavailable', 'Service unavailable', 'Account invite issuer failed.');
    }
    await this.writeAudit(req, route, 'approved', null, issued.userId, {
      operation: 'invite',
      roles: parsed.value.roles,
      ttlMinutes: parsed.value.ttlMinutes,
    });
    return {
      status: 201,
      body: serializeAccountInvite(issued),
    };
  }

  private async writeAudit(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    result: ConsoleAdminAuditResult,
    errorCode: string | null,
    resourceId: string | null,
    argsRedacted: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.options.transactionRunner.run(tx => tx.writeAdminAuditEvent(buildConsoleAdminAuditEvent(
      route,
      route.auditOperation ?? '',
      req,
      result,
      errorCode,
      this.now(),
      {
        resourceKind: 'account_principal',
        resourceId,
        targetUserId: resourceId,
        argsRedacted,
        resultDetailRedacted: null,
      },
    )));
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function parseInviteBody(body: unknown): { readonly kind: 'valid'; readonly value: {
  readonly username: string;
  readonly email: string;
  readonly ttlMinutes: number;
  readonly roles: readonly ConsoleAdminRole[];
} } | { readonly kind: 'invalid'; readonly detail: string } {
  try {
    if (!isRecord(body)) throw new ConsoleStoreValidationError('request body is required.');
    const username = stringField(body, 'username');
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(username)) {
      throw new ConsoleStoreValidationError('username must match /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/');
    }
    const email = stringField(body, 'email');
    if (!isLiteEmailAddress(email)) throw new ConsoleStoreValidationError('email must be a valid email address');
    const ttlMinutes = body.ttl_minutes === undefined ? 15 : integerField(body, 'ttl_minutes');
    if (ttlMinutes < 1 || ttlMinutes > 60) throw new ConsoleStoreValidationError('ttl_minutes must be between 1 and 60');
    const roles = body.roles === undefined ? [] : roleArray(body.roles);
    return {
      kind: 'valid',
      value: {
        username,
        email,
        ttlMinutes,
        roles,
      },
    };
  } catch (error) {
    return {
      kind: 'invalid',
      detail: error instanceof Error ? error.message : 'Invalid invite request.',
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new ConsoleStoreValidationError(`${key} must be a string.`);
  const trimmed = value.trim();
  if (trimmed === '') throw new ConsoleStoreValidationError(`${key} must be non-empty.`);
  return trimmed;
}

function integerField(record: Readonly<Record<string, unknown>>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ConsoleStoreValidationError(`${key} must be an integer.`);
  }
  return value;
}

function roleArray(value: unknown): readonly ConsoleAdminRole[] {
  if (!Array.isArray(value)) throw new ConsoleStoreValidationError('roles must be an array.');
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new ConsoleStoreValidationError(`roles[${index}] must be a string.`);
    assertAdminRole(item, `roles[${index}]`);
    return item;
  });
}

function isLiteEmailAddress(value: string): boolean {
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return false;
  const domain = value.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
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
