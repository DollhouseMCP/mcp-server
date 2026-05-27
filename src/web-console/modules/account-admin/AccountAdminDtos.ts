import type {
  ConsoleAdminRole,
  ConsolePrincipalSummary,
} from '../../stores/IConsoleAccountAdminStore.js';

export interface AccountPrincipalDto {
  readonly user_id: string;
  readonly primary_sub: string | null;
  readonly username: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly email_verified: boolean;
  readonly auth_methods: readonly string[];
  readonly roles: readonly ConsoleAdminRole[];
  readonly disabled_at: string | null;
  readonly created_at: string;
  readonly last_login_at: string | null;
  readonly admin_factor_enrolled: boolean;
}

export interface AccountPrincipalListDto {
  readonly users: readonly AccountPrincipalDto[];
}

export interface AccountRoleListDto {
  readonly user_id: string;
  readonly roles: readonly ConsoleAdminRole[];
}

export interface AccountPrincipalLifecycleDto {
  readonly user: AccountPrincipalDto;
  readonly revocation_summary?: {
    readonly browser_sessions_revoked: number;
    readonly mcp_oauth_grants_revoked: number;
    readonly mcp_refresh_tokens_revoked: number;
    readonly mcp_sessions_terminated: number;
    readonly authz_version_bumped: boolean;
  };
}

export function serializeAccountPrincipal(summary: ConsolePrincipalSummary): AccountPrincipalDto {
  return {
    user_id: summary.userId,
    primary_sub: summary.primarySub,
    username: summary.username,
    display_name: summary.displayName,
    email: summary.email,
    email_verified: summary.emailVerified,
    auth_methods: [...summary.authMethods],
    roles: [...summary.roles],
    disabled_at: summary.disabledAt?.toISOString() ?? null,
    created_at: summary.createdAt.toISOString(),
    last_login_at: summary.lastLoginAt?.toISOString() ?? null,
    admin_factor_enrolled: summary.adminFactorEnrolled,
  };
}

export function serializeAccountPrincipalList(
  summaries: readonly ConsolePrincipalSummary[],
): AccountPrincipalListDto {
  return {
    users: summaries.map(summary => serializeAccountPrincipal(summary)),
  };
}

export function serializeAccountRoleList(userId: string, roles: readonly ConsoleAdminRole[]): AccountRoleListDto {
  return {
    user_id: userId,
    roles: [...roles],
  };
}

export function serializeAccountPrincipalLifecycle(
  summary: ConsolePrincipalSummary,
  revocationSummary?: AccountPrincipalLifecycleDto['revocation_summary'],
): AccountPrincipalLifecycleDto {
  return {
    user: serializeAccountPrincipal(summary),
    ...(revocationSummary ? { revocation_summary: revocationSummary } : {}),
  };
}
