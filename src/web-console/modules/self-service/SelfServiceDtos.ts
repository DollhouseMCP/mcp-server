import { createHash } from 'node:crypto';

import type { UserConfig } from '../../../storage/userConfig/IUserConfigStore.js';
import type { ConsolePrincipalSummary } from '../../stores/IConsoleAccountAdminStore.js';

export interface SelfProfileDto {
  readonly user_id: string;
  readonly primary_sub: string | null;
  readonly username: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly email_verified: boolean;
  readonly auth_methods: readonly string[];
  readonly roles: readonly string[];
  readonly created_at: string;
  readonly last_login_at: string | null;
}

export interface SelfSettingsDto {
  readonly github_config: Readonly<Record<string, unknown>>;
  readonly sync_config: Readonly<Record<string, unknown>>;
  readonly autoload_config: Readonly<Record<string, unknown>>;
  readonly retention_config: Readonly<Record<string, unknown>>;
  readonly wizard_config: Readonly<Record<string, unknown>>;
  readonly display_config: Readonly<Record<string, unknown>>;
  readonly collection_config: Readonly<Record<string, unknown>>;
  readonly auto_activate_config: Readonly<Record<string, unknown>>;
  readonly source_priority_config: Readonly<Record<string, unknown>>;
  readonly user_identity_config: Readonly<Record<string, unknown>>;
  readonly config_version: number;
  readonly updated_at: number;
  readonly etag: string;
}

export function serializeSelfProfile(principal: ConsolePrincipalSummary): SelfProfileDto {
  return {
    user_id: principal.userId,
    primary_sub: principal.primarySub,
    username: principal.username,
    display_name: principal.displayName,
    email: principal.email,
    email_verified: principal.emailVerified,
    auth_methods: [...principal.authMethods],
    roles: [...principal.roles],
    created_at: principal.createdAt.toISOString(),
    last_login_at: principal.lastLoginAt?.toISOString() ?? null,
  };
}

export function serializeSelfSettings(userId: string, config: UserConfig): SelfSettingsDto {
  return {
    github_config: cloneRecord(config.githubConfig),
    sync_config: cloneRecord(config.syncConfig),
    autoload_config: cloneRecord(config.autoloadConfig),
    retention_config: cloneRecord(config.retentionConfig),
    wizard_config: cloneRecord(config.wizardConfig),
    display_config: cloneRecord(config.displayConfig),
    collection_config: cloneRecord(config.collectionConfig),
    auto_activate_config: cloneRecord(config.autoActivateConfig),
    source_priority_config: cloneRecord(config.sourcePriorityConfig),
    user_identity_config: cloneRecord(config.userIdentityConfig),
    config_version: config.configVersion,
    updated_at: config.updatedAt,
    etag: settingsEtag(userId, config),
  };
}

export function settingsEtag(userId: string, config: UserConfig): string {
  const hash = createHash('sha256')
    .update(userId)
    .update('\0')
    .update(canonicalJson(settingsEtagPayload(config)))
    .digest('base64url');
  return `W/"user-settings-${hash}"`;
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...value };
}

function settingsEtagPayload(config: UserConfig): unknown {
  return {
    githubConfig: config.githubConfig,
    syncConfig: config.syncConfig,
    autoloadConfig: config.autoloadConfig,
    retentionConfig: config.retentionConfig,
    wizardConfig: config.wizardConfig,
    displayConfig: config.displayConfig,
    collectionConfig: config.collectionConfig,
    autoActivateConfig: config.autoActivateConfig,
    sourcePriorityConfig: config.sourcePriorityConfig,
    userIdentityConfig: config.userIdentityConfig,
    configVersion: config.configVersion,
    updatedAt: config.updatedAt,
  };
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record).sort(compareKeys).map(key => {
    const serializedKey = JSON.stringify(key);
    return `${serializedKey}:${canonicalJson(record[key])}`;
  });
  return `{${entries.join(',')}}`;
}
