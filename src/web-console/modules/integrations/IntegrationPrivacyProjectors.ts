import {
  type GitHubIntegrationStatusDto,
  type IntegrationListDto,
  type IntegrationStatusDtoStatus,
  type PortfolioSyncDirection,
} from './IntegrationDtos.js';

export function projectIntegrationList(value: unknown): IntegrationListDto {
  const input = asRecord(value);
  const integrations = Array.isArray(input.integrations)
    ? input.integrations.map(projectGitHubIntegrationStatus)
    : [];
  return { integrations };
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
    connected_at: nullableStringField(input, 'connected_at'),
    last_sync_at: nullableStringField(input, 'last_sync_at'),
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nullableStringField(record: Readonly<Record<string, unknown>>, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] : null;
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
