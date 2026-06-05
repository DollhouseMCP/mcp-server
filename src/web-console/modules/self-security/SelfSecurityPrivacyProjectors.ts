import type {
  SelfSecurityFactorsDto,
  SelfSecurityRevokeOthersDto,
  SelfSecuritySessionListDto,
  SelfSecuritySessionRevocationDto,
} from './SelfSecurityDtos.js';

export function projectSelfSecurityFactors(value: unknown): SelfSecurityFactorsDto {
  const input = asRecord(value);
  const totp = asRecord(input.totp);
  return {
    totp: {
      enrolled: totp.enrolled === true,
      enrolled_at: nullableStringField(totp, 'enrolled_at'),
      last_used_at: nullableStringField(totp, 'last_used_at'),
      backup_codes_remaining: numberField(totp, 'backup_codes_remaining'),
    },
    webauthn: { enrolled: false },
  };
}

export function projectSelfSecuritySessions(value: unknown): SelfSecuritySessionListDto {
  const input = asRecord(value);
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  return {
    sessions: sessions.map(projectSelfSecuritySession),
    truncated: input.truncated === true,
    limit: numberField(input, 'limit'),
  };
}

export function projectSelfSecuritySessionRevocation(value: unknown): SelfSecuritySessionRevocationDto {
  const input = asRecord(value);
  return {
    session_id: stringField(input, 'session_id'),
    revoked: input.revoked === true,
    current_session_revoked: input.current_session_revoked === true,
  };
}

export function projectSelfSecurityRevokeOthers(value: unknown): SelfSecurityRevokeOthersDto {
  const input = asRecord(value);
  return {
    revoked: numberField(input, 'revoked'),
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nullableStringField(record: Readonly<Record<string, unknown>>, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] : null;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string {
  return typeof record[key] === 'string' ? record[key] : '';
}

function numberField(record: Readonly<Record<string, unknown>>, key: string): number {
  return typeof record[key] === 'number' && Number.isInteger(record[key]) && record[key] >= 0 ? record[key] : 0;
}

function projectSelfSecuritySession(value: unknown) {
  const input = asRecord(value);
  return {
    session_id: stringField(input, 'session_id'),
    current: input.current === true,
    created_at: stringField(input, 'created_at'),
    last_used_at: stringField(input, 'last_used_at'),
    idle_expires_at: stringField(input, 'idle_expires_at'),
    absolute_expires_at: stringField(input, 'absolute_expires_at'),
    elevated_until: nullableStringField(input, 'elevated_until'),
    last_ip: nullableStringField(input, 'last_ip'),
    user_agent: nullableStringField(input, 'user_agent'),
  };
}
