export interface AccountInviteDto {
  readonly invite_url: string;
  readonly expires_at: string;
  readonly user_id: string;
  readonly primary_sub: string;
}

export interface AccountBootstrapStatusDto {
  readonly completed: boolean;
  readonly completed_at: string | null;
  readonly admin_user_id: string | null;
}

export function serializeAccountInvite(input: {
  readonly inviteUrl: string;
  readonly expiresAt: Date;
  readonly userId: string;
  readonly primarySub: string;
}): AccountInviteDto {
  return {
    invite_url: input.inviteUrl,
    expires_at: input.expiresAt.toISOString(),
    user_id: input.userId,
    primary_sub: input.primarySub,
  };
}

export function serializeAccountBootstrapStatus(input: {
  readonly completed: boolean;
  readonly completedAt: Date | null;
  readonly adminUserId: string | null;
}): AccountBootstrapStatusDto {
  return {
    completed: input.completed,
    completed_at: input.completedAt ? input.completedAt.toISOString() : null,
    admin_user_id: input.adminUserId,
  };
}
