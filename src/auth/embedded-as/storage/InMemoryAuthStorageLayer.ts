/**
 * InMemoryAuthStorageLayer
 *
 * Solo-dev / single-process implementation of IAuthStorageLayer. All state
 * lives in Maps; nothing persists across restarts. Atomic operations use a
 * per-key mutex (KeyedLock) so concurrent rotateRefreshToken or
 * consumeAuthorizationCode calls for the same key serialize correctly.
 *
 * Use a DB-backed implementation (out of scope for the §8.1 PR) for any
 * multi-process or restart-survival deployment.
 *
 * @module auth/embedded-as/storage/InMemoryAuthStorageLayer
 */

import { logger } from '../../../utils/logger.js';
import type {
  IAuthStorageLayer,
  IdentityAuditEvent,
  RotationResult,
  StoredAccount,
  StoredAuthCode,
  StoredRefreshToken,
} from './IAuthStorageLayer.js';

interface GenericRecord {
  payload: unknown;
  expiresAt?: number;
}

/**
 * Per-key serialization. Calls to withLock(key, fn) for the same key run
 * one at a time, in the order they arrive. Different keys run concurrently.
 */
class KeyedLock<K> {
  private chains = new Map<K, Promise<void>>();

  async withLock<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const releasePromise = new Promise<void>(resolve => {
      release = resolve;
    });
    const myChain = previous.then(() => releasePromise);
    this.chains.set(key, myChain);

    try {
      await previous;
      return await fn();
    } finally {
      release();
      // Only delete the chain if no one else queued behind us.
      if (this.chains.get(key) === myChain) {
        this.chains.delete(key);
      }
    }
  }
}

export class InMemoryAuthStorageLayer implements IAuthStorageLayer {
  private readonly accountsBySub = new Map<string, StoredAccount>();
  private readonly accountIndexByExternal = new Map<string, string>(); // `${provider}|${externalSub}` → sub
  private readonly authCodes = new Map<string, StoredAuthCode>();
  private readonly refreshTokens = new Map<string, StoredRefreshToken>();
  private readonly revokedFamilies = new Set<string>();
  private readonly genericStore = new Map<string, GenericRecord>(); // `${model}|${id}` → record
  private readonly auditEvents: IdentityAuditEvent[] = [];

  private readonly authCodeLock = new KeyedLock<string>();
  private readonly refreshLock = new KeyedLock<string>();

  // ---- Accounts ----

  async findAccountByExternalId(provider: string, externalSub: string): Promise<StoredAccount | null> {
    const sub = this.accountIndexByExternal.get(externalKey(provider, externalSub));
    if (!sub) return null;
    return this.accountsBySub.get(sub) ?? null;
  }

  async upsertAccount(account: StoredAccount): Promise<void> {
    this.accountsBySub.set(account.sub, account);
    this.accountIndexByExternal.set(externalKey(account.provider, account.externalSub), account.sub);
  }

  async getAccount(sub: string): Promise<StoredAccount | null> {
    return this.accountsBySub.get(sub) ?? null;
  }

  // ---- Authorization codes ----

  async storeAuthorizationCode(code: StoredAuthCode): Promise<void> {
    this.authCodes.set(code.code, code);
  }

  async consumeAuthorizationCode(code: string): Promise<StoredAuthCode | null> {
    return this.authCodeLock.withLock(code, async () => {
      const record = this.authCodes.get(code);
      if (!record) return null;
      if (record.expiresAt <= Date.now()) {
        this.authCodes.delete(code);
        return null;
      }
      this.authCodes.delete(code);
      return record;
    });
  }

  // ---- Refresh tokens (atomic rotation + reuse detection) ----

  async storeRefreshToken(token: StoredRefreshToken): Promise<void> {
    this.refreshTokens.set(token.token, token);
  }

  async rotateRefreshToken(token: string, successor: StoredRefreshToken): Promise<RotationResult> {
    return this.refreshLock.withLock(token, async () => {
      const existing = this.refreshTokens.get(token);
      if (!existing) {
        return { kind: 'unknown' };
      }
      if (this.revokedFamilies.has(existing.familyId)) {
        // Family already revoked (likely from a prior reuse); treat as unknown.
        this.refreshTokens.delete(token);
        return { kind: 'unknown' };
      }
      if (existing.expiresAt <= Date.now()) {
        this.refreshTokens.delete(token);
        return { kind: 'unknown' };
      }

      // Successor must inherit the family for reuse-detection lineage.
      if (successor.familyId !== existing.familyId) {
        throw new Error(
          `Refresh successor must inherit familyId. Expected ${existing.familyId}, got ${successor.familyId}.`,
        );
      }

      // Atomic swap: delete the consumed token, insert the successor.
      this.refreshTokens.delete(token);
      this.refreshTokens.set(successor.token, successor);
      return { kind: 'rotated', successor };
    });
  }

  async revokeRefreshTokenFamily(familyId: string): Promise<void> {
    this.revokedFamilies.add(familyId);
    for (const [tokenValue, record] of this.refreshTokens.entries()) {
      if (record.familyId === familyId) {
        this.refreshTokens.delete(tokenValue);
      }
    }
  }

  // ---- Audit ----

  async recordIdentityEvent(event: IdentityAuditEvent): Promise<void> {
    this.auditEvents.push(event);
    logger.info('[AuthStorage] identity event', {
      type: event.type,
      sub: event.sub,
      provider: event.provider,
    });
  }

  /** Test/inspection helper. Not part of the IAuthStorageLayer contract. */
  __testGetAuditEvents(): IdentityAuditEvent[] {
    return [...this.auditEvents];
  }

  // ---- Generic K/V (oidc-provider adapter sink) ----

  async genericGet(model: string, id: string): Promise<unknown | null> {
    const record = this.genericStore.get(genericKey(model, id));
    if (!record) return null;
    if (record.expiresAt && record.expiresAt <= Date.now()) {
      this.genericStore.delete(genericKey(model, id));
      return null;
    }
    return record.payload;
  }

  async genericSet(model: string, id: string, payload: unknown, expiresInSec?: number): Promise<void> {
    const expiresAt = expiresInSec ? Date.now() + expiresInSec * 1000 : undefined;
    this.genericStore.set(genericKey(model, id), { payload, expiresAt });
  }

  async genericDestroy(model: string, id: string): Promise<void> {
    this.genericStore.delete(genericKey(model, id));
  }
}

function externalKey(provider: string, externalSub: string): string {
  return `${provider}|${externalSub}`;
}

function genericKey(model: string, id: string): string {
  return `${model}|${id}`;
}
