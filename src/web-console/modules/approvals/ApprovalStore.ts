import type { CliApprovalRecord, CliApprovalScope } from '../../../handlers/mcp-aql/GatekeeperTypes.js';
import type { Gatekeeper } from '../../../handlers/mcp-aql/Gatekeeper.js';
import type { IConfirmationStore } from '../../../state/IConfirmationStore.js';

/**
 * Console-owned approval record. Structurally mirrors the gatekeeper-internal
 * {@link CliApprovalRecord} but is owned by the console so an internal gatekeeper
 * change surfaces as a mapper compile error here rather than silently altering the
 * console contract. `scope` intentionally reuses the shared {@link CliApprovalScope}
 * value vocabulary.
 */
export interface ConsoleApprovalRecord {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInputDigest: Record<string, unknown>;
  readonly toolInputHash: string;
  readonly toolInputDetail?: Record<string, unknown>;
  readonly riskLevel: string;
  readonly riskScore: number;
  readonly irreversible: boolean;
  readonly requestedAt: string;
  readonly approvedAt?: string;
  readonly deniedAt?: string;
  readonly expiredAt?: string;
  readonly cancelledAt?: string;
  readonly consumed: boolean;
  readonly scope: CliApprovalScope;
  /** Scopes this request may be approved with. Absent on unrestricted legacy records. */
  readonly allowedScopes?: readonly CliApprovalScope[];
  readonly denyReason: string;
  readonly policySource?: string;
  readonly ttlMs?: number;
}

// Single explicit field copy shared by both mapping directions. The console and
// gatekeeper record shapes are structurally identical today; enumerating every field
// here (rather than spreading) keeps a compile-time tripwire — if the gatekeeper-internal
// CliApprovalRecord gains or renames a required field, toCliApprovalRecord stops compiling
// until the console shape and this mapping are consciously updated.
function copyApprovalRecordFields(record: ConsoleApprovalRecord | CliApprovalRecord): ConsoleApprovalRecord {
  return {
    requestId: record.requestId,
    toolName: record.toolName,
    toolInputDigest: record.toolInputDigest,
    toolInputHash: record.toolInputHash,
    toolInputDetail: record.toolInputDetail,
    riskLevel: record.riskLevel,
    riskScore: record.riskScore,
    irreversible: record.irreversible,
    requestedAt: record.requestedAt,
    approvedAt: record.approvedAt,
    deniedAt: record.deniedAt,
    expiredAt: record.expiredAt,
    cancelledAt: record.cancelledAt,
    consumed: record.consumed,
    scope: record.scope,
    allowedScopes: record.allowedScopes,
    denyReason: record.denyReason,
    policySource: record.policySource,
    ttlMs: record.ttlMs,
  };
}

/** Map a gatekeeper-internal CLI approval record into the console-owned shape. */
export function toConsoleApprovalRecord(record: CliApprovalRecord): ConsoleApprovalRecord {
  return copyApprovalRecordFields(record);
}

/** Map a console-owned approval record back into the gatekeeper-internal shape for persistence. */
export function toCliApprovalRecord(record: ConsoleApprovalRecord): CliApprovalRecord {
  return copyApprovalRecordFields(record);
}

export interface SessionApprovalStore {
  list(userId: string, sessionId: string): Promise<readonly ConsoleApprovalRecord[]>;
  find(userId: string, sessionId: string, approvalId: string): Promise<ConsoleApprovalRecord | null>;
  save(userId: string, sessionId: string, approvalId: string, record: ConsoleApprovalRecord): Promise<void>;
}

export type ConfirmationStoreFactory = (args: {
  readonly userId: string;
  readonly sessionId: string;
}) => IConfirmationStore | Promise<IConfirmationStore>;

export class ConfirmationSessionApprovalStore implements SessionApprovalStore {
  constructor(private readonly factory: ConfirmationStoreFactory) {}

  async list(userId: string, sessionId: string): Promise<readonly ConsoleApprovalRecord[]> {
    const store = await this.openStore(userId, sessionId);
    return store.getAllCliApprovals().map(toConsoleApprovalRecord);
  }

  async find(userId: string, sessionId: string, approvalId: string): Promise<ConsoleApprovalRecord | null> {
    const store = await this.openStore(userId, sessionId);
    const record = store.getCliApproval(approvalId);
    return record ? toConsoleApprovalRecord(record) : null;
  }

  async save(
    userId: string,
    sessionId: string,
    approvalId: string,
    record: ConsoleApprovalRecord,
  ): Promise<void> {
    const store = await this.openStore(userId, sessionId);
    const cliRecord = toCliApprovalRecord(record);
    store.saveCliApproval(approvalId, cliRecord);
    if (record.scope === 'tool_session' && record.approvedAt) {
      store.saveCliSessionApproval(record.toolName, cliRecord);
    }
    await store.persist();
  }

  private async openStore(userId: string, sessionId: string): Promise<IConfirmationStore> {
    const store = await this.factory({ userId, sessionId });
    await store.initialize();
    return store;
  }
}

export class InMemorySessionApprovalStore implements SessionApprovalStore {
  private readonly records = new Map<string, Map<string, ConsoleApprovalRecord>>();

  list(userId: string, sessionId: string): Promise<readonly ConsoleApprovalRecord[]> {
    return Promise.resolve(Array.from(this.getSessionRecords(userId, sessionId).values()));
  }

  find(userId: string, sessionId: string, approvalId: string): Promise<ConsoleApprovalRecord | null> {
    return Promise.resolve(this.getSessionRecords(userId, sessionId).get(approvalId) ?? null);
  }

  save(
    userId: string,
    sessionId: string,
    approvalId: string,
    record: ConsoleApprovalRecord,
  ): Promise<void> {
    this.getSessionRecords(userId, sessionId).set(approvalId, record);
    return Promise.resolve();
  }

  seed(userId: string, sessionId: string, record: ConsoleApprovalRecord): void {
    this.getSessionRecords(userId, sessionId).set(record.requestId, record);
  }

  private getSessionRecords(userId: string, sessionId: string): Map<string, ConsoleApprovalRecord> {
    const key = `${userId}\0${sessionId}`;
    let records = this.records.get(key);
    if (!records) {
      records = new Map<string, ConsoleApprovalRecord>();
      this.records.set(key, records);
    }
    return records;
  }
}

export class GatekeeperSessionApprovalStore implements SessionApprovalStore {
  constructor(private readonly gatekeeper: Gatekeeper) {}

  list(_userId: string, sessionId: string): Promise<readonly ConsoleApprovalRecord[]> {
    const records = this.gatekeeper.getRegisteredSession(sessionId)?.getAllCliApprovals() ?? [];
    return Promise.resolve(records.map(toConsoleApprovalRecord));
  }

  find(_userId: string, sessionId: string, approvalId: string): Promise<ConsoleApprovalRecord | null> {
    const record = this.gatekeeper.getRegisteredSession(sessionId)?.getCliApproval(approvalId);
    return Promise.resolve(record ? toConsoleApprovalRecord(record) : null);
  }

  async save(
    _userId: string,
    sessionId: string,
    approvalId: string,
    record: ConsoleApprovalRecord,
  ): Promise<void> {
    const session = this.gatekeeper.getRegisteredSession(sessionId);
    if (!session) return;
    if (record.deniedAt) {
      await session.denyCliRequest(approvalId, record.deniedAt);
      return;
    }
    if (record.approvedAt) {
      await session.approveCliRequest(approvalId, record.scope, record.approvedAt);
    }
  }
}

export function toCliApprovalScope(scope: 'once' | 'session'): CliApprovalScope {
  return scope === 'session' ? 'tool_session' : 'single';
}
