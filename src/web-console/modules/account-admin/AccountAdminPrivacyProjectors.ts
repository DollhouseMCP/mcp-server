import type {
  AccountPrincipalDto,
  AccountPrincipalLifecycleDto,
  AccountPrincipalListDto,
  AccountRoleListDto,
} from './AccountAdminDtos.js';
import {
  serializeAccountPrincipalLifecycle,
  serializeAccountPrincipal,
  serializeAccountPrincipalList,
  serializeAccountRoleList,
} from './AccountAdminDtos.js';

export function projectAccountPrincipal(value: unknown): AccountPrincipalDto {
  return serializeAccountPrincipal(fromPrincipalDto(value));
}

export function projectAccountPrincipalList(value: unknown): AccountPrincipalListDto {
  const list = value as AccountPrincipalListDto;
  return serializeAccountPrincipalList(list.users.map(item => fromPrincipalDto(item)));
}

export function projectAccountRoleList(value: unknown): AccountRoleListDto {
  const roleList = value as AccountRoleListDto;
  return serializeAccountRoleList(roleList.user_id, roleList.roles);
}

export function projectAccountPrincipalLifecycle(value: unknown): AccountPrincipalLifecycleDto {
  const lifecycle = value as AccountPrincipalLifecycleDto;
  const summary = fromPrincipalDto(lifecycle.user);
  const revocationSummary = lifecycle.revocation_summary
    ? {
      browser_sessions_revoked: numberField(lifecycle.revocation_summary, 'browser_sessions_revoked'),
      mcp_oauth_grants_revoked: numberField(lifecycle.revocation_summary, 'mcp_oauth_grants_revoked'),
      mcp_sessions_terminated: numberField(lifecycle.revocation_summary, 'mcp_sessions_terminated'),
      authz_version_bumped: lifecycle.revocation_summary.authz_version_bumped === true,
      new_authz_version: optionalNumberField(lifecycle.revocation_summary, 'new_authz_version'),
    }
    : undefined;
  return serializeAccountPrincipalLifecycle(summary, revocationSummary);
}

function numberField(record: Readonly<Record<string, unknown>>, key: string): number {
  return Number(record[key] ?? 0);
}

function optionalNumberField(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  return record[key] === undefined ? undefined : Number(record[key]);
}

function fromPrincipalDto(value: unknown): {
  readonly userId: string;
  readonly primarySub: string | null;
  readonly username: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly authMethods: readonly string[];
  readonly roles: AccountPrincipalDto['roles'];
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
  readonly adminFactorEnrolled: boolean;
  readonly accountCorrelationId: string;
  readonly authzVersion: number;
} {
  const principal = value as AccountPrincipalDto;
  return {
    userId: principal.user_id,
    primarySub: principal.primary_sub,
    username: principal.username,
    displayName: principal.display_name,
    email: principal.email,
    emailVerified: principal.email_verified,
    authMethods: principal.auth_methods,
    roles: principal.roles,
    disabledAt: principal.disabled_at ? new Date(principal.disabled_at) : null,
    createdAt: new Date(principal.created_at),
    lastLoginAt: principal.last_login_at ? new Date(principal.last_login_at) : null,
    adminFactorEnrolled: principal.admin_factor_enrolled,
    accountCorrelationId: '',
    authzVersion: 0,
  };
}
