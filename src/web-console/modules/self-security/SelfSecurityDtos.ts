import type { ConsoleFactorStatus } from '../../stores/IConsoleFactorStore.js';
import type { ConsoleSessionRecord } from '../../stores/IConsoleSessionStore.js';

export interface SelfSecurityFactorsDto {
  readonly totp: {
    readonly enrolled: boolean;
    readonly enrolled_at: string | null;
    readonly last_used_at: string | null;
    readonly backup_codes_remaining: number;
  };
  readonly webauthn: {
    readonly enrolled: false;
  };
}

export interface SelfSecuritySessionDto {
  readonly session_id: string;
  readonly current: boolean;
  readonly created_at: string;
  readonly last_used_at: string;
  readonly idle_expires_at: string;
  readonly absolute_expires_at: string;
  readonly elevated_until: string | null;
  readonly last_ip: string | null;
  readonly user_agent: string | null;
}

export interface SelfSecuritySessionListDto {
  readonly sessions: readonly SelfSecuritySessionDto[];
  readonly truncated: boolean;
  readonly limit: number;
}

export interface SelfSecuritySessionRevocationDto {
  readonly session_id: string;
  readonly revoked: boolean;
  readonly current_session_revoked: boolean;
}

export interface SelfSecurityRevokeOthersDto {
  readonly revoked: number;
}

export function serializeSelfSecurityFactors(status: ConsoleFactorStatus): SelfSecurityFactorsDto {
  return {
    totp: {
      enrolled: status.enrolled,
      enrolled_at: status.enrolledAt?.toISOString() ?? null,
      last_used_at: status.lastUsedAt?.toISOString() ?? null,
      backup_codes_remaining: status.enrolled ? status.backupCodesRemaining : 0,
    },
    // WebAuthn enrollment is not supported in v1; reserve the response
    // field so clients can render stable factor affordances.
    webauthn: { enrolled: false },
  };
}

export function serializeSelfSecuritySessions(
  sessions: readonly ConsoleSessionRecord[],
  currentSessionIdHash: Buffer,
  options: { readonly truncated: boolean; readonly limit: number },
): SelfSecuritySessionListDto {
  return {
    sessions: sessions.map(session => serializeSelfSecuritySession(session, currentSessionIdHash)),
    truncated: options.truncated,
    limit: options.limit,
  };
}

export function serializeSelfSecuritySession(
  session: ConsoleSessionRecord,
  currentSessionIdHash: Buffer,
): SelfSecuritySessionDto {
  return {
    session_id: encodeSessionId(session.idHash),
    current: session.idHash.equals(currentSessionIdHash),
    created_at: session.createdAt.toISOString(),
    last_used_at: session.lastUsedAt.toISOString(),
    idle_expires_at: session.idleExpiresAt.toISOString(),
    absolute_expires_at: session.absoluteExpiresAt.toISOString(),
    elevated_until: session.elevation?.expiresAt.toISOString() ?? null,
    last_ip: session.lastIp,
    user_agent: session.userAgent,
  };
}

export function encodeSessionId(idHash: Buffer): string {
  return idHash.toString('base64url');
}

export function decodeSessionId(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32 ? decoded : null;
}
