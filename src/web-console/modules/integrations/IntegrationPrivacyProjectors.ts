import {
  type ConfiguredIntegrationStatusDto,
  type GitHubIntegrationStatusDto,
  type IntegrationDescriptorDto,
  type IntegrationDescriptorListDto,
  type IntegrationDescriptorOAuthDto,
  type IntegrationDescriptorStaticApiKeyDto,
  type IntegrationListDto,
  type IntegrationOpenApiSpecMetadataDto,
  type IntegrationSpecOperationDto,
  type IntegrationSpecOperationsDto,
  type IntegrationStatusDto,
  type IntegrationStatusDtoStatus,
  type PortfolioSyncDirection,
} from './IntegrationDtos.js';
import type { UserIntegrationProvider } from '../../stores/IUserIntegrationStore.js';
import type {
  IntegrationAuthStrategy,
  IntegrationDescriptorOwnership,
  IntegrationPkceMode,
  IntegrationRefreshMode,
} from '../../stores/IIntegrationDescriptorStore.js';

export function projectIntegrationList(value: unknown): IntegrationListDto {
  const input = asRecord(value);
  const integrations = Array.isArray(input.integrations)
    ? input.integrations.map(projectIntegrationStatus)
    : [];
  return { integrations };
}

export function projectIntegrationConnect(value: unknown): { readonly authorize_url: string } {
  const input = asRecord(value);
  return { authorize_url: typeof input.authorize_url === 'string' ? input.authorize_url : '' };
}

/**
 * Connect projection for parameterized provider routes, where the strategy is
 * unknown until the descriptor resolves per-request: an OAuth connect returns
 * `authorize_url`, a static-key connect returns the provider status DTO.
 */
export function projectIntegrationConnectOrStatus(
  value: unknown,
): { readonly authorize_url: string } | ConfiguredIntegrationStatusDto {
  const input = asRecord(value);
  return typeof input.authorize_url === 'string'
    ? projectIntegrationConnect(input)
    : projectConfiguredIntegrationStatus(input);
}

export function projectGitHubIntegrationStatus(value: unknown): GitHubIntegrationStatusDto {
  const input = asRecord(value);
  return {
    provider: 'github',
    status: integrationStatus(input.status),
    account_label: nullableStringField(input, 'account_label'),
    repository_selection: repositorySelection(input.repository_selection),
    permissions: {
      contents: contentsPermission(asRecord(input.permissions).contents),
    },
    sync_directions: syncDirections(input.sync_directions),
    error_reason: errorReason(input.error_reason),
    connected_at: nullableStringField(input, 'connected_at'),
    last_sync_at: nullableStringField(input, 'last_sync_at'),
  };
}

export function projectConfiguredIntegrationStatus(value: unknown): ConfiguredIntegrationStatusDto {
  const input = asRecord(value);
  return {
    provider: stringField(input, 'provider') as UserIntegrationProvider,
    display_name: stringField(input, 'display_name'),
    category: stringField(input, 'category'),
    status: integrationStatus(input.status),
    account_label: nullableStringField(input, 'account_label'),
    scopes: stringArray(input.scopes),
    error_reason: errorReason(input.error_reason),
    connected_at: nullableStringField(input, 'connected_at'),
    last_sync_at: nullableStringField(input, 'last_sync_at'),
  };
}

/**
 * Allowlist projection for descriptor DTOs. Rebuilds every field explicitly
 * so a serializer regression can never leak clientSecretCiphertext,
 * clientSecretRevision, credentialKeyVersion, or any other non-allowlisted
 * property to the browser.
 */
export function projectIntegrationDescriptor(value: unknown): IntegrationDescriptorDto {
  const input = asRecord(value);
  return {
    id: stringField(input, 'id'),
    provider: stringField(input, 'provider') as UserIntegrationProvider,
    ownership: descriptorOwnership(input.ownership),
    display_name: stringField(input, 'display_name'),
    category: stringField(input, 'category'),
    auth_strategy: descriptorAuthStrategy(input.auth_strategy),
    api_hosts: stringArray(input.api_hosts),
    oauth: projectDescriptorOAuth(input.oauth),
    static_api_key: projectDescriptorStaticApiKey(input.static_api_key),
    has_client_secret: input.has_client_secret === true,
    operation_promotion: asRecord(input.operation_promotion),
    created_at: stringField(input, 'created_at'),
    updated_at: stringField(input, 'updated_at'),
  };
}

export function projectIntegrationDescriptorList(value: unknown): IntegrationDescriptorListDto {
  const input = asRecord(value);
  return {
    descriptors: Array.isArray(input.descriptors)
      ? input.descriptors.map(projectIntegrationDescriptor)
      : [],
    next_cursor: nullableStringField(input, 'next_cursor'),
  };
}

export function projectIntegrationOpenApiSpecMetadata(value: unknown): IntegrationOpenApiSpecMetadataDto {
  const input = asRecord(value);
  return {
    descriptor_id: stringField(input, 'descriptor_id'),
    provider: stringField(input, 'provider') as UserIntegrationProvider,
    spec_hash: stringField(input, 'spec_hash'),
    source_url: nullableStringField(input, 'source_url'),
    operation_count: numberField(input, 'operation_count'),
    spec_bytes: numberField(input, 'spec_bytes'),
    created_at: stringField(input, 'created_at'),
    updated_at: stringField(input, 'updated_at'),
  };
}

export function projectIntegrationSpecOperations(value: unknown): IntegrationSpecOperationsDto {
  const input = asRecord(value);
  const operations = Array.isArray(input.operations) ? input.operations : [];
  return {
    descriptor_id: stringField(input, 'descriptor_id'),
    spec_hash: stringField(input, 'spec_hash'),
    operations: operations.map(projectSpecOperation),
  };
}

function projectSpecOperation(value: unknown): IntegrationSpecOperationDto {
  const op = asRecord(value);
  return {
    operation_id: stringField(op, 'operation_id'),
    method: stringField(op, 'method'),
    path: stringField(op, 'path'),
    read_write_class: stringField(op, 'read_write_class') === 'write' ? 'write' : 'read',
    summary: nullableStringField(op, 'summary'),
    description: nullableStringField(op, 'description'),
    required_scopes: stringArray(op.required_scopes),
  };
}

function numberField(record: Readonly<Record<string, unknown>>, key: string): number {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : 0;
}

function projectDescriptorOAuth(value: unknown): IntegrationDescriptorOAuthDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return {
    client_id: stringField(input, 'client_id'),
    authorization_url: stringField(input, 'authorization_url'),
    token_url: stringField(input, 'token_url'),
    scopes: stringArray(input.scopes),
    pkce: descriptorPkce(input.pkce),
    refresh: descriptorRefresh(input.refresh),
    token_exchange: asRecord(input.token_exchange),
    account_label: asRecord(input.account_label),
  };
}

function projectDescriptorStaticApiKey(value: unknown): IntegrationDescriptorStaticApiKeyDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const injection = asRecord((value as Record<string, unknown>).injection);
  return {
    injection: {
      location: injectionLocation(injection.location),
      name: stringField(injection, 'name'),
      value_prefix: nullableStringField(injection, 'value_prefix'),
    },
  };
}

function injectionLocation(value: unknown): 'header' | 'query' | 'basic' {
  if (value === 'query' || value === 'basic') return value;
  return 'header';
}

function descriptorOwnership(value: unknown): IntegrationDescriptorOwnership {
  return value === 'curated' ? 'curated' : 'byo';
}

function descriptorAuthStrategy(value: unknown): IntegrationAuthStrategy {
  if (value === 'oauth2_authorization_code' || value === 'static_api_key' || value === 'coded') return value;
  return 'coded';
}

function descriptorPkce(value: unknown): IntegrationPkceMode {
  if (value === 'required' || value === 'supported' || value === 'unsupported') return value;
  return 'unsupported';
}

function descriptorRefresh(value: unknown): IntegrationRefreshMode {
  if (value === 'none' || value === 'static' || value === 'rotating') return value;
  return 'none';
}

function projectIntegrationStatus(value: unknown): IntegrationStatusDto {
  const input = asRecord(value);
  return input.provider === 'github'
    ? projectGitHubIntegrationStatus(input)
    : projectConfiguredIntegrationStatus(input);
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

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function integrationStatus(value: unknown): IntegrationStatusDtoStatus {
  if (value === 'connected' || value === 'revoked' || value === 'error' || value === 'disconnected') return value;
  return 'disconnected';
}

function repositorySelection(value: unknown): 'selected' | 'all' | 'unknown' {
  if (value === 'selected' || value === 'all') return value;
  return 'unknown';
}

function contentsPermission(value: unknown): 'none' | 'read' | 'write' {
  if (value === 'read' || value === 'write') return value;
  return 'none';
}

function syncDirections(value: unknown): readonly PortfolioSyncDirection[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PortfolioSyncDirection =>
    item === 'pull' || item === 'push' || item === 'bidirectional');
}

function errorReason(value: unknown): GitHubIntegrationStatusDto['error_reason'] {
  if (value === 'token_exchange_failed' ||
      value === 'revocation_failed' ||
      value === 'scope_denied' ||
      value === 'provider_unavailable') {
    return value;
  }
  return null;
}
