import {
  type SelfProfileDto,
  type SelfSettingsDto,
} from './SelfServiceDtos.js';

export function projectSelfProfile(value: unknown): SelfProfileDto {
  const input = asRecord(value);
  return {
    user_id: stringField(input, 'user_id'),
    primary_sub: nullableStringField(input, 'primary_sub'),
    username: stringField(input, 'username'),
    display_name: nullableStringField(input, 'display_name'),
    email: nullableStringField(input, 'email'),
    email_verified: booleanField(input, 'email_verified'),
    auth_methods: stringArrayField(input, 'auth_methods'),
    roles: stringArrayField(input, 'roles'),
    created_at: stringField(input, 'created_at'),
    last_login_at: nullableStringField(input, 'last_login_at'),
  };
}

export function projectSelfSettings(value: unknown): SelfSettingsDto {
  const input = asRecord(value);
  return {
    github_config: recordField(input, 'github_config'),
    sync_config: recordField(input, 'sync_config'),
    autoload_config: recordField(input, 'autoload_config'),
    retention_config: recordField(input, 'retention_config'),
    wizard_config: recordField(input, 'wizard_config'),
    display_config: recordField(input, 'display_config'),
    collection_config: recordField(input, 'collection_config'),
    auto_activate_config: recordField(input, 'auto_activate_config'),
    source_priority_config: recordField(input, 'source_priority_config'),
    user_identity_config: recordField(input, 'user_identity_config'),
    config_version: numberField(input, 'config_version'),
    updated_at: numberField(input, 'updated_at'),
    etag: stringField(input, 'etag'),
  };
}

export function projectSelfSetting(value: unknown): unknown {
  const input = asRecord(value);
  return {
    key: stringField(input, 'key'),
    value: input.value,
    updated_at: numberField(input, 'updated_at'),
    etag: stringField(input, 'etag'),
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string {
  return typeof record[key] === 'string' ? record[key] : '';
}

function nullableStringField(record: Readonly<Record<string, unknown>>, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] : null;
}

function booleanField(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return record[key] === true;
}

function numberField(record: Readonly<Record<string, unknown>>, key: string): number {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : 0;
}

function stringArrayField(record: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function recordField(record: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value as Record<string, unknown> } : {};
}
