import type {
  AccountPrincipalDto,
  AccountPrincipalListDto,
  AccountRoleListDto,
} from './AccountAdminDtos.js';
import {
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
