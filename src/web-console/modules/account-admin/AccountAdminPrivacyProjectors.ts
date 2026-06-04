import type {
  AccountDeletionDto,
  AccountPrincipalDto,
  AccountPrincipalLifecycleDto,
  AccountPrincipalListDto,
  AccountRoleListDto,
} from './AccountAdminDtos.js';
import type {
  AccountAllowlistEntryDto,
  AccountAllowlistListDto,
} from './AccountAdminAllowlistDtos.js';
import type {
  AccountBootstrapStatusDto,
  AccountInviteDto,
} from './AccountAdminOnboardingDtos.js';
import type {
  AccountIdentityDto,
  AccountIdentityListDto,
  AccountIdentityMutationDto,
} from './AccountAdminIdentityDtos.js';
import {
  serializeAccountIdentityList,
  serializeAccountIdentityMutation,
} from './AccountAdminIdentityDtos.js';
import {
  serializeAccountAllowlistEntry,
  serializeAccountAllowlistList,
} from './AccountAdminAllowlistDtos.js';
import {
  serializeAccountBootstrapStatus,
  serializeAccountInvite,
} from './AccountAdminOnboardingDtos.js';
import {
  serializeAccountDeletion,
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

export function projectAccountAllowlistEntry(value: unknown): AccountAllowlistEntryDto {
  return serializeAccountAllowlistEntry(fromAllowlistDto(value));
}

export function projectAccountAllowlistList(value: unknown): AccountAllowlistListDto {
  const list = value as AccountAllowlistListDto;
  return serializeAccountAllowlistList(list.entries.map(item => fromAllowlistDto(item)));
}

export function projectAccountInvite(value: unknown): AccountInviteDto {
  const invite = value as AccountInviteDto;
  return serializeAccountInvite({
    inviteUrl: invite.invite_url,
    expiresAt: new Date(invite.expires_at),
    userId: invite.user_id,
    primarySub: invite.primary_sub,
  });
}

export function projectAccountBootstrapStatus(value: unknown): AccountBootstrapStatusDto {
  const status = value as AccountBootstrapStatusDto;
  return serializeAccountBootstrapStatus({
    completed: status.completed === true,
    completedAt: status.completed_at ? new Date(status.completed_at) : null,
    adminUserId: status.admin_user_id ?? null,
  });
}

export function projectAccountPrincipalLifecycle(value: unknown): AccountPrincipalLifecycleDto {
  const lifecycle = value as AccountPrincipalLifecycleDto;
  const summary = fromPrincipalDto(lifecycle.user);
  const revocationSummary = lifecycle.revocation_summary
    ? {
      browser_sessions_revoked: numberField(lifecycle.revocation_summary, 'browser_sessions_revoked'),
      mcp_oauth_grants_revoked: numberField(lifecycle.revocation_summary, 'mcp_oauth_grants_revoked'),
      mcp_sessions_terminated: numberField(lifecycle.revocation_summary, 'mcp_sessions_terminated'),
      mcp_sessions_termination_requested: optionalNumberField(lifecycle.revocation_summary, 'mcp_sessions_termination_requested'),
      mcp_sessions_termination_acknowledged: optionalNumberField(lifecycle.revocation_summary, 'mcp_sessions_termination_acknowledged'),
      mcp_sessions_termination_failed: optionalNumberField(lifecycle.revocation_summary, 'mcp_sessions_termination_failed'),
      mcp_sessions_termination_timed_out: optionalNumberField(lifecycle.revocation_summary, 'mcp_sessions_termination_timed_out'),
      authz_version_bumped: lifecycle.revocation_summary.authz_version_bumped === true,
      new_authz_version: optionalNumberField(lifecycle.revocation_summary, 'new_authz_version'),
    }
    : undefined;
  return serializeAccountPrincipalLifecycle(summary, revocationSummary);
}

export function projectAccountDeletion(value: unknown): AccountDeletionDto {
  const deletion = value as AccountDeletionDto;
  const summary = deletion.revocation_summary;
  return serializeAccountDeletion({
    userId: deletion.user_id,
    outcome: deletion.outcome === 'deleted' ? 'deleted' : 'anonymized',
    deletedAt: new Date(deletion.deleted_at),
    revocationSummary: summary
      ? {
        browser_sessions_revoked: numberField(summary, 'browser_sessions_revoked'),
        mcp_oauth_grants_revoked: numberField(summary, 'mcp_oauth_grants_revoked'),
        mcp_sessions_terminated: numberField(summary, 'mcp_sessions_terminated'),
        mcp_sessions_termination_requested: optionalNumberField(summary, 'mcp_sessions_termination_requested'),
        mcp_sessions_termination_acknowledged: optionalNumberField(summary, 'mcp_sessions_termination_acknowledged'),
        mcp_sessions_termination_failed: optionalNumberField(summary, 'mcp_sessions_termination_failed'),
        mcp_sessions_termination_timed_out: optionalNumberField(summary, 'mcp_sessions_termination_timed_out'),
        authz_version_bumped: summary.authz_version_bumped === true,
        new_authz_version: optionalNumberField(summary, 'new_authz_version'),
      }
      : undefined,
  });
}

export function projectAccountIdentityList(value: unknown): AccountIdentityListDto {
  const list = value as AccountIdentityListDto;
  return serializeAccountIdentityList(list.user_id, list.identities.map(fromIdentityDto));
}

export function projectAccountIdentityMutation(value: unknown): AccountIdentityMutationDto {
  const mutation = value as AccountIdentityMutationDto;
  return serializeAccountIdentityMutation(mutation.user_id, mutation.sub, mutation.linked === true);
}

function fromIdentityDto(value: AccountIdentityDto) {
  return {
    sub: value.sub,
    provider: value.provider,
    externalSub: value.external_sub,
    email: value.email,
    emailVerified: value.email_verified,
    displayName: value.display_name,
    linkedUserId: value.linked_user_id,
    createdAt: new Date(value.created_at),
    lastAuthAt: value.last_auth_at ? new Date(value.last_auth_at) : null,
  };
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

function fromAllowlistDto(value: unknown) {
  const entry = value as AccountAllowlistEntryDto;
  return {
    id: entry.id,
    kind: entry.kind,
    normalizedValue: '',
    displayValue: entry.value,
    note: entry.note,
    createdByUserId: entry.created_by_user_id ?? '',
    createdAt: new Date(entry.created_at),
    revokedByUserId: null,
    revokedAt: null,
  };
}
