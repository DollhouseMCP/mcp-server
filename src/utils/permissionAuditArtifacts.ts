import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { FileLockManager } from '../security/fileLockManager.js';
import { logger } from './logger.js';

export type PermissionAuditArtifactDestinationType = 'localFile' | string;

export interface PermissionAuditDecisionDetail {
  label: string;
  value: string;
}

export interface PermissionAuditDecision {
  id: string;
  timestamp: string;
  tool_name: string;
  command?: string;
  decision: string;
  reason?: string;
  platform?: string;
  target?: string;
  targetLabel?: string;
  details?: PermissionAuditDecisionDetail[];
}

export interface PermissionAuditArtifactDestination {
  type: PermissionAuditArtifactDestinationType;
  path?: string;
}

export interface PermissionAuditArtifactConfig {
  enabled: boolean;
  destination: PermissionAuditArtifactDestination;
}

export interface PermissionAuditArtifactStatus extends PermissionAuditArtifactConfig {
  available: boolean;
  lastWriteAt?: string;
  lastDecisionId?: string;
  lastError?: string;
}

export interface PermissionAuditArtifactEnvironment extends NodeJS.ProcessEnv {
  DOLLHOUSE_PERMISSION_AUDIT_FILE_ENABLED?: string;
  DOLLHOUSE_PERMISSION_AUDIT_DESTINATION_TYPE?: string;
  DOLLHOUSE_PERMISSION_AUDIT_FILE_PATH?: string;
}

const DEFAULT_AUDIT_FILENAME = 'permission-audit.md';
const LOCAL_FILE_DESTINATION = 'localFile';
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

export function loadPermissionAuditArtifactConfig(
  homeDir = homedir(),
  env: PermissionAuditArtifactEnvironment = process.env,
): PermissionAuditArtifactConfig {
  const enabled = parseBoolean(env.DOLLHOUSE_PERMISSION_AUDIT_FILE_ENABLED, false);
  const destinationType = normalizeDestinationType(env.DOLLHOUSE_PERMISSION_AUDIT_DESTINATION_TYPE);
  const configuredPath = env.DOLLHOUSE_PERMISSION_AUDIT_FILE_PATH;

  return {
    enabled,
    destination: {
      type: destinationType,
      ...(destinationType === LOCAL_FILE_DESTINATION
        ? { path: resolveAuditFilePath(configuredPath, homeDir) }
        : {}),
    },
  };
}

export function renderPermissionAuditMarkdown(
  decisions: PermissionAuditDecision[],
  generatedAt = new Date().toISOString(),
): string {
  const lines: string[] = [
    '# DollhouseMCP Permissions Audit',
    '',
    `Generated: ${sanitizeMarkdownValue(generatedAt)}`,
    `Entries: ${decisions.length}`,
    '',
  ];

  if (decisions.length === 0) {
    lines.push('No permission decisions have been captured yet.', '');
    return lines.join('\n');
  }

  decisions.forEach((decision, index) => {
    lines.push(
      `## ${index + 1}. ${sanitizeMarkdownValue(decision.tool_name)}`,
      '',
      `- Decision: ${sanitizeMarkdownValue(decision.decision.toUpperCase())}`,
      `- Time: ${sanitizeMarkdownValue(decision.timestamp)}`,
    );

    if (decision.reason) {
      lines.push(`- Reason: ${sanitizeMarkdownValue(decision.reason)}`);
    }

    if (decision.targetLabel && decision.target) {
      lines.push(`- ${sanitizeMarkdownValue(decision.targetLabel)}: ${sanitizeMarkdownValue(decision.target)}`);
    }

    if (decision.command) {
      lines.push(`- Command: ${sanitizeMarkdownValue(decision.command)}`);
    }

    const details = Array.isArray(decision.details) ? decision.details : [];
    if (details.length > 0) {
      lines.push('', '### Details');
      for (const detail of details) {
        lines.push(`- ${sanitizeMarkdownValue(detail.label)}: ${sanitizeMarkdownValue(detail.value)}`);
      }
    }

    lines.push('');
  });

  return lines.join('\n');
}

export class PermissionAuditArtifactWriter {
  private status: PermissionAuditArtifactStatus;
  private readonly fileLockManager = new FileLockManager();
  private readonly configError: string | undefined;

  constructor(config: PermissionAuditArtifactConfig) {
    this.configError = this.getConfigError(config);
    this.status = {
      ...config,
      available: config.enabled && !this.configError,
      ...(this.configError ? { lastError: this.configError } : {}),
    };
  }

  getStatus(): PermissionAuditArtifactStatus {
    return { ...this.status, destination: { ...this.status.destination } };
  }

  async write(decisions: PermissionAuditDecision[]): Promise<void> {
    if (!this.status.enabled) {
      return;
    }

    if (this.configError) {
      return;
    }

    if (this.status.destination.type !== LOCAL_FILE_DESTINATION || !this.status.destination.path) {
      this.recordError(`Unsupported permission audit destination type: ${this.status.destination.type}`);
      return;
    }

    try {
      validateLocalAuditFilePath(this.status.destination.path);
      await mkdir(path.dirname(this.status.destination.path), { recursive: true });
      await this.fileLockManager.atomicWriteFile(
        this.status.destination.path,
        renderPermissionAuditMarkdown(decisions),
        { encoding: 'utf-8' },
      );
      this.status = {
        ...this.status,
        available: true,
        lastWriteAt: new Date().toISOString(),
        lastDecisionId: decisions[0]?.id,
        lastError: undefined,
      };
    } catch (err) {
      this.recordError(err instanceof Error ? err.message : String(err));
    }
  }

  private getConfigError(config: PermissionAuditArtifactConfig): string | undefined {
    if (!config.enabled) {
      return undefined;
    }

    if (config.destination.type !== LOCAL_FILE_DESTINATION) {
      return `Unsupported permission audit destination type: ${config.destination.type}`;
    }

    if (!config.destination.path) {
      return 'Permission audit local file path is required';
    }

    try {
      validateLocalAuditFilePath(config.destination.path);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private recordError(error: string): void {
    this.status = {
      ...this.status,
      available: false,
      lastError: error,
    };
    logger.warn('[PermissionAuditArtifact] Could not write permission audit artifact', {
      destinationType: this.status.destination.type,
      path: this.status.destination.path,
      error,
    });
  }
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function normalizeDestinationType(value: string | undefined): PermissionAuditArtifactDestinationType {
  if (value === undefined || value.trim() === '') {
    return LOCAL_FILE_DESTINATION;
  }

  return value.trim();
}

function resolveAuditFilePath(configuredPath: string | undefined, homeDir: string): string {
  const rawPath = configuredPath && configuredPath.trim() !== ''
    ? configuredPath.trim()
    : path.join(homeDir, '.dollhouse', 'audit', DEFAULT_AUDIT_FILENAME);
  const expanded = rawPath === '~'
    ? homeDir
    : rawPath.startsWith(`~${path.sep}`)
      ? path.join(homeDir, rawPath.slice(2))
      : rawPath;

  return path.resolve(expanded);
}

function validateLocalAuditFilePath(filePath: string): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error('Permission audit local file path must be absolute');
  }

  if (filePath.includes('\0')) {
    throw new Error('Permission audit local file path cannot contain null bytes');
  }

  const extension = path.extname(filePath).toLowerCase();
  if (!MARKDOWN_EXTENSIONS.has(extension)) {
    throw new Error('Permission audit local file path must use .md or .markdown');
  }
}

function sanitizeMarkdownValue(value: string): string {
  return value.normalize('NFC').replace(/[\r\n]+/g, ' ').trim();
}
