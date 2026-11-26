import { createHmac, timingSafeEqual } from 'node:crypto';
import type { StoredChallenge } from '@dollhousemcp/safety';
import type { AuditHmacKeyMaterial } from '../security/auditHmacKey.js';
import type { AuditHmacResolver } from '../security/toolRedaction.js';
import type { ChallengeMetadata } from './IChallengeStore.js';
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

export class ChallengeVerifier {
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

  private async load(value: unknown): Promise<PersistedChallenge | undefined> {
    if (!isStateObject(value) || typeof value.reason !== 'string' || typeof value.expiresAt !== 'number' ||
        !Number.isFinite(value.expiresAt) || Date.now() > value.expiresAt ||
        typeof value.keyId !== 'string' || typeof value.verifier !== 'string' || !VERIFIER.test(value.verifier)) return undefined;
    const { expiresAt, reason, keyId, verifier } = value;
    if (!this.keys.has(keyId)) {
      const material = await this.resolver.resolveForKeyId?.(keyId);
      if (!material || material.keyId !== keyId) return undefined;
      this.keys.set(keyId, material.key);
    }
    return { expiresAt, reason, keyId, verifier };
  }

  async loadEntries(rows: readonly unknown[], allowLegacy = false): Promise<Map<string, PersistedChallenge>> {
    const challenges = new Map<string, PersistedChallenge>();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[0]) continue;
      const [id, value] = row;
      const challenge = await this.load(value) ?? (allowLegacy ? this.migrate(id, value) : undefined);
      if (challenge) challenges.set(id, challenge);
    }
    return challenges;
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
