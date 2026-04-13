/**
 * Confirmation Store Interface
 *
 * Persistence contract for Gatekeeper confirmations and CLI approval state.
 * Each store instance is bound to a single session at construction.
 *
 * This is a low-level persistence layer. Business logic (LRU eviction,
 * TTL management, single-use invalidation, scope promotion) lives in
 * GatekeeperSession. The store provides granular key-level operations.
 *
 * Implementations:
 * - FileConfirmationStore: JSON files in ~/.dollhouse/state/
 * - (Phase 4) DatabaseConfirmationStore: PostgreSQL rows
 *
 * @since v2.1.0 — Issue #1945
 */

import type { ConfirmationRecord, CliApprovalRecord } from '../handlers/mcp-aql/GatekeeperTypes.js';

/**
 * Persistence-only contract for Gatekeeper confirmation and CLI approval state.
 */
export interface IConfirmationStore {
  /**
   * Load persisted confirmation state from the backing store.
   * Tolerates missing or corrupt data — starts fresh on failure.
   * Drops TTL-expired CLI approvals on load.
   */
  initialize(): Promise<void>;

  /**
   * Persist current state to the backing store.
   * Implementations should use fire-and-forget with retry.
   */
  persist(): Promise<void>;

  // ── Confirmation Records ──────────────────────────────────────────

  /**
   * Save a confirmation record.
   * @param key - Composite key (e.g., 'create_element:skill' or 'create_element')
   * @param record - The confirmation record to persist
   */
  saveConfirmation(key: string, record: ConfirmationRecord): void;

  /**
   * Retrieve a confirmation record by key.
   * @param key - Composite key
   */
  getConfirmation(key: string): ConfirmationRecord | undefined;

  /**
   * Delete a confirmation record.
   * @param key - Composite key
   * @returns true if a record was deleted
   */
  deleteConfirmation(key: string): boolean;

  /**
   * Get all active confirmation records.
   */
  getAllConfirmations(): ConfirmationRecord[];

  /**
   * Clear all confirmation records.
   */
  clearAllConfirmations(): void;

  // ── CLI Approval Records ──────────────────────────────────────────

  /**
   * Save a CLI approval record.
   * @param requestId - Unique request ID (format: cli-<UUIDv4>)
   * @param record - The CLI approval record to persist
   */
  saveCliApproval(requestId: string, record: CliApprovalRecord): void;

  /**
   * Retrieve a CLI approval record by request ID.
   * @param requestId - Unique request ID
   */
  getCliApproval(requestId: string): CliApprovalRecord | undefined;

  /**
   * Delete a CLI approval record.
   * @param requestId - Unique request ID
   * @returns true if a record was deleted
   */
  deleteCliApproval(requestId: string): boolean;

  /**
   * Get all CLI approval records.
   */
  getAllCliApprovals(): CliApprovalRecord[];

  // ── Session-Scoped CLI Approvals ──────────────────────────────────

  /**
   * Save a session-scoped CLI approval (promoted from single-use).
   * @param toolName - Tool name used as key
   * @param record - The CLI approval record
   */
  saveCliSessionApproval(toolName: string, record: CliApprovalRecord): void;

  /**
   * Retrieve a session-scoped CLI approval by tool name.
   * @param toolName - Tool name
   */
  getCliSessionApproval(toolName: string): CliApprovalRecord | undefined;

  // ── Permission Prompt Tracking ────────────────────────────────────

  /**
   * Persist whether permission_prompt has been invoked this session.
   * @param active - Whether permission prompt is active
   */
  savePermissionPromptActive(active: boolean): void;

  /**
   * Get whether permission_prompt has been invoked this session.
   */
  getPermissionPromptActive(): boolean;

  // ── Session Identity ──────────────────────────────────────────────

  /**
   * Get the session ID this store is scoped to.
   */
  getSessionId(): string;
}
