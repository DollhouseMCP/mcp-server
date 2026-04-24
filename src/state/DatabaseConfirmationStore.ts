/**
 * Database-Backed Confirmation Store
 *
 * Persists Gatekeeper confirmation and CLI approval state to the sessions
 * table (confirmations, cli_approvals, cli_session_approvals JSONB columns
 * and permission_prompt_active boolean). In-memory Maps are the hot path;
 * database writes are fire-and-forget.
 *
 * This is a low-level persistence layer. Business logic (LRU eviction,
 * TTL management, single-use invalidation, scope promotion) lives in
 * GatekeeperSession.
 *
 * @since v2.2.0 — Phase 4, Step 4.2
 */

import { logger } from '../utils/logger.js';
import type { ConfirmationRecord, CliApprovalRecord } from '../handlers/mcp-aql/GatekeeperTypes.js';
import type { DatabaseInstance } from '../database/connection.js';
import type { IConfirmationStore } from './IConfirmationStore.js';
import {
  validateDbStoreParams,
  handleDbInitializeError,
  loadSessionRow,
  ensureSessionRow,
  updateSessionColumns,
} from './db-persistence-utils.js';
import { PersistQueue } from './PersistQueue.js';

// ── Constants ───────────────────────────────────────────────────────

const STORE_NAME = 'DatabaseConfirmationStore';

// ── Implementation ──────────────────────────────────────────────────

export class DatabaseConfirmationStore implements IConfirmationStore {
  private readonly db: DatabaseInstance;
  private readonly userId: string;
  private readonly sessionId: string;

  private readonly confirmations = new Map<string, ConfirmationRecord>();
  private readonly cliApprovals = new Map<string, CliApprovalRecord>();
  private readonly cliSessionApprovals = new Map<string, CliApprovalRecord>();
  private permissionPromptActive = false;
  private initialized = false;
  private readonly persistQueue: PersistQueue;

  constructor(db: DatabaseInstance, userId: string, sessionId: string) {
    validateDbStoreParams(userId, sessionId);
    this.db = db;
    this.userId = userId;
    this.sessionId = sessionId;
    this.persistQueue = new PersistQueue({
      storeName: STORE_NAME,
      stateType: 'confirmation state',
      sessionId,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      await ensureSessionRow(this.db, this.userId, this.sessionId);

      const row = await loadSessionRow(this.db, this.userId, this.sessionId);
      if (!row) return;

      // Clear before populating to prevent duplicates on re-initialization
      this.confirmations.clear();
      this.cliApprovals.clear();
      this.cliSessionApprovals.clear();

      this.restoreConfirmations(row.confirmations as Array<[string, ConfirmationRecord]> | null);
      this.restoreCliApprovals(row.cliApprovals as Array<[string, CliApprovalRecord]> | null);
      this.restoreCliSessionApprovals(row.cliSessionApprovals as Array<[string, CliApprovalRecord]> | null);

      // Transient flag — do not restore from a previous crashed session
      this.permissionPromptActive = false;

      const totalCount = this.confirmations.size + this.cliApprovals.size + this.cliSessionApprovals.size;
      if (totalCount > 0) {
        logger.info(`[${STORE_NAME}] Restored ${totalCount} record(s) for session '${this.sessionId}'`);
      }
    } catch (error) {
      handleDbInitializeError(error, STORE_NAME, 'confirmation', this.sessionId);
    }
  }

  async persist(): Promise<void> {
    await this.persistQueue.enqueue(
      () => this.persistToDb(),
    );
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

  // ── Private ───────────────────────────────────────────────────────

  private restoreConfirmations(entries: Array<[string, ConfirmationRecord]> | null): void {
    if (!Array.isArray(entries)) return;
    for (const [key, record] of entries) {
      if (key && record && typeof record.operation === 'string') {
        this.confirmations.set(key, record);
      }
    }
  }

  private restoreCliApprovals(entries: Array<[string, CliApprovalRecord]> | null): void {
    if (!Array.isArray(entries)) return;
    const now = Date.now();
    for (const [requestId, record] of entries) {
      if (!requestId || !record) continue;
      const age = now - new Date(record.requestedAt).getTime();
      const ttl = record.ttlMs ?? 300_000;
      if (age > ttl && (!record.approvedAt || record.consumed)) continue;
      this.cliApprovals.set(requestId, record);
    }
  }

  private restoreCliSessionApprovals(entries: Array<[string, CliApprovalRecord]> | null): void {
    if (!Array.isArray(entries)) return;
    for (const [toolName, record] of entries) {
      if (toolName && record) {
        this.cliSessionApprovals.set(toolName, record);
      }
    }
  }

  private async persistToDb(): Promise<void> {
    await updateSessionColumns(this.db, this.userId, this.sessionId, {
      confirmations: Array.from(this.confirmations.entries()),
      cliApprovals: Array.from(this.cliApprovals.entries()),
      cliSessionApprovals: Array.from(this.cliSessionApprovals.entries()),
      permissionPromptActive: this.permissionPromptActive,
    });
  }
}
