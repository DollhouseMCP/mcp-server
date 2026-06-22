import type { SigningKeyKind } from '../../../storage/signingKeys/ISigningKeyStore.js';

export type SecuritySigningKeyState = 'active' | 'verifying' | 'retired' | 'deleted';
export type SecuritySigningKeyJobStatus = 'completed' | 'failed';

export interface SecuritySigningKeyDto {
  readonly kind: SigningKeyKind;
  readonly kid: string;
  readonly state: SecuritySigningKeyState;
  readonly created_at: string;
  readonly rotated_at: string | null;
  readonly retired_at: string | null;
  readonly deleted_at: string | null;
  readonly verification_grace_ends_at: string | null;
}

export interface SecuritySigningKeyListDto {
  readonly kinds: readonly {
    readonly kind: SigningKeyKind;
    readonly active_kid: string | null;
    readonly keys: readonly SecuritySigningKeyDto[];
  }[];
}

export interface SecuritySigningKeyKindDto {
  readonly kind: SigningKeyKind;
  readonly active_kid: string | null;
  readonly keys: readonly SecuritySigningKeyDto[];
}

export interface SecuritySigningKeyJobDto {
  readonly id: string;
  readonly kind: SigningKeyKind;
  readonly action: 'rotate' | 'retire' | 'delete';
  readonly status: SecuritySigningKeyJobStatus;
  readonly created_at: string;
  readonly completed_at: string;
  readonly target_kid: string | null;
  readonly result_kid: string | null;
  readonly error_code: string | null;
}

export interface SecurityAuthPolicyDto {
  readonly require_admin_totp: true;
  readonly csrf_protection: true;
  readonly bff_session_security: true;
  readonly step_up_required: true;
  readonly privacy_boundaries_enforced: true;
  readonly max_admin_elevation_seconds: number;
  readonly updated_at: string;
  readonly etag: string;
}

export interface SecurityTotpResetDto {
  readonly user_id: string;
  readonly factor_disabled: boolean;
  readonly elevation_revocation: {
    readonly event_id: string | null;
    readonly status: 'queued' | 'not_required';
  };
  readonly reset_at: string;
}
