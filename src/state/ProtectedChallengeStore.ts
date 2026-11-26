import { createHmac, timingSafeEqual } from 'node:crypto';
import type { StoredChallenge } from '@dollhousemcp/safety';
import type { AuditHmacKeyMaterial } from '../security/auditHmacKey.js';
import type { AuditHmacResolver } from '../security/toolRedaction.js';
import type { ChallengeMetadata, IChallengeStore } from './IChallengeStore.js';
import { isStateObject } from './persistence-utils.js';

export interface ChallengeKeyResolver extends AuditHmacResolver {
  resolveForKeyId?(keyId: string): Promise<AuditHmacKeyMaterial | null>;
}

export interface PersistedChallenge extends ChallengeMetadata {
  readonly keyId: string;
  readonly verifier: string;
}

const VERIFIER = /^[a-f0-9]{64}$/u;

export function hasLegacyChallengeCodes(rows: readonly unknown[]): boolean {
  return rows.some(row => Array.isArray(row) && isStateObject(row[1]) && Object.hasOwn(row[1], 'code'));
}

class ChallengeVerifier {
  private current?: AuditHmacKeyMaterial;
  private readonly keys = new Map<string, Buffer>();

  constructor(private readonly resolver: ChallengeKeyResolver, private readonly scope: string) {}

  async initialize(): Promise<void> {
    const current = await this.resolver.resolve();
    this.keys.set(current.keyId, current.key);
    this.current = current;
  }

  seal(id: string, challenge: StoredChallenge): PersistedChallenge {
    if (!this.current) throw new Error('Verification challenge storage is unavailable.');
    const { expiresAt, reason } = challenge;
    const metadata = { expiresAt, reason };
    return {
      ...metadata,
      keyId: this.current.keyId,
      verifier: this.digest(this.current.key, id, metadata, challenge.code).toString('hex'),
    };
  }

  private parseVerifier(value: unknown): PersistedChallenge | undefined {
    if (!isStateObject(value) || typeof value.reason !== 'string' || typeof value.expiresAt !== 'number' ||
        !Number.isFinite(value.expiresAt) || Date.now() > value.expiresAt ||
        typeof value.keyId !== 'string' || typeof value.verifier !== 'string' || !VERIFIER.test(value.verifier)) return undefined;
    const { expiresAt, reason, keyId, verifier } = value;
    return { expiresAt, reason, keyId, verifier };
  }

  async loadEntries(rows: readonly unknown[], allowLegacy = false): Promise<Map<string, PersistedChallenge>> {
    const candidates: [string, PersistedChallenge][] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[0]) continue;
      const [id, value] = row;
      const challenge = this.parseVerifier(value) ?? (allowLegacy ? this.migrate(id, value) : undefined);
      if (challenge) candidates.push([id, challenge]);
    }
    const historicalKeys = new Set(candidates.map(([, challenge]) => challenge.keyId).filter(id => !this.keys.has(id)));
    // Keep at most one historical key lookup in flight, regardless of snapshot size.
    await [...historicalKeys].reduce((previous, keyId) => previous.then(() => this.loadKey(keyId)), Promise.resolve());
    return new Map(candidates.filter(([, challenge]) => this.keys.has(challenge.keyId)));
  }

  private async loadKey(keyId: string): Promise<void> {
    const material = await this.resolver.resolveForKeyId?.(keyId);
    if (material?.keyId === keyId) this.keys.set(keyId, material.key);
  }

  private migrate(id: string, value: unknown): PersistedChallenge | undefined {
    if (!isStateObject(value) || Object.hasOwn(value, 'verifier')) return undefined;
    const { code, expiresAt, reason } = value;
    if (typeof code !== 'string' || !code || typeof reason !== 'string' || typeof expiresAt !== 'number' ||
        !Number.isFinite(expiresAt) || Date.now() > expiresAt) return undefined;
    return this.seal(id, { code, expiresAt, reason });
  }

  matches(id: string, challenge: PersistedChallenge, code: string): boolean {
    const key = this.keys.get(challenge.keyId);
    if (!key) return false;
    return timingSafeEqual(Buffer.from(challenge.verifier, 'hex'), this.digest(key, id, challenge, code));
  }

  private digest(key: Buffer, id: string, challenge: ChallengeMetadata, code: string): Buffer {
    const input = JSON.stringify(['danger-zone-challenge:v1', this.scope, id, challenge.expiresAt, challenge.reason, code]);
    return createHmac('sha256', key).update(input).digest();
  }
}

/** Shared challenge lifecycle for stores that persist a verifier. Each store owns its I/O. */
export abstract class ProtectedChallengeStore implements IChallengeStore {
  protected readonly verifier: ChallengeVerifier;
  private challenges = new Map<string, PersistedChallenge>();
  private readonly cleanupInterval?: NodeJS.Timeout;

  protected constructor(keys: ChallengeKeyResolver, scope: string, autoCleanupIntervalMs: number) {
    this.verifier = new ChallengeVerifier(keys, scope);
    if (autoCleanupIntervalMs > 0) {
      this.cleanupInterval = setInterval(() => this.cleanup(), autoCleanupIntervalMs);
      this.cleanupInterval.unref();
    }
  }

  protected abstract persistAsync(): void;

  protected replaceChallenges(challenges: Map<string, PersistedChallenge>): void {
    this.challenges = challenges;
  }

  protected challengeEntries(): [string, PersistedChallenge][] {
    return Array.from(this.challenges);
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
    if (!challenge || Date.now() <= challenge.expiresAt) return challenge;
    this.challenges.delete(challengeId);
    this.persistAsync();
    return undefined;
  }

  verify(challengeId: string, code: string): boolean {
    const challenge = this.lookup(challengeId);
    if (!challenge) return false;
    this.challenges.delete(challengeId);
    this.persistAsync();
    return this.verifier.matches(challengeId, challenge, code);
  }

  cleanup(): void {
    const now = Date.now();
    const before = this.challenges.size;
    for (const [id, challenge] of this.challenges) {
      if (now > challenge.expiresAt) this.challenges.delete(id);
    }
    if (this.challenges.size !== before) this.persistAsync();
  }

  clear(): void {
    this.challenges.clear();
    this.persistAsync();
  }

  size(): number {
    return this.challenges.size;
  }

  destroy(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
  }
}
