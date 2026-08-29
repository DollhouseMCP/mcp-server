import type {
  UserIntegrationErrorReason,
  UserIntegrationProvider,
  UserIntegrationRecord,
  UserIntegrationStatus,
} from '../../stores/IUserIntegrationStore.js';
import type { IntegrationOperationSummary } from './IntegrationOperationCatalog.js';
import type {
  IntegrationAuthStrategy,
  IntegrationDescriptorOwnership,
  IntegrationDescriptorRecord,
  IntegrationPkceMode,
  IntegrationRefreshMode,
} from '../../stores/IIntegrationDescriptorStore.js';
import type { IntegrationProviderCatalogDescriptor } from './IntegrationProvider.js';

export type GitHubRepositorySelection = 'selected' | 'all' | 'unknown';
export type GitHubContentsPermission = 'none' | 'read' | 'write';
export type IntegrationStatusDtoStatus = UserIntegrationStatus | 'disconnected';
export type PortfolioSyncDirection = 'pull' | 'push' | 'bidirectional';

export interface GitHubIntegrationStatusDto {
  readonly provider: 'github';
  readonly status: IntegrationStatusDtoStatus;
  readonly account_label: string | null;
  readonly repository_selection: GitHubRepositorySelection;
  readonly permissions: {
    readonly contents: GitHubContentsPermission;
  };
  readonly sync_directions: readonly PortfolioSyncDirection[];
  readonly error_reason: UserIntegrationErrorReason | null;
  readonly connected_at: string | null;
  readonly last_sync_at: string | null;
}

export interface ConfiguredIntegrationStatusDto {
  readonly provider: UserIntegrationProvider;
  readonly display_name: string;
  readonly category: string;
  readonly status: IntegrationStatusDtoStatus;
  readonly account_label: string | null;
  readonly scopes: readonly string[];
  readonly error_reason: UserIntegrationErrorReason | null;
  readonly connected_at: string | null;
  readonly last_sync_at: string | null;
}

export type IntegrationStatusDto = GitHubIntegrationStatusDto | ConfiguredIntegrationStatusDto;

export interface IntegrationListDto {
  readonly integrations: readonly IntegrationStatusDto[];
}

export function serializeIntegrationList(
  records: readonly UserIntegrationRecord[],
  providers: readonly IntegrationProviderCatalogDescriptor[] = [{ id: 'github' as UserIntegrationProvider, displayName: 'GitHub', category: 'Source control' }],
): IntegrationListDto {
  return {
    integrations: providers.map(provider => serializeProviderStatus(
      provider,
      records.find(record => record.provider === provider.id) ?? null,
    )),
  };
}

function serializeProviderStatus(
  provider: IntegrationProviderCatalogDescriptor,
  record: UserIntegrationRecord | null,
): IntegrationStatusDto {
  if (provider.id === 'github') {
    return serializeGitHubIntegrationStatus(record);
  }
  return serializeConfiguredIntegrationStatus(provider, record);
}

export function serializeGitHubIntegrationStatus(record: UserIntegrationRecord | null): GitHubIntegrationStatusDto {
  if (!record) {
    return disconnectedGitHubStatus();
  }
  const permissions = normalizeGitHubPermissions(record.authorizedPermissions);
  return {
    provider: 'github',
    status: record.status,
    account_label: record.externalAccountLabel,
    repository_selection: permissions.repositorySelection,
    permissions: {
      contents: permissions.contents,
    },
    sync_directions: syncDirectionsForContents(permissions.contents),
    error_reason: record.errorReason,
    connected_at: record.connectedAt?.toISOString() ?? null,
    last_sync_at: record.lastSyncAt?.toISOString() ?? null,
  };
}

function disconnectedGitHubStatus(): GitHubIntegrationStatusDto {
  return {
    provider: 'github',
    status: 'disconnected',
    account_label: null,
    repository_selection: 'unknown',
    permissions: {
      contents: 'none',
    },
    sync_directions: [],
    error_reason: null,
    connected_at: null,
    last_sync_at: null,
  };
}

export function serializeConfiguredIntegrationStatus(
  descriptor: IntegrationProviderCatalogDescriptor,
  record: UserIntegrationRecord | null,
): ConfiguredIntegrationStatusDto {
  const scopes = normalizeScopes(record?.authorizedPermissions);
  return {
    provider: descriptor.id,
    display_name: descriptor.displayName,
    category: descriptor.category,
    status: record?.status ?? 'disconnected',
    account_label: record?.externalAccountLabel ?? null,
    scopes,
    error_reason: record?.errorReason ?? null,
    connected_at: record?.connectedAt?.toISOString() ?? null,
    last_sync_at: record?.lastSyncAt?.toISOString() ?? null,
  };
}

function normalizeGitHubPermissions(
  value: Readonly<Record<string, unknown>>,
): { readonly repositorySelection: GitHubRepositorySelection; readonly contents: GitHubContentsPermission } {
  const repositorySelection = normalizeRepositorySelection(value.repository_selection ?? value.repositorySelection);
  const contents = normalizeContentsPermission(value.contents ?? permissionsRecord(value).contents);
  return { repositorySelection, contents };
}

function permissionsRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return value.permissions && typeof value.permissions === 'object' && !Array.isArray(value.permissions)
    ? value.permissions as Record<string, unknown>
    : {};
}

function normalizeRepositorySelection(value: unknown): GitHubRepositorySelection {
  if (value === 'selected' || value === 'all') return value;
  return 'unknown';
}

function normalizeContentsPermission(value: unknown): GitHubContentsPermission {
  if (value === 'read' || value === 'write') return value;
  return 'none';
}

function syncDirectionsForContents(contents: GitHubContentsPermission): readonly PortfolioSyncDirection[] {
  if (contents === 'write') return ['pull', 'push', 'bidirectional'];
  if (contents === 'read') return ['pull'];
  return [];
}

function normalizeScopes(value: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  const scopes = value?.scopes;
  if (!Array.isArray(scopes)) return [];
  return scopes.filter((scope): scope is string => typeof scope === 'string');
}

/**
 * Display-safe descriptor DTO (allowlist). Credential material —
 * clientSecretCiphertext, clientSecretRevision, credentialKeyVersion, or any plaintext secret —
 * must never appear here; the browser only learns whether a secret is stored.
 */
export interface IntegrationDescriptorDto {
  readonly id: string;
  readonly provider: UserIntegrationProvider;
  readonly ownership: IntegrationDescriptorOwnership;
  readonly display_name: string;
  readonly category: string;
  readonly auth_strategy: IntegrationAuthStrategy;
  readonly api_hosts: readonly string[];
  readonly oauth: IntegrationDescriptorOAuthDto | null;
  readonly static_api_key: IntegrationDescriptorStaticApiKeyDto | null;
  readonly has_client_secret: boolean;
  readonly operation_promotion: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface IntegrationDescriptorOAuthDto {
  readonly client_id: string | null;
  readonly authorization_url: string;
  readonly token_url: string;
  readonly scopes: readonly string[];
  readonly pkce: IntegrationPkceMode;
  readonly refresh: IntegrationRefreshMode;
  readonly token_exchange: Readonly<Record<string, unknown>>;
  readonly account_label: Readonly<Record<string, unknown>>;
}

export interface IntegrationDescriptorStaticApiKeyDto {
  readonly injection: {
    readonly location: 'header' | 'query' | 'basic';
    readonly name: string;
    readonly value_prefix: string | null;
  };
}

export interface IntegrationDescriptorListDto {
  readonly descriptors: readonly IntegrationDescriptorDto[];
  readonly next_cursor: string | null;
}

export function serializeIntegrationDescriptor(record: IntegrationDescriptorRecord): IntegrationDescriptorDto {
  return {
    id: record.id,
    provider: record.provider,
    ownership: record.ownership,
    display_name: record.displayName,
    category: record.category,
    auth_strategy: record.authStrategy,
    api_hosts: [...record.apiHosts],
    oauth: record.oauth
      ? {
        client_id: record.oauth.clientId,
        authorization_url: record.oauth.authorizationUrl,
        token_url: record.oauth.tokenUrl,
        scopes: [...record.oauth.scopes],
        pkce: record.oauth.pkce,
        refresh: record.oauth.refresh,
        token_exchange: record.oauth.tokenExchange,
        account_label: record.oauth.accountLabel,
      }
      : null,
    static_api_key: record.staticApiKey
      ? {
        injection: {
          location: record.staticApiKey.injection.location,
          name: record.staticApiKey.injection.name,
          value_prefix: record.staticApiKey.injection.valuePrefix,
        },
      }
      : null,
    has_client_secret: record.clientSecretCiphertext !== null,
    operation_promotion: record.operationPromotion,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

export function serializeIntegrationDescriptorList(
  records: readonly IntegrationDescriptorRecord[],
  nextCursor: string | null,
): IntegrationDescriptorListDto {
  return {
    descriptors: records.map(serializeIntegrationDescriptor),
    next_cursor: nextCursor,
  };
}

/**
 * Spec metadata only — the stored spec body stays server-side data queried
 * through the operation-discovery tools, not a browser payload.
 */
export interface IntegrationOpenApiSpecMetadataDto {
  readonly descriptor_id: string;
  readonly provider: UserIntegrationProvider;
  readonly spec_hash: string;
  readonly source_url: string | null;
  readonly operation_count: number;
  readonly spec_bytes: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export function serializeIntegrationOpenApiSpecMetadata(input: {
  readonly descriptorId: string;
  readonly provider: UserIntegrationProvider;
  readonly specHash: string;
  readonly sourceUrl: string | null;
  readonly operationCount: number;
  readonly spec: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): IntegrationOpenApiSpecMetadataDto {
  return {
    descriptor_id: input.descriptorId,
    provider: input.provider,
    spec_hash: input.specHash,
    source_url: input.sourceUrl,
    operation_count: input.operationCount,
    spec_bytes: Buffer.byteLength(JSON.stringify(input.spec), 'utf8'),
    created_at: input.createdAt.toISOString(),
    updated_at: input.updatedAt.toISOString(),
  };
}

export interface IntegrationSpecOperationDto {
  readonly operation_id: string;
  readonly method: string;
  readonly path: string;
  readonly read_write_class: 'read' | 'write';
  readonly summary: string | null;
  readonly description: string | null;
  readonly required_scopes: readonly string[];
}

/** The operations a BYO descriptor's uploaded spec exposes (scope-independent). */
export interface IntegrationSpecOperationsDto {
  readonly descriptor_id: string;
  readonly spec_hash: string;
  readonly operations: readonly IntegrationSpecOperationDto[];
}

export function serializeIntegrationSpecOperations(input: {
  readonly descriptorId: string;
  readonly specHash: string;
  readonly operations: readonly IntegrationOperationSummary[];
}): IntegrationSpecOperationsDto {
  return {
    descriptor_id: input.descriptorId,
    spec_hash: input.specHash,
    operations: input.operations.map(op => ({
      operation_id: op.operationId,
      method: op.method,
      path: op.path,
      read_write_class: op.readWriteClass,
      summary: op.summary,
      description: op.description,
      required_scopes: [...op.requiredScopes],
    })),
  };
}
