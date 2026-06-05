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
import { env } from '../config/env.js';
import { normalizeCliApprovalRecord, type AuditHmacResolver } from '../security/toolRedaction.js';
import type { DatabaseInstance } from '../database/connection.js';
import { withSystemContext } from '../database/admin.js';
import { sessions } from '../database/schema/index.js';
import { and, eq, type SQL } from 'drizzle-orm';
import type { ApprovalRef, ApprovalSearchFilter, IConfirmationStore } from './IConfirmationStore.js';
import { approvalMatches, toApprovalRef } from './approvalSearch.js';
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
const TERMINAL_APPROVAL_RETENTION_MS = 86_400_000;

type PersistedCliApprovalRecord = CliApprovalRecord | (Omit<CliApprovalRecord, 'toolInputDigest' | 'toolInputHash'> & {
  toolInput?: Record<string, unknown>;
  toolInputDigest?: Record<string, unknown>;
  toolInputHash?: string;
});

interface SessionApprovalRow {
  userId: string;
  sessionId: string;
  cliApprovals: unknown;
}

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

  private readonly auditHmacResolver?: AuditHmacResolver;

  constructor(
    db: DatabaseInstance,
    userId: string,
    sessionId: string,
    auditHmacResolver?: AuditHmacResolver,
  ) {
    validateDbStoreParams(userId, sessionId);
    this.db = db;
    this.userId = userId;
    this.sessionId = sessionId;
    this.auditHmacResolver = auditHmacResolver;
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

      this.restoreConfirmations(row.confirmations);
      await this.restoreCliApprovals(row.cliApprovals);
      await this.restoreCliSessionApprovals(row.cliSessionApprovals);

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

  async findApprovals(filter: ApprovalSearchFilter): Promise<ApprovalRef[]> {
    const refs: ApprovalRef[] = [];
    for (const row of await this.loadApprovalRows(filter)) {
      const approvals = row.sessionId === this.sessionId
        ? this.cliApprovals
        : await normalizeApprovalEntries(row.cliApprovals, env.DOLLHOUSE_AUDIT_RETAIN_RAW_INPUT, this.auditHmacResolver);
      for (const [approvalId, record] of approvals) {
        if (!approvalMatches(approvalId, record, filter)) continue;
        refs.push(toApprovalRef(row.sessionId, approvalId, record));
      }
    }
    return refs;
  }

  async getRawApprovalDetail(sessionId: string, approvalId: string): Promise<Record<string, unknown> | null> {
    if (sessionId === this.sessionId) return this.cliApprovals.get(approvalId)?.toolInputDetail ?? null;
    const rows = await this.loadApprovalRows({ sessionId, approvalId });
    const row = rows.find(r => r.sessionId === sessionId);
    if (!row) return null;
    const approvals = await normalizeApprovalEntries(row.cliApprovals, env.DOLLHOUSE_AUDIT_RETAIN_RAW_INPUT, this.auditHmacResolver);
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

  // ── Private ───────────────────────────────────────────────────────

  private restoreConfirmations(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (isEntry(entry)) {
        const [key, record] = entry as [string, ConfirmationRecord];
        this.confirmations.set(key, record);
      }
    }
  }

  private async restoreCliApprovals(entries: unknown): Promise<void> {
    if (!Array.isArray(entries)) return;
    const now = Date.now();
    for (const entry of entries) {
      if (!isEntry(entry)) continue;
      const [requestId, record] = entry as [string, PersistedCliApprovalRecord];
      const age = now - new Date(record.requestedAt).getTime();
      const ttl = record.ttlMs ?? 300_000;
      if (age > ttl && record.consumed) continue;
      if (isExpiredTerminal(record, now)) continue;
      this.cliApprovals.set(requestId, await normalizeCliApprovalRecord(record, env.DOLLHOUSE_AUDIT_RETAIN_RAW_INPUT, this.auditHmacResolver));
    }
  }

  private async restoreCliSessionApprovals(entries: unknown): Promise<void> {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!isEntry(entry)) continue;
      const [toolName, record] = entry as [string, PersistedCliApprovalRecord];
      if (isExpiredTerminal(record, Date.now())) continue;
      this.cliSessionApprovals.set(toolName, await normalizeCliApprovalRecord(record, env.DOLLHOUSE_AUDIT_RETAIN_RAW_INPUT, this.auditHmacResolver));
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

  /**
   * Loads candidate session rows for an approval search, applying the
   * caller's userId/sessionId filters at the SQL layer. Time-range filters
   * (after/before) stay in-memory because they live inside the cli_approvals
   * JSONB blob and can't be filtered with a simple column predicate.
   *
   * Always bounded by APPROVAL_SEARCH_ROW_LIMIT to keep an unbounded admin
   * call from pulling the entire sessions table across the wire. Callers
   * hitting the cap should narrow the search; the CLI surfaces a warning.
   */
  private async loadApprovalRows(filter: ApprovalSearchFilter): Promise<SessionApprovalRow[]> {
    const conditions: SQL[] = [];
    if (filter.userId) conditions.push(eq(sessions.userId, filter.userId));
    if (filter.sessionId) conditions.push(eq(sessions.sessionId, filter.sessionId));
    let whereClause: SQL | undefined;
    if (conditions.length === 1) whereClause = conditions[0];
    else if (conditions.length > 1) whereClause = and(...conditions);

    const rows = await withSystemContext(this.db, (tx) => {
      // We only select cliApprovals (not cliSessionApprovals) because
      // session-scoped approvals are runtime promotions tied to a live
      // session and never survive its lifetime in audit-relevant form.
      // The audit CLI investigates request-level approvals — the
      // cliApprovals array is the persistent record of those.
      const query = tx
        .select({
          userId: sessions.userId,
          sessionId: sessions.sessionId,
          cliApprovals: sessions.cliApprovals,
        })
        .from(sessions);
      return (whereClause ? query.where(whereClause) : query).limit(APPROVAL_SEARCH_ROW_LIMIT);
    });
    return rows;
  }
}

/**
 * Hard cap on rows pulled by an approval search. Picked to keep the admin
 * CLI bounded even on a busy deployment without burying legitimate broad
 * searches. Callers that hit the cap should narrow by userId or time.
 *
 * Exported so the CLI can detect "result count equals cap → may be
 * truncated" and surface a warning to the operator.
 */
export const APPROVAL_SEARCH_ROW_LIMIT = 1000;

async function normalizeApprovalEntries(
  entries: unknown,
  retainRaw: boolean,
  resolver: AuditHmacResolver | undefined,
): Promise<Map<string, CliApprovalRecord>> {
  const approvals = new Map<string, CliApprovalRecord>();
  if (!Array.isArray(entries)) return approvals;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [approvalId, record] = entry as [string, PersistedCliApprovalRecord];
    if (typeof approvalId !== 'string') continue;
    approvals.set(approvalId, await normalizeCliApprovalRecord(record, retainRaw, resolver));
  }
  return approvals;
}

function isEntry(value: unknown): value is [string, unknown] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Boolean(value[1]);
}

function isExpiredTerminal(record: {
  deniedAt?: string;
  expiredAt?: string;
  cancelledAt?: string;
}, now: number): boolean {
  const terminalTimestamp = record.deniedAt ?? record.expiredAt ?? record.cancelledAt ?? undefined;
  if (!terminalTimestamp) return false;
  return now - new Date(terminalTimestamp).getTime() > TERMINAL_APPROVAL_RETENTION_MS;
}
