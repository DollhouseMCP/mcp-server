import * as yaml from 'js-yaml';

import type { SessionContext } from '../../../context/SessionContext.js';
import type { ContextTracker } from '../../../security/encryption/ContextTracker.js';
import { SecureYamlParser } from '../../../security/secureYamlParser.js';
import type { SessionActivationRegistry } from '../../../state/SessionActivationState.js';
import {
  canonicalizePortfolioElementName,
  CONSOLE_PORTFOLIO_ELEMENT_TYPES,
  type ConsolePortfolioElementDetailRecord,
  type ConsolePortfolioElementType,
  type IPortfolioElementStore,
} from '../../stores/IPortfolioElementStore.js';
import type { IUserIntegrationStore, UserIntegrationRecord } from '../../stores/IUserIntegrationStore.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type { PortfolioSyncJobRecord } from '../../stores/IPortfolioSyncJobStore.js';
import { integrationSecretContext } from '../../modules/integrations/IntegrationSecretContext.js';
import {
  isBridgeOnlySessionActivationState,
  restoreSessionDbUserId,
} from '../../platform/ConsoleSessionActivationBridgeState.js';
import type {
  IPortfolioSyncJobExecutor,
  PortfolioSyncWorkerOutcome,
} from './ConsolePortfolioSyncWorker.js';

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_PORTFOLIO_REPOSITORY = 'dollhouse-portfolio';
const GITHUB_SECRET_PROVIDER = 'github';

export interface ConsolePortfolioSyncExecutorOptions {
  readonly integrationStore: IUserIntegrationStore;
  readonly portfolioStore: IPortfolioElementStore;
  readonly secretEncryption: ISecretEncryptionService;
  readonly repositoryName?: string;
  readonly contextTracker?: ContextTracker;
  readonly sessionActivationRegistry?: SessionActivationRegistry;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

interface GitHubContentFile {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly path?: unknown;
  readonly sha?: unknown;
  readonly content?: unknown;
}

interface SyncCounters {
  pulled: number;
  pushed: number;
  updated: number;
  skipped: number;
  conflicts: number;
}

export class ConsolePortfolioSyncExecutor implements IPortfolioSyncJobExecutor {
  private readonly repositoryName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: ConsolePortfolioSyncExecutorOptions) {
    this.repositoryName = options.repositoryName?.trim() || DEFAULT_PORTFOLIO_REPOSITORY;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async execute(job: PortfolioSyncJobRecord): Promise<PortfolioSyncWorkerOutcome> {
    if (this.options.contextTracker && this.options.sessionActivationRegistry) {
      return this.executeWithUserContext(job);
    }
    return this.executeInCurrentContext(job);
  }

  private async executeWithUserContext(job: PortfolioSyncJobRecord): Promise<PortfolioSyncWorkerOutcome> {
    const { contextTracker, sessionActivationRegistry: registry } = this.options;
    if (!contextTracker || !registry) {
      return this.executeInCurrentContext(job);
    }
    const sessionId = `web-console-sync:${job.id}`;
    const existingState = registry.get(sessionId);
    const state = existingState ?? registry.getOrCreate(sessionId);
    const previousDbUserId = state.dbUserId;
    state.dbUserId = job.userId;
    const session: SessionContext = {
      userId: job.userId,
      sessionId,
      tenantId: job.userId,
      transport: 'http',
      createdAt: Date.now(),
    };
    const context = contextTracker.createSessionContext('background-task', session, {
      jobId: job.id,
      provider: GITHUB_SECRET_PROVIDER,
    });
    try {
      return await contextTracker.runAsync(context, () => this.executeInCurrentContext(job));
    } finally {
      restoreSessionDbUserId(state, previousDbUserId);
      if (!existingState && isBridgeOnlySessionActivationState(state)) registry.dispose(sessionId);
    }
  }

  private async executeInCurrentContext(job: PortfolioSyncJobRecord): Promise<PortfolioSyncWorkerOutcome> {
    const integration = await this.options.integrationStore.findByProvider(job.userId, GITHUB_SECRET_PROVIDER);
    if (!isUsableIntegration(integration, job.integrationId)) {
      return failed('portfolio_sync_integration_unavailable', baseSummary(job, { provider_connected: false }));
    }
    const token = this.decryptAccessToken(integration);
    if (!token) {
      return failed('portfolio_sync_credential_unavailable', baseSummary(job, { credential_available: false }));
    }
    const client = new GitHubPortfolioContentsClient({
      token,
      owner: integration.externalAccountLabel ?? await this.resolveOwnerLogin(token),
      repository: this.repositoryName,
      fetchImpl: this.fetchImpl,
    });
    const counters = emptyCounters();
    try {
      if (job.direction === 'pull' || job.direction === 'bidirectional') {
        await this.pullFromGitHub(job, client, counters);
      }
      if (job.direction === 'push' || job.direction === 'bidirectional') {
        await this.pushToGitHub(job, client, counters);
      }
    } catch (error) {
      if (error instanceof PortfolioSyncConflictError) {
        return failed('portfolio_sync_conflict', summary(job, counters));
      }
      if (error instanceof GitHubPortfolioSyncApiError) {
        return failed(error.operationalErrorCode, summary(job, counters));
      }
      throw error;
    }
    return {
      status: 'succeeded',
      resultSummary: summary(job, counters),
    };
  }

  private async pullFromGitHub(
    job: PortfolioSyncJobRecord,
    client: GitHubPortfolioContentsClient,
    counters: SyncCounters,
  ): Promise<void> {
    for (const type of CONSOLE_PORTFOLIO_ELEMENT_TYPES) {
      const files = await client.listFiles(type);
      for (const file of files) {
        const parsed = await client.readElementFile(file);
        if (!parsed) continue;
        const existing = await this.options.portfolioStore.findByName(job.userId, type, parsed.canonicalName);
        if (existing) {
          await this.applyRemoteUpdate(job, type, existing, parsed, counters);
          continue;
        }
        await this.options.portfolioStore.create({
          userId: job.userId,
          type,
          name: parsed.name,
          displayName: parsed.displayName,
          metadata: parsed.metadata,
          content: parsed.content,
          tags: parsed.tags,
          now: this.now(),
        });
        counters.pulled += 1;
      }
    }
  }

  private async applyRemoteUpdate(
    job: PortfolioSyncJobRecord,
    type: ConsolePortfolioElementType,
    existing: ConsolePortfolioElementDetailRecord,
    parsed: ParsedRemoteElement,
    counters: SyncCounters,
  ): Promise<void> {
    if (sameElementContent(existing, parsed)) {
      counters.skipped += 1;
      return;
    }
    if (job.conflictPolicy === 'fail') {
      counters.conflicts += 1;
      throw new PortfolioSyncConflictError();
    }
    if (job.conflictPolicy === 'prefer_local') {
      counters.skipped += 1;
      return;
    }
    await this.options.portfolioStore.update({
      userId: job.userId,
      type,
      canonicalName: existing.canonicalName,
      expectedVersion: existing.version,
      expectedContentHash: existing.contentHash,
      displayName: parsed.displayName,
      metadata: parsed.metadata,
      content: parsed.content,
      tags: parsed.tags,
      now: this.now(),
    });
    counters.updated += 1;
  }

  private async pushToGitHub(
    job: PortfolioSyncJobRecord,
    client: GitHubPortfolioContentsClient,
    counters: SyncCounters,
  ): Promise<void> {
    const summaries = await this.options.portfolioStore.listByUser(job.userId);
    for (const local of summaries) {
      const detail = await this.options.portfolioStore.findByName(job.userId, local.type, local.canonicalName);
      if (!detail) continue;
      const path = elementPath(detail.type, detail.canonicalName);
      const remote = await client.getFile(path);
      const serialized = serializePortfolioElement(detail);
      if (remote?.content === serialized) {
        counters.skipped += 1;
        continue;
      }
      if (remote && job.conflictPolicy === 'fail') {
        counters.conflicts += 1;
        throw new PortfolioSyncConflictError();
      }
      if (remote && job.conflictPolicy === 'prefer_remote') {
        counters.skipped += 1;
        continue;
      }
      await client.putFile(path, serialized, commitMessage(detail), remote?.sha);
      counters.pushed += 1;
    }
  }

  private decryptAccessToken(integration: UserIntegrationRecord): string | null {
    if (!integration.accessTokenCiphertext) return null;
    try {
      return this.options.secretEncryption.decrypt(
        integration.accessTokenCiphertext,
        integrationSecretContext('access_token', integration.userId, GITHUB_SECRET_PROVIDER),
      ).toString('utf8');
    } catch {
      return null;
    }
  }

  private async resolveOwnerLogin(token: string): Promise<string> {
    const client = new GitHubPortfolioContentsClient({
      token,
      owner: '',
      repository: this.repositoryName,
      fetchImpl: this.fetchImpl,
    });
    return client.getAuthenticatedLogin();
  }
}

class GitHubPortfolioContentsClient {
  constructor(private readonly options: {
    readonly token: string;
    readonly owner: string;
    readonly repository: string;
    readonly fetchImpl: typeof fetch;
  }) {}

  async getAuthenticatedLogin(): Promise<string> {
    const response = await this.requestJson('/user');
    if (isRecord(response) && typeof response.login === 'string' && response.login.trim() !== '') {
      return response.login;
    }
    throw new GitHubPortfolioSyncApiError('portfolio_sync_provider_unavailable');
  }

  async listFiles(type: ConsolePortfolioElementType): Promise<readonly GitHubContentFile[]> {
    const response = await this.requestJson(this.contentsPath(type));
    if (response === null) return [];
    return Array.isArray(response)
      ? response.filter(isGitHubContentFile)
      : [];
  }

  async readElementFile(file: GitHubContentFile): Promise<ParsedRemoteElement | null> {
    if (typeof file.path !== 'string' || typeof file.name !== 'string') return null;
    if (!isSupportedElementFilename(file.name)) return null;
    const remote = await this.getFile(file.path);
    if (!remote) return null;
    return parseRemoteElement(file.name, remote.content);
  }

  async getFile(path: string): Promise<{ readonly content: string; readonly sha: string | null } | null> {
    const response = await this.requestJson(this.contentsPath(path));
    if (!isRecord(response) || typeof response.content !== 'string') return null;
    return {
      content: Buffer.from(response.content.replaceAll(/\s/g, ''), 'base64').toString('utf8'),
      sha: typeof response.sha === 'string' ? response.sha : null,
    };
  }

  async putFile(
    path: string,
    content: string,
    message: string,
    sha: string | null | undefined,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
    };
    if (sha) body.sha = sha;
    await this.requestJson(this.contentsPath(path), 'PUT', body);
  }

  private contentsPath(path: string): string {
    return `/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repository)}/contents/${
      path.split('/').map(segment => encodeURIComponent(segment)).join('/')
    }`;
  }

  private async requestJson(
    path: string,
    method = 'GET',
    body?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const response = await this.options.fetchImpl(`${GITHUB_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'DollhouseMCP-WebConsole/1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new GitHubPortfolioSyncApiError(mapGitHubStatusToCode(response.status));
    }
    if (response.status === 204) return null;
    return response.json();
  }
}

class PortfolioSyncConflictError extends Error {}

class GitHubPortfolioSyncApiError extends Error {
  constructor(readonly operationalErrorCode: string) {
    super(operationalErrorCode);
  }
}

interface ParsedRemoteElement {
  readonly name: string;
  readonly canonicalName: string;
  readonly displayName: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly content: string;
  readonly tags: readonly string[];
}

function isUsableIntegration(
  integration: UserIntegrationRecord | null,
  expectedIntegrationId: string,
): integration is UserIntegrationRecord {
  return integration?.status === 'connected' &&
    integration.id === expectedIntegrationId;
}

function parseRemoteElement(fileName: string, content: string): ParsedRemoteElement {
  const parsed = SecureYamlParser.parse(content, { validateFields: false });
  const metadata = sanitizeMetadata(parsed.data);
  const name = stripElementExtension(fileName);
  return {
    name,
    canonicalName: canonicalizePortfolioElementName(name),
    displayName: typeof metadata.name === 'string' ? metadata.name : null,
    metadata,
    content: parsed.content.trimStart(),
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [],
  };
}

function serializePortfolioElement(record: ConsolePortfolioElementDetailRecord): string {
  const metadata = {
    ...record.metadata,
    name: record.displayName ?? record.name,
    tags: record.tags,
  };
  return `---\n${yaml.dump(metadata, { lineWidth: -1, noRefs: true })}---\n\n${record.content}`;
}

function sanitizeMetadata(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function sameElementContent(existing: ConsolePortfolioElementDetailRecord, parsed: ParsedRemoteElement): boolean {
  return existing.content === parsed.content &&
    JSON.stringify(existing.metadata) === JSON.stringify(parsed.metadata) &&
    JSON.stringify(existing.tags) === JSON.stringify(parsed.tags);
}

function elementPath(type: ConsolePortfolioElementType, canonicalName: string): string {
  return `${type}/${canonicalName}${elementExtension(type)}`;
}

function elementExtension(type: ConsolePortfolioElementType): '.yaml' | '.md' {
  return type === 'memories' ? '.yaml' : '.md';
}

function isSupportedElementFilename(name: string): boolean {
  return /\.(md|ya?ml)$/iu.test(name);
}

function stripElementExtension(name: string): string {
  return name.replace(/\.(md|ya?ml)$/iu, '');
}

function commitMessage(record: ConsolePortfolioElementDetailRecord): string {
  return `Sync ${record.name} (${record.type})`;
}

function emptyCounters(): SyncCounters {
  return { pulled: 0, pushed: 0, updated: 0, skipped: 0, conflicts: 0 };
}

function summary(
  job: PortfolioSyncJobRecord,
  counters: SyncCounters,
): Readonly<Record<string, unknown>> {
  return baseSummary(job, {
    pulled: counters.pulled,
    pushed: counters.pushed,
    updated: counters.updated,
    skipped: counters.skipped,
    conflicts: counters.conflicts,
  });
}

function baseSummary(
  job: PortfolioSyncJobRecord,
  extra: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    provider: GITHUB_SECRET_PROVIDER,
    direction: job.direction,
    conflict_policy: job.conflictPolicy,
    ...extra,
  };
}

function failed(
  operationalErrorCode: string,
  resultSummary: Readonly<Record<string, unknown>>,
): PortfolioSyncWorkerOutcome {
  return {
    status: 'failed',
    operationalErrorCode,
    resultSummary,
  };
}

function mapGitHubStatusToCode(status: number): string {
  if (status === 401 || status === 403) return 'portfolio_sync_provider_auth_failed';
  if (status === 409 || status === 422) return 'portfolio_sync_provider_conflict';
  if (status === 429 || status >= 500) return 'portfolio_sync_provider_unavailable';
  return 'portfolio_sync_provider_failed';
}

function isGitHubContentFile(value: unknown): value is GitHubContentFile {
  return isRecord(value) && value.type === 'file';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
