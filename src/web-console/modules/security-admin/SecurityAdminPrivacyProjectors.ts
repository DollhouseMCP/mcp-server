import type {
  SecurityAuthPolicyDto,
  SecuritySigningKeyDto,
  SecuritySigningKeyJobDto,
  SecuritySigningKeyKindDto,
  SecuritySigningKeyListDto,
  SecurityTotpResetDto,
} from './SecurityAdminDtos.js';
import {
  arrayValue,
  nullableStringField,
  numberField,
  objectValue,
  stringField,
  type UnknownRecord,
} from '../../platform/ConsoleProjectorHelpers.js';

export function projectSecuritySigningKeyList(value: unknown): SecuritySigningKeyListDto {
  const record = objectValue(value);
  return {
    kinds: arrayValue(record.kinds).map(projectSecuritySigningKeyKind),
  };
}

export function projectSecuritySigningKeyKind(value: unknown): SecuritySigningKeyKindDto {
  const record = objectValue(value);
  return {
    kind: signingKeyKindField(record, 'kind'),
    active_kid: nullableStringField(record, 'active_kid'),
    keys: arrayValue(record.keys).map(projectSecuritySigningKey),
  };
}

export function projectSecuritySigningKey(value: unknown): SecuritySigningKeyDto {
  const record = objectValue(value);
  return {
    kind: signingKeyKindField(record, 'kind'),
    kid: stringField(record, 'kid'),
    state: signingKeyStateField(record, 'state'),
    created_at: stringField(record, 'created_at'),
    rotated_at: nullableStringField(record, 'rotated_at'),
    retired_at: nullableStringField(record, 'retired_at'),
    deleted_at: nullableStringField(record, 'deleted_at'),
    verification_grace_ends_at: nullableStringField(record, 'verification_grace_ends_at'),
  };
}

export function projectSecuritySigningKeyJob(value: unknown): SecuritySigningKeyJobDto {
  const record = objectValue(value);
  return {
    id: stringField(record, 'id'),
    kind: signingKeyKindField(record, 'kind'),
    action: signingKeyJobActionField(record, 'action'),
    status: record.status === 'failed' ? 'failed' : 'completed',
    created_at: stringField(record, 'created_at'),
    completed_at: stringField(record, 'completed_at'),
    target_kid: nullableStringField(record, 'target_kid'),
    result_kid: nullableStringField(record, 'result_kid'),
    error_code: nullableStringField(record, 'error_code'),
  };
}

export function projectSecurityAuthPolicy(value: unknown): SecurityAuthPolicyDto {
  const record = objectValue(value);
  return {
    require_admin_totp: true,
    csrf_protection: true,
    bff_session_security: true,
    step_up_required: true,
    privacy_boundaries_enforced: true,
    max_admin_elevation_seconds: boundedElevationSeconds(record, 'max_admin_elevation_seconds'),
    updated_at: stringField(record, 'updated_at'),
    etag: stringField(record, 'etag'),
  };
}

export function projectSecurityTotpReset(value: unknown): SecurityTotpResetDto {
  const record = objectValue(value);
  const revocation = objectValue(record.elevation_revocation);
  return {
    user_id: stringField(record, 'user_id'),
    factor_disabled: record.factor_disabled === true,
    elevation_revocation: {
      event_id: nullableStringField(revocation, 'event_id'),
      status: revocation.status === 'queued' ? 'queued' : 'not_required',
    },
    reset_at: stringField(record, 'reset_at'),
  };
}

function signingKeyKindField(record: UnknownRecord, key: string): SecuritySigningKeyDto['kind'] {
  const value = record[key];
  if (value === 'jwks' || value === 'cookie' || value === 'invite') return value;
  return 'jwks';
}

function signingKeyStateField(record: UnknownRecord, key: string): SecuritySigningKeyDto['state'] {
  const value = record[key];
  if (value === 'active' || value === 'verifying' || value === 'retired' || value === 'deleted') return value;
  return 'retired';
}

function signingKeyJobActionField(record: UnknownRecord, key: string): SecuritySigningKeyJobDto['action'] {
  const value = record[key];
  if (value === 'rotate' || value === 'retire' || value === 'delete') return value;
  return 'rotate';
}

function boundedElevationSeconds(record: UnknownRecord, key: string): number {
  const value = numberField(record, key);
  if (value < 60) return 60;
  if (value > 300) return 300;
  return Math.trunc(value);
}
