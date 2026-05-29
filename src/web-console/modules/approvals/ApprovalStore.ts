import type { CliApprovalRecord, CliApprovalScope } from '../../../handlers/mcp-aql/GatekeeperTypes.js';
import type { Gatekeeper } from '../../../handlers/mcp-aql/Gatekeeper.js';
import type { IConfirmationStore } from '../../../state/IConfirmationStore.js';

export type ConsoleApprovalRecord = CliApprovalRecord;

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
    return store.getAllCliApprovals();
  }

  async find(userId: string, sessionId: string, approvalId: string): Promise<ConsoleApprovalRecord | null> {
    const store = await this.openStore(userId, sessionId);
    return store.getCliApproval(approvalId) ?? null;
  }

  async save(
    userId: string,
    sessionId: string,
    approvalId: string,
    record: ConsoleApprovalRecord,
  ): Promise<void> {
    const store = await this.openStore(userId, sessionId);
    store.saveCliApproval(approvalId, record);
    if (record.scope === 'tool_session' && record.approvedAt) {
      store.saveCliSessionApproval(record.toolName, record);
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
    return Promise.resolve(this.gatekeeper.getRegisteredSession(sessionId)?.getAllCliApprovals() ?? []);
  }

  find(_userId: string, sessionId: string, approvalId: string): Promise<ConsoleApprovalRecord | null> {
    return Promise.resolve(this.gatekeeper.getRegisteredSession(sessionId)?.getCliApproval(approvalId) ?? null);
  }

  save(
    _userId: string,
    sessionId: string,
    approvalId: string,
    record: ConsoleApprovalRecord,
  ): Promise<void> {
    const session = this.gatekeeper.getRegisteredSession(sessionId);
    if (!session) return Promise.resolve();
    if (record.deniedAt) {
      session.denyCliRequest(approvalId, record.deniedAt);
      return Promise.resolve();
    }
    if (record.approvedAt) {
      session.approveCliRequest(approvalId, record.scope, record.approvedAt);
    }
    return Promise.resolve();
  }
}

export function toCliApprovalScope(scope: 'once' | 'session'): CliApprovalScope {
  return scope === 'session' ? 'tool_session' : 'single';
}
