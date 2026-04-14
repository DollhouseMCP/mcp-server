/**
 * File-Backed Confirmation Store
 *
 * Persists Gatekeeper confirmation and CLI approval state to JSON files.
 * Each session gets its own file: ~/.dollhouse/state/confirmations-{sessionId}.json
 *
 * This is a low-level persistence layer. Business logic (LRU eviction,
 * TTL management, single-use invalidation, scope promotion) lives in
 * GatekeeperSession. This class provides durable storage that survives
 * process restarts.
 *
 * @since v2.1.0 — Issue #1945
 */

import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';
import type { ConfirmationRecord, CliApprovalRecord } from '../handlers/mcp-aql/GatekeeperTypes.js';
import type { IConfirmationStore } from './IConfirmationStore.js';
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
  cliApprovals: Array<[string, CliApprovalRecord]>;
  cliSessionApprovals: Array<[string, CliApprovalRecord]>;
  permissionPromptActive: boolean;
}

// ── Implementation ──────────────────────────────────────────────────

export class FileConfirmationStore implements IConfirmationStore {
  private readonly fileOps: FileOperationsService;
  private readonly stateDir: string;
  private readonly sessionId: string;
  private readonly persistPath: string;

  private confirmations = new Map<string, ConfirmationRecord>();
  private cliApprovals = new Map<string, CliApprovalRecord>();
  private cliSessionApprovals = new Map<string, CliApprovalRecord>();
  private permissionPromptActive = false;

  constructor(fileOps: FileOperationsService, stateDir?: string, sessionId?: string) {
    this.fileOps = fileOps;
    this.sessionId = sessionId
      ? validateExternalSessionId(sessionId)
      : 'default';
    this.stateDir = stateDir ?? path.join(os.homedir(), '.dollhouse', 'state');
    this.persistPath = path.join(this.stateDir, `confirmations-${this.sessionId}.json`);
  }

  async initialize(): Promise<void> {
    try {
      const content = await this.fileOps.readFile(this.persistPath);
      const data = JSON.parse(content) as PersistedConfirmationState;

      if (data.version === 1) {
        // Restore confirmations
        if (Array.isArray(data.confirmations)) {
          for (const [key, record] of data.confirmations) {
            if (key && record && typeof record.operation === 'string') {
              this.confirmations.set(key, record);
            }
          }
        }

        // Restore CLI approvals — drop expired records
        const now = Date.now();
        if (Array.isArray(data.cliApprovals)) {
          for (const [requestId, record] of data.cliApprovals) {
            if (!requestId || !record) continue;
            // Drop expired pending or consumed single-use approvals
            const age = now - new Date(record.requestedAt).getTime();
            const ttl = record.ttlMs ?? 300_000; // Default 5 minutes
            if (age > ttl && (!record.approvedAt || record.consumed)) {
              continue;
            }
            this.cliApprovals.set(requestId, record);
          }
        }

        // Restore session-scoped CLI approvals
        if (Array.isArray(data.cliSessionApprovals)) {
          for (const [toolName, record] of data.cliSessionApprovals) {
            if (toolName && record) {
              this.cliSessionApprovals.set(toolName, record);
            }
          }
        }

        // Restore permission prompt state
        if (typeof data.permissionPromptActive === 'boolean') {
          this.permissionPromptActive = data.permissionPromptActive;
        }

        const totalCount = this.confirmations.size + this.cliApprovals.size + this.cliSessionApprovals.size;
        if (totalCount > 0) {
          logger.info(
            `[FileConfirmationStore] Restored ${totalCount} record(s) for session '${this.sessionId}'`
          );
        }
      }
    } catch (error) {
      handleInitializeError(error, STORE_NAME, 'confirmation', this.sessionId);
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
}
