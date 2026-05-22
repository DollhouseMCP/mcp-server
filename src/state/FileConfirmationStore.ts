/**
 * File-Backed Confirmation Store
 *
 * Persists Gatekeeper confirmation and CLI approval state to JSON files.
 * Each session gets its own file at `confirmations-{sessionId}.json` under
 * the resolved state directory (PathService.resolveDataDir('state'), which
 * routes to XDG / Library / LOCALAPPDATA or the configured legacy root).
 *
 * This is a low-level persistence layer. Business logic (LRU eviction,
 * TTL management, single-use invalidation, scope promotion) lives in
 * GatekeeperSession. This class provides durable storage that survives
 * process restarts.
 *
 * @since v2.1.0 — Issue #1945
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';
import type { ConfirmationRecord, CliApprovalRecord } from '../handlers/mcp-aql/GatekeeperTypes.js';
import { env } from '../config/env.js';
import { resolveDataDirectory } from '../paths/resolveDataDirectory.js';
import { normalizeCliApprovalRecord, type AuditHmacResolver } from '../security/toolRedaction.js';
import { APPROVAL_SEARCH_ROW_LIMIT } from './DatabaseConfirmationStore.js';
import type { ApprovalRef, ApprovalSearchFilter, IConfirmationStore } from './IConfirmationStore.js';
import { validateExternalSessionId } from './FileActivationStateStore.js';
import { fireAndForgetPersist, handleInitializeError } from './persistence-utils.js';

// ── Constants ───────────────────────────────────────────────────────

const STORE_NAME = 'FileConfirmationStore';

// ── Persisted File Format ───────────────────────────────────────────

interface PersistedConfirmationState {
  version: number;
  sessionId: string;
  lastUpdated: string;
  confirmations: Array<[string, ConfirmationRecord]>;
  cliApprovals: Array<[string, PersistedCliApprovalRecord]>;
  cliSessionApprovals: Array<[string, PersistedCliApprovalRecord]>;
  permissionPromptActive: boolean;
}

type PersistedCliApprovalRecord = CliApprovalRecord | (Omit<CliApprovalRecord, 'toolInputDigest' | 'toolInputHash'> & {
  toolInput?: Record<string, unknown>;
  toolInputDigest?: Record<string, unknown>;
  toolInputHash?: string;
});

// ── Implementation ──────────────────────────────────────────────────

export class FileConfirmationStore implements IConfirmationStore {
  private readonly fileOps: FileOperationsService;
  private readonly stateDir: string;
  private readonly sessionId: string;
  private readonly persistPath: string;

  private readonly confirmations = new Map<string, ConfirmationRecord>();
  private readonly cliApprovals = new Map<string, CliApprovalRecord>();
  private readonly cliSessionApprovals = new Map<string, CliApprovalRecord>();
  private permissionPromptActive = false;

  private readonly auditHmacResolver?: AuditHmacResolver;

  constructor(
    fileOps: FileOperationsService,
    stateDir?: string,
    sessionId?: string,
    auditHmacResolver?: AuditHmacResolver,
  ) {
    this.fileOps = fileOps;
    this.sessionId = sessionId
      ? validateExternalSessionId(sessionId)
      : 'default';
    // stateDir resolution: callers (SecurityServiceRegistrar / Container)
    // pass an explicit per-user path via PathService. Fallback to
    // resolveDataDirectory so tests and ad-hoc construction land on the
    // platform-correct state dir instead of the legacy hardcoded path.
    this.stateDir = stateDir ?? resolveDataDirectory('state');
    this.persistPath = path.join(this.stateDir, `confirmations-${this.sessionId}.json`);
    this.auditHmacResolver = auditHmacResolver;
  }

  async initialize(): Promise<void> {
    try {
      const content = await this.fileOps.readFile(this.persistPath);
      const data = JSON.parse(content) as PersistedConfirmationState;
      if (data.version !== 1) return;

      this.restoreConfirmations(data.confirmations);
      await this.restoreCliApprovals(data.cliApprovals);
      await this.restoreCliSessionApprovals(data.cliSessionApprovals);

      if (typeof data.permissionPromptActive === 'boolean') {
        this.permissionPromptActive = data.permissionPromptActive;
      }

      const totalCount = this.confirmations.size + this.cliApprovals.size + this.cliSessionApprovals.size;
      if (totalCount > 0) {
        logger.info(`[${STORE_NAME}] Restored ${totalCount} record(s) for session '${this.sessionId}'`);
      }
    } catch (error) {
      handleInitializeError(error, STORE_NAME, 'confirmation', this.sessionId);
    }
  }

  private restoreConfirmations(entries: Array<[string, ConfirmationRecord]> | undefined): void {
    if (!Array.isArray(entries)) return;
    for (const [key, record] of entries) {
      if (key && record && typeof record.operation === 'string') {
        this.confirmations.set(key, record);
      }
    }
  }

  private async restoreCliApprovals(entries: Array<[string, PersistedCliApprovalRecord]> | undefined): Promise<void> {
    if (!Array.isArray(entries)) return;
    const now = Date.now();
    for (const [requestId, record] of entries) {
      if (!requestId || !record) continue;
      const age = now - new Date(record.requestedAt).getTime();
      const ttl = record.ttlMs ?? 300_000;
      if (age > ttl && (!record.approvedAt || record.consumed)) continue;
      this.cliApprovals.set(requestId, await normalizeCliApprovalRecord(record, env.DOLLHOUSE_AUDIT_RETAIN_RAW_INPUT, this.auditHmacResolver));
    }
  }

  private async restoreCliSessionApprovals(entries: Array<[string, PersistedCliApprovalRecord]> | undefined): Promise<void> {
    if (!Array.isArray(entries)) return;
    for (const [toolName, record] of entries) {
      if (toolName && record) {
        this.cliSessionApprovals.set(toolName, await normalizeCliApprovalRecord(record, env.DOLLHOUSE_AUDIT_RETAIN_RAW_INPUT, this.auditHmacResolver));
      }
    }
  }

  async persist(): Promise<void> {
    this.persistAsync();
  }

  // ── Confirmation Records ──────────────────────────────────────────

  saveConfirmation(key: string, record: ConfirmationRecord): void {
    this.confirmations.set(key, record);
  }

  getConfirmation(key: string): ConfirmationRecord | undefined {
    return this.confirmations.get(key);
  }

  deleteConfirmation(key: string): boolean {
    return this.confirmations.delete(key);
  }

  getAllConfirmations(): ConfirmationRecord[] {
    return Array.from(this.confirmations.values());
  }

  clearAllConfirmations(): void {
    this.confirmations.clear();
  }

  // ── CLI Approval Records ──────────────────────────────────────────

  saveCliApproval(requestId: string, record: CliApprovalRecord): void {
    this.cliApprovals.set(requestId, record);
  }

  getCliApproval(requestId: string): CliApprovalRecord | undefined {
    return this.cliApprovals.get(requestId);
  }

  deleteCliApproval(requestId: string): boolean {
    return this.cliApprovals.delete(requestId);
  }

  getAllCliApprovals(): CliApprovalRecord[] {
    return Array.from(this.cliApprovals.values());
  }

  // ── Session-Scoped CLI Approvals ──────────────────────────────────

  saveCliSessionApproval(toolName: string, record: CliApprovalRecord): void {
    this.cliSessionApprovals.set(toolName, record);
  }

  getCliSessionApproval(toolName: string): CliApprovalRecord | undefined {
    return this.cliSessionApprovals.get(toolName);
  }

  getAllCliSessionApprovals(): CliApprovalRecord[] {
    return Array.from(this.cliSessionApprovals.values());
  }

  async findApprovals(filter: ApprovalSearchFilter): Promise<ApprovalRef[]> {
    const refs: ApprovalRef[] = [];
    // Same cap as DatabaseConfirmationStore — the dollhouse-audit CLI is
    // the only caller and surfaces a warning when refs.length reaches the
    // cap. Without this bound a long-running file-mode deployment with
    // many session files would walk them all on every unfiltered `find`.
    for (const sessionId of await this.findCandidateSessionIds(filter.sessionId)) {
      const approvals = sessionId === this.sessionId
        ? this.cliApprovals
        : await this.readCliApprovalsForSession(sessionId);
      for (const [approvalId, record] of approvals) {
        if (!approvalMatches(approvalId, record, filter)) continue;
        refs.push(toApprovalRef(sessionId, approvalId, record));
        if (refs.length >= APPROVAL_SEARCH_ROW_LIMIT) return refs;
      }
    }
    return refs;
  }

  async getRawApprovalDetail(sessionId: string, approvalId: string): Promise<Record<string, unknown> | null> {
    const approvals = sessionId === this.sessionId
      ? this.cliApprovals
      : await this.readCliApprovalsForSession(validateExternalSessionId(sessionId));
    return approvals.get(approvalId)?.toolInputDetail ?? null;
  }

  // ── Permission Prompt Tracking ────────────────────────────────────

  savePermissionPromptActive(active: boolean): void {
    this.permissionPromptActive = active;
  }

  getPermissionPromptActive(): boolean {
    return this.permissionPromptActive;
  }

  // ── Session Identity ──────────────────────────────────────────────

  getSessionId(): string {
    return this.sessionId;
  }

  // ── Private persistence methods ───────────────────────────────────

  private persistAsync(): void {
    fireAndForgetPersist(() => this.persistToDisk(), STORE_NAME, 'confirmation state', this.sessionId);
  }

  private async persistToDisk(): Promise<void> {
    const state: PersistedConfirmationState = {
      version: 1,
      sessionId: this.sessionId,
      lastUpdated: new Date().toISOString(),
      confirmations: Array.from(this.confirmations.entries()),
      cliApprovals: Array.from(this.cliApprovals.entries()),
      cliSessionApprovals: Array.from(this.cliSessionApprovals.entries()),
      permissionPromptActive: this.permissionPromptActive,
    };

    await fs.mkdir(this.stateDir, { recursive: true });
    await this.fileOps.writeFile(this.persistPath, JSON.stringify(state, null, 2));
  }

  private async findCandidateSessionIds(sessionId?: string): Promise<string[]> {
    if (sessionId) return [validateExternalSessionId(sessionId)];
    const names = await fs.readdir(this.stateDir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    const ids = new Set<string>([this.sessionId]);
    for (const name of names) {
      const match = /^confirmations-(.+)\.json$/.exec(name);
      if (match) ids.add(validateExternalSessionId(match[1]));
    }
    return Array.from(ids);
  }

  private async readCliApprovalsForSession(sessionId: string): Promise<Map<string, CliApprovalRecord>> {
    const filePath = path.join(this.stateDir, `confirmations-${sessionId}.json`);
    try {
      const content = await this.fileOps.readFile(filePath);
      const data = JSON.parse(content) as PersistedConfirmationState;
      const approvals = new Map<string, CliApprovalRecord>();
      if (!Array.isArray(data.cliApprovals)) return approvals;
      for (const [approvalId, record] of data.cliApprovals) {
        approvals.set(approvalId, await normalizeCliApprovalRecord(record, env.DOLLHOUSE_AUDIT_RETAIN_RAW_INPUT, this.auditHmacResolver));
      }
      return approvals;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return new Map();
      throw err;
    }
  }
}

function approvalMatches(approvalId: string, record: CliApprovalRecord, filter: ApprovalSearchFilter): boolean {
  if (filter.approvalId && filter.approvalId !== approvalId) return false;
  const requestedAt = new Date(record.requestedAt).getTime();
  if (filter.after !== undefined && requestedAt < filter.after) return false;
  if (filter.before !== undefined && requestedAt > filter.before) return false;
  return true;
}

function toApprovalRef(sessionId: string, approvalId: string, record: CliApprovalRecord): ApprovalRef {
  return {
    sessionId,
    approvalId,
    toolName: record.toolName,
    approvedAt: record.approvedAt,
    requestedAt: record.requestedAt,
    digest: record.toolInputDigest ?? {},
  };
}
