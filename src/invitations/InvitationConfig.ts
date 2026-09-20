export const DEFAULT_INVITATION_TTL_HOURS = 24;
export const MIN_INVITATION_TTL_HOURS = 1;
export const MAX_INVITATION_TTL_HOURS = 168;
export const MIN_INVITATION_RETENTION_DAYS = 1;
export const MAX_INVITATION_RETENTION_DAYS = 3650;

export interface InvitationConfig {
  readonly ttlHours: number;
  /** Null disables destructive terminal-record cleanup. */
  readonly terminalRetentionDays: number | null;
}
export class InvitationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvitationConfigError';
  }
}

export function readInvitationConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): InvitationConfig {
  return {
    ttlHours: parseBoundedInteger(
      env.DOLLHOUSE_INVITE_TTL_HOURS,
      'DOLLHOUSE_INVITE_TTL_HOURS',
      DEFAULT_INVITATION_TTL_HOURS,
      MIN_INVITATION_TTL_HOURS,
      MAX_INVITATION_TTL_HOURS,
    ),
    terminalRetentionDays: env.DOLLHOUSE_INVITE_RETENTION_DAYS === undefined
      ? null
      : parseBoundedInteger(
        env.DOLLHOUSE_INVITE_RETENTION_DAYS,
        'DOLLHOUSE_INVITE_RETENTION_DAYS',
        null,
        MIN_INVITATION_RETENTION_DAYS,
        MAX_INVITATION_RETENTION_DAYS,
      ),
  };
}

function parseBoundedInteger(
  raw: string | undefined,
  name: string,
  fallback: number | null,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined) {
    if (fallback === null) throw new InvitationConfigError(`${name} is required`);
    return fallback;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new InvitationConfigError(`${name} must be a base-10 integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new InvitationConfigError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
