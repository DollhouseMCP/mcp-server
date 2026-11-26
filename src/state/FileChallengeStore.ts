/**
 * File-Backed Challenge Store
 *
 * Persists verification challenge state to JSON files.
 * Each session gets its own file: ~/.dollhouse/state/challenges-{sessionId}.json
 *
 * In-memory Map is the hot path (same as VerificationStore). Disk writes
 * are fire-and-forget — they never block verification operations.
 *
 * @since v2.1.0 — Issue #1945
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';
import { ProtectedChallengeStore, hasLegacyChallengeCodes, type ChallengeKeyResolver, type PersistedChallenge } from './ProtectedChallengeStore.js';
import { validateExternalSessionId } from './FileActivationStateStore.js';
import { isStateObject, logPersistedStateIssue, readPersistedState, type PersistedStateRead } from './persistence-utils.js';
import { PersistQueue } from './PersistQueue.js';

// ── Constants ───────────────────────────────────────────────────────

const STORE_NAME = 'FileChallengeStore';

// ── Persisted File Format ───────────────────────────────────────────

interface PersistedChallengeState {
  version: number;
  sessionId: string;
  lastUpdated: string;
  challenges: Array<[string, PersistedChallenge]>;
}

type SnapshotRead = PersistedStateRead<{ version: number; challenges: unknown[] }>;

// ── Implementation ──────────────────────────────────────────────────

export class FileChallengeStore extends ProtectedChallengeStore {
  private readonly fileOps: FileOperationsService;
  private readonly stateDir: string;
  private readonly sessionId: string;
  private readonly persistPath: string;

  private readonly persistQueue: PersistQueue;

  constructor(
    fileOps: FileOperationsService,
    keyResolver: ChallengeKeyResolver,
    stateDir?: string,
    sessionId?: string,
    autoCleanupIntervalMs: number = 60000,
  ) {
    const id = sessionId ? validateExternalSessionId(sessionId) : 'default';
    const directory = stateDir ?? path.join(os.homedir(), '.dollhouse', 'state');
    const filename = path.join(directory, `challenges-${id}.json`);
    super(keyResolver, filename, autoCleanupIntervalMs);
    this.fileOps = fileOps;
    this.sessionId = id;
    this.stateDir = directory;
    this.persistPath = filename;
    this.persistQueue = new PersistQueue({ storeName: STORE_NAME, stateType: 'challenge state', sessionId: this.sessionId });
  }

  /**
   * Load persisted challenges from disk.
   * Drops expired entries on load.
   */
  async initialize(): Promise<void> {
    try {
      await this.verifier.initialize();
      const data = await this.readSnapshot();
      const challenges = this.needsRewrite(data)
        ? await this.fileOps.withWriteLock(this.persistPath, async () => this.restore(await this.readSnapshot()))
        : await this.restore(data);
      this.replaceChallenges(challenges);
      if (challenges.size > 0) {
        logger.info(`[FileChallengeStore] Restored ${challenges.size} challenge(s) for session '${this.sessionId}'`);
      }
    } catch {
      logPersistedStateIssue('invalid', STORE_NAME, this.sessionId);
    }
  }

  private readSnapshot(): Promise<SnapshotRead> {
    return readPersistedState(() => this.fileOps.readFile(this.persistPath), value => {
      if (!isStateObject(value) || typeof value.version !== 'number' || !Array.isArray(value.challenges)) {
        throw new Error('Invalid challenge state');
      }
      return { version: value.version, challenges: value.challenges };
    });
  }

  private needsRewrite(data: SnapshotRead): boolean {
    return data.status === 'loaded' &&
      (data.value.version === 1 || (data.value.version === 2 && hasLegacyChallengeCodes(data.value.challenges)));
  }

  private async restore(data: SnapshotRead): Promise<Map<string, PersistedChallenge>> {
    if (data.status !== 'loaded') {
      if (data.status !== 'absent') logPersistedStateIssue(data.status, STORE_NAME, this.sessionId);
      return new Map();
    }
    const { version, challenges: entries } = data.value;
    if (version !== 1 && version !== 2) {
      logPersistedStateIssue('unsupportedVersion', STORE_NAME, this.sessionId);
      return new Map();
    }
    const challenges = await this.verifier.loadEntries(entries, version === 1);
    if (this.needsRewrite(data)) await this.persistToDisk(Array.from(challenges));
    return challenges;
  }

  awaitPendingWrites(): Promise<void> {
    return this.persistQueue.awaitPending();
  }

  // ── Private persistence methods ───────────────────────────────────

  protected persistAsync(): void {
    this.persistQueue.enqueueFireAndForget(async () => {
      await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      await this.fileOps.withWriteLock(this.persistPath, () => this.persistToDisk(this.challengeEntries()));
    });
  }

  private async persistToDisk(challenges: [string, PersistedChallenge][]): Promise<void> {
    const state: PersistedChallengeState = {
      version: 2,
      sessionId: this.sessionId,
      lastUpdated: new Date().toISOString(),
      challenges,
    };

    await this.fileOps.writeFile(this.persistPath, JSON.stringify(state, null, 2));
    await this.fileOps.chmod(this.persistPath, 0o600);
  }
}
