/**
 * InMemoryAuthStorageLayer
 *
 * Single-process, non-durable implementation of IAuthStorageLayer. All
 * state lives in Maps; nothing persists across restarts. Use the
 * filesystem (small-team / solo) or postgres (hosted / multi-instance)
 * backends from `createAuthStorage` for any deployment that needs
 * restart survival.
 *
 * Restricted to test environments and explicit operator opt-in via
 * `DOLLHOUSE_ALLOW_MEMORY_AUTH_STORAGE=true` — without that, methods
 * that require durable storage (local-account, magic-link) refuse to
 * start with this backend so operators don't silently lose
 * credentials on restart.
 *
 * Atomicity for refresh-token rotation and authorization-code single-use
 * is owned by oidc-provider, not this layer — this storage is a typed
 * K/V backend for the generic Adapter contract.
 *
 * @module auth/embedded-as/storage/InMemoryAuthStorageLayer
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../../../utils/logger.js';
import type {
  AllowlistAddInput,
  AllowlistMatchValues,
  AllowlistUpdatePatch,
  AuthAllowlistEntry,
  BootstrapState,
  IAuthStorageLayer,
  IdentityAuditEvent,
  IdentityEventFilter,
  StoredAccount,
} from './IAuthStorageLayer.js';
import { DEFAULT_IDENTITY_EVENTS_LIMIT } from './IAuthStorageLayer.js';

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

  // ---- Bootstrap state (must-fix #22) ----

  private bootstrapState: BootstrapState = { completed: false };

  async getBootstrapState(): Promise<BootstrapState> {
    return { ...this.bootstrapState };
  }

  async markBootstrapComplete(
    adminSub: string,
    adminMethod: 'local-password' | 'magic-link' | 'github',
  ): Promise<void> {
    if (this.bootstrapState.completed && this.bootstrapState.adminSub !== adminSub) {
      throw new Error(
        `bootstrap already completed for admin '${this.bootstrapState.adminSub}'; ` +
        `re-running with a different admin '${adminSub}' is rejected (admin transfer is a separate operation)`,
      );
    }
    this.bootstrapState = {
      completed: true,
      adminSub,
      adminMethod,
      completedAt: Date.now(),
    };
  }

  async updateAccountLastAuth(sub: string, lastAuthAt: number): Promise<boolean> {
    const existing = this.accountsBySub.get(sub);
    if (!existing) return false;
    // Single-process JS: read-write here is atomic against other
    // updateAccountLastAuth calls. Concurrent upsertAccount on the same
    // sub still races, but that's the caller's contract — this method
    // only protects the lastAuthAt+updatedAt pair against
    // upsertAccount-based last-write-wins.
    // updatedAt reflects when the row was last written, not when the user
    // last authenticated; the two are equal only when the caller passes
    // Date.now() as lastAuthAt (which is typical but not contractually
    // required).
    this.accountsBySub.set(sub, { ...existing, lastAuthAt, updatedAt: Date.now() });
    return true;
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

  async listIdentityEvents(filter?: IdentityEventFilter): Promise<IdentityAuditEvent[]> {
    let events = this.auditEvents;
    if (filter?.type) events = events.filter(e => e.type === filter.type);
    if (filter?.sub) events = events.filter(e => e.sub === filter.sub);
    if (filter?.since !== undefined) {
      const since = filter.since;
      events = events.filter(e => e.timestamp >= since);
    }
    // Defensive copy + stable sort; auditEvents is push-ordered so timestamps
    // are usually monotonic, but recordIdentityEvent permits caller-supplied
    // timestamps so a sort guards against out-of-order writes.
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
    // Cycle-12 fix: cap the result set to prevent the caller from
    // materializing a huge array. The InMemory backend is dev/test
    // only; the underlying `auditEvents` array is bounded by the test
    // fixture / dev session size, so the sort itself is not the OOM
    // concern (Postgres is — see PostgresAuthStorageLayer.ts which
    // applies the cap at SQL layer). Document the difference here.
    const limit = filter?.limit ?? DEFAULT_IDENTITY_EVENTS_LIMIT;
    return limit > 0 && sorted.length > limit ? sorted.slice(0, limit) : sorted;
  }

  // ---- Grants (Phase 5 H14 support) ----

  async findGrantsByAccountId(sub: string): Promise<string[]> {
    const grants: string[] = [];
    const now = Date.now();
    for (const [key, record] of this.genericStore.entries()) {
      if (!key.startsWith('Grant|')) continue;
      if (record.expiresAt && record.expiresAt <= now) continue;
      const payload = record.payload as { accountId?: string } | null;
      if (payload?.accountId === sub) {
        grants.push(key.slice('Grant|'.length));
      }
    }
    return grants;
  }

  // ---- Generic K/V (oidc-provider adapter sink) ----

  async genericGet(model: string, id: string): Promise<unknown> {
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

  async clearGenericByModels(models: readonly string[]): Promise<number> {
    const prefixes = new Set(models.map((m) => `${m}|`));
    let deleted = 0;
    for (const key of this.genericStore.keys()) {
      const sep = key.indexOf('|');
      if (sep < 0) continue;
      const model = key.slice(0, sep + 1);
      if (prefixes.has(model)) {
        this.genericStore.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async sweepExpiredKv(): Promise<number> {
    const now = Date.now();
    let deleted = 0;
    for (const [key, record] of this.genericStore.entries()) {
      if (record.expiresAt !== undefined && record.expiresAt <= now) {
        this.genericStore.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  /**
   * oidc-provider's Session model carries a `uid` field separate from the
   * adapter id; AccessToken / AuthorizationCode reference Session by uid.
   * Linear scan over the generic store; fine for in-memory dev volumes.
   * Map iteration tolerates concurrent delete (Node 22+ documented behavior),
   * which the inline GC pass relies on.
   */
  async genericFindByUid(uid: string): Promise<unknown> {
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

  /**
   * Delete the Grant entry itself (model='Grant', id=grantId) AND every
   * K/V entry whose payload references this grantId. Used by oidc-
   * provider's revoke flow and by H14's identity-change handler: an
   * account whose upstream identity moved must have its prior grant +
   * tokens + sessions invalidated atomically.
   */
  async genericInsertIfAbsent(
    model: string,
    id: string,
    payload: unknown,
    expiresInSec?: number,
  ): Promise<boolean> {
    const key = genericKey(model, id);
    const existing = this.genericStore.get(key);
    if (existing && (existing.expiresAt === undefined || existing.expiresAt > Date.now())) {
      return false;
    }
    this.genericStore.set(key, {
      payload,
      expiresAt: expiresInSec ? Date.now() + expiresInSec * 1000 : undefined,
    });
    return true;
  }

  async genericConsume(model: string, id: string): Promise<boolean> {
    const key = genericKey(model, id);
    const record = this.genericStore.get(key);
    if (!record) return false;
    if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      this.genericStore.delete(key);
      return false;
    }
    const payload = record.payload as (Record<string, unknown> & { consumed?: number }) | undefined;
    if (payload && typeof payload.consumed === 'number') return false;
    // Single-process JS: this read-write pair is atomic against other
    // genericConsume calls on the same key. Two truly-concurrent
    // genericConsume awaits resolve in submission order; only the first
    // sees `consumed` undefined and returns true.
    const next = { ...payload, consumed: Date.now() };
    this.genericStore.set(key, { ...record, payload: next });
    return true;
  }

  async genericRevokeByGrantId(grantId: string): Promise<void> {
    this.genericStore.delete(genericKey('Grant', grantId));
    // Map iteration with concurrent deletion is safe in V8 / Node 22+:
    // entries are visited in insertion order, deletions of already-
    // visited keys have no effect, deletions of not-yet-visited keys
    // remove them from the iteration. We only delete keys we just
    // visited via record.payload, so the visit-then-delete shape is
    // well-defined.
    for (const [key, record] of this.genericStore.entries()) {
      const payload = record.payload as { grantId?: string } | null;
      if (payload?.grantId === grantId) {
        this.genericStore.delete(key);
      }
    }
  }

  // ---- Sign-in allowlist ----

  private readonly allowlist = new Map<string, AuthAllowlistEntry>(); // id → entry
  private readonly allowlistByKindValue = new Map<string, string>();   // `${kind}|${value}` → id

  async allowlistList(): Promise<AuthAllowlistEntry[]> {
    return [...this.allowlist.values()].map(cloneEntry);
  }

  async allowlistFind(id: string): Promise<AuthAllowlistEntry | null> {
    const found = this.allowlist.get(id);
    return found ? cloneEntry(found) : null;
  }

  async allowlistAdd(input: AllowlistAddInput): Promise<AuthAllowlistEntry> {
    const value = input.value.toLowerCase();
    const idxKey = allowlistIndexKey(input.kind, value);
    if (this.allowlistByKindValue.has(idxKey)) {
      throw new Error(`allowlist entry already exists for kind=${input.kind} value=${value}`);
    }
    const entry: AuthAllowlistEntry = {
      id: randomUUID(),
      kind: input.kind,
      value,
      note: input.note ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: new Date(),
    };
    this.allowlist.set(entry.id, entry);
    this.allowlistByKindValue.set(idxKey, entry.id);
    return cloneEntry(entry);
  }

  async allowlistUpdate(id: string, patch: AllowlistUpdatePatch): Promise<AuthAllowlistEntry | null> {
    const found = this.allowlist.get(id);
    if (!found) return null;
    // Only `note` is mutable; kind/value remove+recreate.
    if (patch.note !== undefined) found.note = patch.note;
    return cloneEntry(found);
  }

  async allowlistRemove(id: string): Promise<boolean> {
    const found = this.allowlist.get(id);
    if (!found) return false;
    this.allowlist.delete(id);
    this.allowlistByKindValue.delete(allowlistIndexKey(found.kind, found.value));
    return true;
  }

  async allowlistMatchesIdentity(values: AllowlistMatchValues): Promise<boolean> {
    if (values.email && this.allowlistByKindValue.has(allowlistIndexKey('email', values.email.toLowerCase()))) {
      return true;
    }
    if (values.githubUsername && this.allowlistByKindValue.has(allowlistIndexKey('github_username', values.githubUsername.toLowerCase()))) {
      return true;
    }
    if (values.githubId && this.allowlistByKindValue.has(allowlistIndexKey('github_id', values.githubId))) {
      return true;
    }
    return false;
  }
}

function cloneEntry(entry: AuthAllowlistEntry): AuthAllowlistEntry {
  return { ...entry, createdAt: new Date(entry.createdAt) };
}

function allowlistIndexKey(kind: string, value: string): string {
  return `${kind}|${value}`;
}

function externalKey(provider: string, externalSub: string): string {
  return `${provider}|${externalSub}`;
}

function genericKey(model: string, id: string): string {
  return `${model}|${id}`;
}
