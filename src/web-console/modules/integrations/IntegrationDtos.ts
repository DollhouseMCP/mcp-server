import type {
  UserIntegrationErrorReason,
  UserIntegrationRecord,
  UserIntegrationStatus,
} from '../../stores/IUserIntegrationStore.js';

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

export interface IntegrationListDto {
  readonly integrations: readonly GitHubIntegrationStatusDto[];
}

export function serializeIntegrationList(records: readonly UserIntegrationRecord[]): IntegrationListDto {
  return {
    integrations: [serializeGitHubIntegrationStatus(records[0] ?? null)],
  };
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
