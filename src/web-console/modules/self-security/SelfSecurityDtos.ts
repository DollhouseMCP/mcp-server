import type { ConsoleFactorStatus } from '../../stores/IConsoleFactorStore.js';

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
