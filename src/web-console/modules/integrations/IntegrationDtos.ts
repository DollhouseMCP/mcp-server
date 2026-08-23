import type {
  UserIntegrationErrorReason,
  UserIntegrationProvider,
  UserIntegrationRecord,
  UserIntegrationStatus,
} from '../../stores/IUserIntegrationStore.js';
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
  providers: readonly IntegrationProviderCatalogDescriptor[] = [{ id: 'github', displayName: 'GitHub', category: 'Source control' }],
): IntegrationListDto {
  return {
    integrations: providers.map(provider => serializeProviderStatus(
      provider.id,
      records.find(record => record.provider === provider.id) ?? null,
    )),
  };
}

function serializeProviderStatus(
  provider: UserIntegrationProvider,
  record: UserIntegrationRecord | null,
): IntegrationStatusDto {
  if (provider === 'github') {
    return serializeGitHubIntegrationStatus(record);
  }
  return serializeConfiguredIntegrationStatus({
    id: provider,
    displayName: provider,
    category: 'Integration',
  }, record);
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
