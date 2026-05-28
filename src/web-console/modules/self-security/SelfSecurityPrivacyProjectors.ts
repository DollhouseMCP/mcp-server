import type { SelfSecurityFactorsDto } from './SelfSecurityDtos.js';

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

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nullableStringField(record: Readonly<Record<string, unknown>>, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] : null;
}

function numberField(record: Readonly<Record<string, unknown>>, key: string): number {
  return typeof record[key] === 'number' && Number.isInteger(record[key]) && record[key] >= 0 ? record[key] : 0;
}
