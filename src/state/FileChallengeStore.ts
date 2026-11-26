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
import type { StoredChallenge } from '@dollhousemcp/safety';
import type { ChallengeMetadata, IChallengeStore } from './IChallengeStore.js';
import { ChallengeVerifier, hasLegacyChallengeCodes, type ChallengeKeyResolver, type PersistedChallenge } from './challenge-verifier.js';
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

export class FileChallengeStore implements IChallengeStore {
  private readonly fileOps: FileOperationsService;
  private readonly stateDir: string;
  private readonly sessionId: string;
  private readonly persistPath: string;

  private challenges = new Map<string, PersistedChallenge>();
  private readonly verifier: ChallengeVerifier;
  private readonly persistQueue: PersistQueue;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    fileOps: FileOperationsService,
    keyResolver: ChallengeKeyResolver,
    stateDir?: string,
    sessionId?: string,
    autoCleanupIntervalMs: number = 60000,
  ) {
    this.fileOps = fileOps;
    this.sessionId = sessionId
      ? validateExternalSessionId(sessionId)
      : 'default';
    this.stateDir = stateDir ?? path.join(os.homedir(), '.dollhouse', 'state');
    this.persistPath = path.join(this.stateDir, `challenges-${this.sessionId}.json`);
    this.verifier = new ChallengeVerifier(keyResolver, this.persistPath);
    this.persistQueue = new PersistQueue({ storeName: STORE_NAME, stateType: 'challenge state', sessionId: this.sessionId });

    if (autoCleanupIntervalMs > 0) {
      this.cleanupInterval = setInterval(() => {
        this.cleanup();
      }, autoCleanupIntervalMs);

      if (this.cleanupInterval.unref) {
        this.cleanupInterval.unref();
      }
    }
  }

  /**
   * Load persisted challenges from disk.
   * Drops expired entries on load.
   */
  async initialize(): Promise<void> {
    try {
      await this.verifier.initialize();
      const data = await this.readSnapshot();
      this.challenges = this.needsRewrite(data)
        ? await this.fileOps.withWriteLock(this.persistPath, async () => this.restore(await this.readSnapshot()))
        : await this.restore(data);
      if (this.challenges.size > 0) {
        logger.info(`[FileChallengeStore] Restored ${this.challenges.size} challenge(s) for session '${this.sessionId}'`);
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
    if (this.needsRewrite(data)) await this.persistToDisk(challenges);
    return challenges;
  }

  set(challengeId: string, challenge: StoredChallenge): void {
    this.challenges.set(challengeId, this.verifier.seal(challengeId, challenge));
    this.persistAsync();
  }

  get(challengeId: string): ChallengeMetadata | undefined {
    const challenge = this.lookup(challengeId);
    return challenge && { expiresAt: challenge.expiresAt, reason: challenge.reason };
  }

  private lookup(challengeId: string): PersistedChallenge | undefined {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return undefined;

    if (Date.now() > challenge.expiresAt) {
      this.challenges.delete(challengeId);
      this.persistAsync();
      return undefined;
    }

    return challenge;
  }

  verify(challengeId: string, code: string): boolean {
    const challenge = this.lookup(challengeId);
    if (!challenge) return false;

    // Delete challenge after verification attempt (one-time use)
    this.challenges.delete(challengeId);
    this.persistAsync();

    return this.verifier.matches(challengeId, challenge, code);
  }

  cleanup(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, challenge] of this.challenges.entries()) {
      if (now > challenge.expiresAt) {
        this.challenges.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.persistAsync();
    }
  }

  clear(): void {
    this.challenges.clear();
    this.persistAsync();
  }

  size(): number {
    return this.challenges.size;
  }

  awaitPendingWrites(): Promise<void> {
    return this.persistQueue.awaitPending();
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  // ── Private persistence methods ───────────────────────────────────

  private persistAsync(): void {
    this.persistQueue.enqueueFireAndForget(async () => {
      await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      await this.fileOps.withWriteLock(this.persistPath, () => this.persistToDisk(this.challenges));
    });
  }

  private async persistToDisk(challenges: ReadonlyMap<string, PersistedChallenge>): Promise<void> {
    const state: PersistedChallengeState = {
      version: 2,
      sessionId: this.sessionId,
      lastUpdated: new Date().toISOString(),
      challenges: Array.from(challenges.entries()),
    };

    await this.fileOps.writeFile(this.persistPath, JSON.stringify(state, null, 2));
    await this.fileOps.chmod(this.persistPath, 0o600);
  }
}
