import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';

import type { AgentState } from './types.js';
import type { AgentStateKey } from '../../storage/IAgentStateStore.js';
import { logger } from '../../utils/logger.js';
import {
  parseFilesystemProcessIncarnation,
  readFilesystemProcessIncarnation,
  sameFilesystemProcessIncarnation,
  withFilesystemInterprocessGuard,
  type FilesystemProcessIncarnation,
} from '../../security/filesystemInterprocessGuard.js';

const JOURNAL_VERSION = 1;
const JOURNAL_SUFFIX = '.agent-replacement.json';
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_RECOVERY_DELAY_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const LIVE_OPERATIONS = new Map<string, string>();

export interface AgentSnapshotReplacementRecord {
  readonly version: typeof JOURNAL_VERSION;
  readonly operationId: string;
  readonly createdAt: string;
  readonly ownerHost: string;
  readonly ownerPid: number;
  readonly ownerIncarnation: FilesystemProcessIncarnation | null;
  readonly ownerInstanceId: string;
  readonly recoveryNotBefore: string;
  readonly heartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly releasedAt: string | null;
  readonly leaseToken: string;
  readonly agentName: string;
  readonly filePath: string;
  readonly isDatabaseMode: boolean;
  readonly stateKey: AgentStateKey;
  readonly stateIncluded: boolean;
  readonly previousAgentJson: string;
  readonly intendedAgentJson: string;
  readonly previousDefinition: string;
  readonly intendedDefinition: string;
  readonly previousState: AgentState | null;
  readonly intendedState: AgentState | null;
}

export interface AgentSnapshotReplacementJournalEntry {
  readonly journalPath: string;
  readonly record: AgentSnapshotReplacementRecord;
}

export interface IAgentSnapshotReplacementJournal {
  initialize(): Promise<void>;
  create(input: NewAgentSnapshotReplacementRecord): Promise<AgentSnapshotReplacementJournalEntry>;
  list(): Promise<AgentSnapshotReplacementJournalEntry[]>;
  read(journalPath: string): Promise<AgentSnapshotReplacementJournalEntry | null>;
  remove(journalPath: string, expectedLeaseToken: string): Promise<void>;
  runWhileOwned<T>(
    entry: AgentSnapshotReplacementJournalEntry,
    operation: () => Promise<T>,
  ): Promise<T>;
  runWithAgentMutationGate<T>(agentName: string, operation: () => Promise<T>): Promise<T>;
  quarantine(entry: AgentSnapshotReplacementJournalEntry, reason: string): Promise<void>;
  isRecoveryEligible(record: AgentSnapshotReplacementRecord, now?: number): Promise<boolean>;
  claimForRecovery(
    entry: AgentSnapshotReplacementJournalEntry,
    now?: number,
  ): Promise<AgentSnapshotReplacementJournalEntry | null>;
  assertOwnership(entry: AgentSnapshotReplacementJournalEntry): Promise<void>;
  releaseOwnership(entry: AgentSnapshotReplacementJournalEntry): Promise<void>;
}

export type NewAgentSnapshotReplacementRecord = Omit<
  AgentSnapshotReplacementRecord,
  | 'version'
  | 'operationId'
  | 'createdAt'
  | 'ownerHost'
  | 'ownerPid'
  | 'ownerIncarnation'
  | 'ownerInstanceId'
  | 'recoveryNotBefore'
  | 'heartbeatAt'
  | 'leaseExpiresAt'
  | 'releasedAt'
  | 'leaseToken'
>;

/**
 * Durable write-ahead journal for the two-store agent snapshot replacement.
 * A journal remains authoritative until both definition and state are coherent
 * and the entry has been durably removed.
 */
export class AgentSnapshotReplacementJournal implements IAgentSnapshotReplacementJournal {
  private readonly instanceId = randomUUID();
  private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly heartbeatRenewals = new Map<string, Promise<void>>();

  constructor(
    private readonly directoryProvider: () => string,
    private readonly recoveryDelayMs = DEFAULT_RECOVERY_DELAY_MS,
    private readonly processIncarnationProvider = readFilesystemProcessIncarnation,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(this.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('Agent replacement journal path is not a real directory');
    }
    await chmod(this.directory, 0o700);
  }

  async create(
    input: NewAgentSnapshotReplacementRecord,
  ): Promise<AgentSnapshotReplacementJournalEntry> {
    await this.initialize();
    const operationId = randomUUID();
    const now = Date.now();
    const leaseToken = randomUUID();
    const ownerIncarnation = await this.processIncarnationProvider(process.pid).catch(() => null);
    const record: AgentSnapshotReplacementRecord = {
      version: JOURNAL_VERSION,
      operationId,
      createdAt: new Date().toISOString(),
      ownerHost: hostname(),
      ownerPid: process.pid,
      ownerIncarnation,
      ownerInstanceId: this.instanceId,
      recoveryNotBefore: new Date(now + this.recoveryDelayMs).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + this.recoveryDelayMs).toISOString(),
      releasedAt: null,
      leaseToken,
      ...input,
    };
    const safeName = this.safeName(input.agentName);
    const identityHash = createHash('sha256').update(safeName, 'utf8').digest('hex').slice(0, 16);
    const journalPath = path.join(this.directory, `${safeName}.${identityHash}${JOURNAL_SUFFIX}`);
    const tempPath = `${journalPath}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JOURNAL_BYTES) {
      throw new Error(`Agent replacement journal exceeds ${MAX_JOURNAL_BYTES} bytes`);
    }
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(tempPath, journalPath);
      await unlink(tempPath);
      await this.syncDirectory();
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Agent snapshot replacement is already active for '${input.agentName}'`);
      }
      throw error;
    }
    const entry = { journalPath, record };
    this.trackOwnership(entry);
    return entry;
  }

  async list(): Promise<AgentSnapshotReplacementJournalEntry[]> {
    await this.initialize();
    const names = (await readdir(this.directory))
      .filter((name) => name.endsWith(JOURNAL_SUFFIX))
      .sort();
    const entries: AgentSnapshotReplacementJournalEntry[] = [];
    for (const name of names) {
      const journalPath = path.join(this.directory, name);
      try {
        const entry = await this.read(journalPath);
        if (entry) entries.push(entry);
      } catch (error) {
        await this.quarantineUnreadableJournal(journalPath);
        logger.error('Quarantined unreadable agent replacement journal', {
          journalPath,
          error,
        });
      }
    }
    return entries;
  }

  async read(
    journalPath: string,
  ): Promise<AgentSnapshotReplacementJournalEntry | null> {
    this.assertJournalPath(journalPath);
    let raw: string;
    try {
      const journalStat = await lstat(journalPath);
      if (!journalStat.isFile() || journalStat.isSymbolicLink()) {
        throw new Error('Agent replacement journal path is not a regular file');
      }
      raw = await readFile(journalPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_JOURNAL_BYTES) {
      throw new Error(`Agent replacement journal exceeds ${MAX_JOURNAL_BYTES} bytes`);
    }
    const record = this.parseRecord(raw);
    return { journalPath, record };
  }

  async remove(journalPath: string, expectedLeaseToken: string): Promise<void> {
    this.assertJournalPath(journalPath);
    let removedOperationId: string | undefined;
    const removed = await this.withClaim(journalPath, true, async () => {
      const current = await this.read(journalPath);
      if (!current || current.record.leaseToken !== expectedLeaseToken) return false;
      try {
        await unlink(journalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      removedOperationId = current.record.operationId;
      return true;
    });
    if (!removed || !removedOperationId) {
      throw new Error('Agent replacement journal removal lost its lease fence');
    }
    this.stopOwnership(removedOperationId, expectedLeaseToken);
    await this.syncDirectory();
  }

  async runWhileOwned<T>(
    entry: AgentSnapshotReplacementJournalEntry,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.refreshLeaseWhileOwned(entry);
    const result = await operation();
    await this.refreshLeaseWhileOwned(entry);
    return result;
  }

  async runWithAgentMutationGate<T>(
    agentName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.initialize();
    return withFilesystemInterprocessGuard(this.mutationGuardPath(agentName), operation);
  }

  async quarantine(entry: AgentSnapshotReplacementJournalEntry, reason: string): Promise<void> {
    const quarantined = await this.withClaim(entry.journalPath, true, async () => {
      const current = await this.read(entry.journalPath);
      if (!current || current.record.leaseToken !== entry.record.leaseToken) return false;
      const quarantinePath = `${entry.journalPath}.quarantined-${Date.now()}-${randomUUID()}`;
      await rename(entry.journalPath, quarantinePath);
      return true;
    });
    if (!quarantined) {
      throw new Error(`Agent replacement journal quarantine lost its lease fence: ${reason}`);
    }
    this.stopOwnership(entry.record.operationId, entry.record.leaseToken);
    await this.syncDirectory();
  }

  async isRecoveryEligible(
    record: AgentSnapshotReplacementRecord,
    now = Date.now(),
  ): Promise<boolean> {
    if (LIVE_OPERATIONS.get(record.operationId) === record.leaseToken) return false;
    if (Date.parse(record.leaseExpiresAt) > now) return false;
    if (record.releasedAt !== null) return true;
    if (record.ownerHost === hostname()) {
      try {
        process.kill(record.ownerPid, 0);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return true;
        if (code !== 'EPERM') throw error;
      }
      const currentIncarnation = await this.processIncarnationProvider(record.ownerPid)
        .catch(() => null);
      if (!record.ownerIncarnation || !currentIncarnation) return false;
      return !sameFilesystemProcessIncarnation(record.ownerIncarnation, currentIncarnation);
    }
    return true;
  }

  /** Atomically fences an expired owner before recovery. */
  async claimForRecovery(
    entry: AgentSnapshotReplacementJournalEntry,
    now = Date.now(),
  ): Promise<AgentSnapshotReplacementJournalEntry | null> {
    if (!await this.isRecoveryEligible(entry.record, now)) return null;
    return this.withClaim(entry.journalPath, false, async () => {
      const current = await this.read(entry.journalPath);
      if (!current || !await this.isRecoveryEligible(current.record, now)) return null;
      const ownerIncarnation = await this.processIncarnationProvider(process.pid).catch(() => null);
      const claimedRecord: AgentSnapshotReplacementRecord = {
        ...current.record,
        ownerHost: hostname(),
        ownerPid: process.pid,
        ownerIncarnation,
        ownerInstanceId: this.instanceId,
        heartbeatAt: new Date(now).toISOString(),
        leaseExpiresAt: new Date(now + this.recoveryDelayMs).toISOString(),
        releasedAt: null,
        leaseToken: randomUUID(),
      };
      await this.writeRecord(entry.journalPath, claimedRecord);
      const claimed = { journalPath: entry.journalPath, record: claimedRecord };
      this.trackOwnership(claimed);
      return claimed;
    });
  }

  async assertOwnership(entry: AgentSnapshotReplacementJournalEntry): Promise<void> {
    await this.assertOwnershipWithClaim(entry);
  }

  private async assertOwnershipWithClaim(
    entry: AgentSnapshotReplacementJournalEntry,
  ): Promise<void> {
    const owned = await this.withClaim(entry.journalPath, true, async () => {
      const current = await this.read(entry.journalPath);
      return Boolean(
        current &&
        current.record.operationId === entry.record.operationId &&
        current.record.leaseToken === entry.record.leaseToken &&
        LIVE_OPERATIONS.get(entry.record.operationId) === entry.record.leaseToken
      );
    });
    if (
      owned !== true
    ) {
      throw new Error(`Agent replacement lease was lost for '${entry.record.agentName}'`);
    }
  }

  async releaseOwnership(entry: AgentSnapshotReplacementJournalEntry): Promise<void> {
    const released = await this.withClaim(entry.journalPath, true, async () => {
      const current = await this.read(entry.journalPath);
      if (
        !current ||
        current.record.operationId !== entry.record.operationId ||
        current.record.leaseToken !== entry.record.leaseToken
      ) return false;
      const releasedAt = new Date();
      await this.writeRecord(entry.journalPath, {
        ...current.record,
        ownerIncarnation: null,
        leaseToken: randomUUID(),
        heartbeatAt: releasedAt.toISOString(),
        leaseExpiresAt: new Date(0).toISOString(),
        releasedAt: releasedAt.toISOString(),
      });
      this.stopOwnership(entry.record.operationId, entry.record.leaseToken);
      return true;
    });
    if (!released) {
      throw new Error('Agent replacement journal release lost its lease fence');
    }
    await this.waitForHeartbeatRenewal(entry.record.operationId, entry.record.leaseToken);
  }

  private get directory(): string {
    return this.directoryProvider();
  }

  private parseRecord(raw: string): AgentSnapshotReplacementRecord {
    const value: unknown = JSON.parse(raw);
    return parseAgentSnapshotReplacementRecord(value);
  }

  private mutationGuardPath(agentName: string): string {
    const safeName = canonicalAgentMutationIdentity(agentName);
    const identityHash = createHash('sha256').update(safeName, 'utf8').digest('hex').slice(0, 16);
    return path.join(this.directory, `${safeName}.${identityHash}.mutation-guard`);
  }

  private assertJournalPath(journalPath: string): void {
    const resolvedDirectory = path.resolve(this.directory);
    const resolvedPath = path.resolve(journalPath);
    if (
      path.dirname(resolvedPath) !== resolvedDirectory ||
      !path.basename(resolvedPath).endsWith(JOURNAL_SUFFIX)
    ) {
      throw new Error('Agent replacement journal path is outside its journal directory');
    }
  }

  private safeName(name: string): string {
    return canonicalAgentMutationIdentity(name);
  }

  private async syncDirectory(): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.directory, 'r');
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code !== 'EINVAL' &&
        code !== 'ENOTSUP' &&
        code !== 'EBADF' &&
        code !== 'EISDIR' &&
        code !== 'EPERM'
      ) throw error;
    } finally {
      await handle?.close();
    }
  }

  private trackOwnership(entry: AgentSnapshotReplacementJournalEntry): void {
    LIVE_OPERATIONS.set(entry.record.operationId, entry.record.leaseToken);
    const intervalMs = Math.max(
      25,
      Math.min(DEFAULT_HEARTBEAT_INTERVAL_MS, Math.floor(this.recoveryDelayMs / 3)),
    );
    const renewalKey = `${entry.record.operationId}:${entry.record.leaseToken}`;
    const timer = setInterval(() => {
      if (this.heartbeatRenewals.has(renewalKey)) return;
      const renewal = this.renewOwnership(entry)
        .catch(() => {
          this.stopOwnership(entry.record.operationId, entry.record.leaseToken);
        })
        .finally(() => {
          if (this.heartbeatRenewals.get(renewalKey) === renewal) {
            this.heartbeatRenewals.delete(renewalKey);
          }
        });
      this.heartbeatRenewals.set(renewalKey, renewal);
    }, intervalMs);
    timer.unref();
    this.heartbeatTimers.set(entry.record.operationId, timer);
  }

  private async renewOwnership(entry: AgentSnapshotReplacementJournalEntry): Promise<void> {
    if (LIVE_OPERATIONS.get(entry.record.operationId) !== entry.record.leaseToken) return;
    await this.refreshLeaseWhileOwned(entry);
  }

  private async refreshLeaseWhileOwned(
    entry: AgentSnapshotReplacementJournalEntry,
    wait = true,
  ): Promise<void> {
    const refreshed = await this.withClaim(entry.journalPath, wait, async () => {
      const current = await this.read(entry.journalPath);
      if (
        !current ||
        current.record.operationId !== entry.record.operationId ||
        current.record.leaseToken !== entry.record.leaseToken ||
        LIVE_OPERATIONS.get(entry.record.operationId) !== entry.record.leaseToken
      ) return false;
      const now = Date.now();
      await this.writeRecord(entry.journalPath, {
        ...current.record,
        heartbeatAt: new Date(now).toISOString(),
        leaseExpiresAt: new Date(now + this.recoveryDelayMs).toISOString(),
      });
      return true;
    });
    if (refreshed === false) {
      this.stopOwnership(entry.record.operationId, entry.record.leaseToken);
      throw new Error(`Agent replacement lease was lost for '${entry.record.agentName}'`);
    }
  }

  private stopOwnership(operationId: string, leaseToken: string): void {
    if (LIVE_OPERATIONS.get(operationId) !== leaseToken) return;
    LIVE_OPERATIONS.delete(operationId);
    const timer = this.heartbeatTimers.get(operationId);
    if (timer) clearInterval(timer);
    this.heartbeatTimers.delete(operationId);
  }

  private async waitForHeartbeatRenewal(operationId: string, leaseToken: string): Promise<void> {
    await this.heartbeatRenewals.get(`${operationId}:${leaseToken}`);
  }

  private async writeRecord(
    journalPath: string,
    record: AgentSnapshotReplacementRecord,
  ): Promise<void> {
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JOURNAL_BYTES) {
      throw new Error(`Agent replacement journal exceeds ${MAX_JOURNAL_BYTES} bytes`);
    }
    const tempPath = `${journalPath}.${randomUUID()}.tmp`;
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tempPath, journalPath);
      await this.syncDirectory();
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private async withClaim<T>(
    journalPath: string,
    wait: boolean,
    operation: () => Promise<T>,
  ): Promise<T | null> {
    const claimPath = `${journalPath}.claim`;
    try {
      return await withFilesystemInterprocessGuard(claimPath, operation, {
        timeoutMs: wait ? 5_000 : 0,
        retryMs: 10,
      });
    } catch (error) {
      if (!wait && error instanceof Error &&
          error.message === `Timed out acquiring filesystem interprocess guard '${claimPath}'`) {
        return null;
      }
      throw error;
    }
  }

  private async quarantineUnreadableJournal(journalPath: string): Promise<void> {
    await this.withClaim(journalPath, true, async () => {
      const quarantinePath = `${journalPath}.quarantined-${Date.now()}-${randomUUID()}`;
      try {
        await rename(journalPath, quarantinePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
    await this.syncDirectory();
  }
}

export function parseAgentSnapshotReplacementRecord(
  value: unknown,
): AgentSnapshotReplacementRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent replacement journal must contain an object');
  }
  const rawRecord = value as Partial<AgentSnapshotReplacementRecord>;
  const record = {
    ...rawRecord,
    releasedAt: rawRecord.releasedAt ?? null,
  };
  if (
      record.version !== JOURNAL_VERSION ||
      typeof record.operationId !== 'string' ||
      typeof record.createdAt !== 'string' ||
      typeof record.ownerHost !== 'string' ||
      typeof record.ownerPid !== 'number' ||
      !Number.isSafeInteger(record.ownerPid) ||
      record.ownerPid <= 0 ||
      parseFilesystemProcessIncarnation(record.ownerIncarnation) === undefined ||
      typeof record.ownerInstanceId !== 'string' ||
      typeof record.recoveryNotBefore !== 'string' ||
      !Number.isFinite(Date.parse(record.recoveryNotBefore)) ||
      typeof record.heartbeatAt !== 'string' ||
      !Number.isFinite(Date.parse(record.heartbeatAt)) ||
      typeof record.leaseExpiresAt !== 'string' ||
      !Number.isFinite(Date.parse(record.leaseExpiresAt)) ||
      (record.releasedAt !== null && (
        typeof record.releasedAt !== 'string' ||
        !Number.isFinite(Date.parse(record.releasedAt))
      )) ||
      typeof record.leaseToken !== 'string' ||
      typeof record.agentName !== 'string' ||
      typeof record.filePath !== 'string' ||
      typeof record.isDatabaseMode !== 'boolean' ||
      typeof record.stateIncluded !== 'boolean' ||
      typeof record.previousAgentJson !== 'string' ||
      typeof record.intendedAgentJson !== 'string' ||
      !isJournalAgentJson(record.previousAgentJson, record.agentName) ||
      !isJournalAgentJson(record.intendedAgentJson, record.agentName) ||
      typeof record.previousDefinition !== 'string' ||
      typeof record.intendedDefinition !== 'string' ||
      !record.stateKey ||
      typeof record.stateKey.name !== 'string' ||
      typeof record.stateKey.agentElementId !== 'string' ||
      (record.stateKey.sessionId !== undefined && typeof record.stateKey.sessionId !== 'string') ||
      !('previousState' in record) ||
      !('intendedState' in record) ||
      !isJournalAgentState(record.previousState) ||
      !isJournalAgentState(record.intendedState)
  ) {
    throw new Error('Agent replacement journal has an invalid schema');
  }
  return record as AgentSnapshotReplacementRecord;
}

export function canonicalAgentMutationIdentity(name: string): string {
  const canonical = name
    .normalize('NFKC')
    .trim()
    .replaceAll(/([a-z])([A-Z])/g, '$1-$2')
    .replaceAll(/[\s_]+/gu, '-')
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-/g, '')
    .replaceAll(/-$/g, '');
  return canonical || 'unnamed';
}

function isJournalAgentJson(value: string, expectedName: string | undefined): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const metadata = (parsed as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
    const name = (metadata as { name?: unknown }).name;
    return typeof name === 'string' && name === expectedName;
  } catch {
    return false;
  }
}

function isJournalAgentState(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<AgentState>;
  return Array.isArray(state.goals) &&
    Array.isArray(state.decisions) &&
    !!state.context && typeof state.context === 'object' && !Array.isArray(state.context) &&
    (state.lastActive instanceof Date ||
      (typeof state.lastActive === 'string' && Number.isFinite(Date.parse(state.lastActive)))) &&
    typeof state.sessionCount === 'number' && Number.isSafeInteger(state.sessionCount) &&
    state.sessionCount >= 0 &&
    typeof state.stateVersion === 'number' && Number.isSafeInteger(state.stateVersion) &&
    state.stateVersion >= 0;
}
