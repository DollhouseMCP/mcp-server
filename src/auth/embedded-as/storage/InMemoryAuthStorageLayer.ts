/**
 * InMemoryAuthStorageLayer
 *
 * Solo-dev / single-process implementation of IAuthStorageLayer. All
 * state lives in Maps; nothing persists across restarts. Use a DB-backed
 * implementation (out of scope for the §8.1 PR) for any multi-process
 * or restart-survival deployment.
 *
 * Atomicity for refresh-token rotation and authorization-code single-use
 * is owned by oidc-provider, not this layer — this storage is a typed
 * K/V backend for the generic Adapter contract.
 *
 * @module auth/embedded-as/storage/InMemoryAuthStorageLayer
 */

import { logger } from '../../../utils/logger.js';
import type {
  IAuthStorageLayer,
  IdentityAuditEvent,
  StoredAccount,
} from './IAuthStorageLayer.js';

interface GenericRecord {
  payload: unknown;
  expiresAt?: number;
}

export class InMemoryAuthStorageLayer implements IAuthStorageLayer {
  private readonly accountsBySub = new Map<string, StoredAccount>();
  private readonly accountIndexByExternal = new Map<string, string>(); // `${provider}|${externalSub}` → sub
  private readonly genericStore = new Map<string, GenericRecord>(); // `${model}|${id}` → record
  private readonly auditEvents: IdentityAuditEvent[] = [];

  // ---- Accounts (must-fix #18) ----

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

  // ---- Audit (must-fix #21) ----

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

  /**
   * oidc-provider's Session model carries a `uid` field separate from the
   * adapter id; AccessToken / AuthorizationCode reference Session by uid.
   * Linear scan over the generic store; fine for in-memory dev volumes.
   * Map iteration tolerates concurrent delete (Node 22+ documented behavior),
   * which the inline GC pass relies on.
   */
  async genericFindByUid(uid: string): Promise<unknown | null> {
    const now = Date.now();
    for (const [key, record] of this.genericStore.entries()) {
      if (record.expiresAt && record.expiresAt <= now) {
        this.genericStore.delete(key);
        continue;
      }
      const payload = record.payload as { uid?: string } | null;
      if (payload && typeof payload === 'object' && payload.uid === uid) {
        return record.payload;
      }
    }
    return null;
  }
}

function externalKey(provider: string, externalSub: string): string {
  return `${provider}|${externalSub}`;
}

function genericKey(model: string, id: string): string {
  return `${model}|${id}`;
}
