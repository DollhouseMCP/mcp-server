/**
 * FilesystemAuthStorageLayer
 *
 * Durable file-system backed implementation of IAuthStorageLayer.
 * Survives process restart. Default backend for non-DB deployments.
 *
 * **Path resolution is the caller's responsibility** — this class is
 * pure: it knows nothing about `~/.dollhouse/`, XDG, legacy detection,
 * or env var precedence. The factory (`createAuthStorage`) injects an
 * absolute `rootDir` resolved via `PathService.resolveDataDir('state')`
 * so the layer participates correctly in the legacy-vs-platform-default
 * scheme that `resolveDataDirectory` implements (see paths/PathService).
 *
 * Layout under `<rootDir>/`:
 *
 *   accounts.json           — JSON array of StoredAccount
 *   audit.jsonl             — newline-delimited IdentityAuditEvent (append-only)
 *   kv/<Model>/<id>.json    — one file per oidc-provider K/V entry,
 *                             payload shape `{ exp: number|null, value: unknown }`
 *
 * Concurrency:
 *   - Account read-modify-write protected by a file-resource lock keyed
 *     `auth:accounts`. Other readers see consistent snapshots between
 *     atomic-rename writes.
 *   - Audit appends use `fs.appendFile`, naturally append-only; we still
 *     hold a lock to prevent interleaved partial writes from concurrent
 *     callers.
 *   - K/V writes use `atomicWriteFile` (write-temp + rename); reads are
 *     plain reads. A torn read manifests as JSON parse failure → treat as
 *     missing, which matches the in-memory backend's "expired record"
 *     contract.
 *
 * Filename safety:
 *   - `model` is restricted to oidc-provider's known set (Session, Grant,
 *     Interaction, etc.) — we still sanitize to alphanumeric to refuse
 *     anything unexpected.
 *   - `id` is sanitized to base64url-compatible chars; oidc-provider
 *     generates these from `randomBytes`, but any caller-supplied string
 *     is rejected if it would write outside the kv/<Model>/ directory.
 *
 * @module auth/embedded-as/storage/FilesystemAuthStorageLayer
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../../../utils/logger.js';
import { FileLockManager } from '../../../security/fileLockManager.js';
import type {
  BootstrapState,
  IAuthStorageLayer,
  IdentityAuditEvent,
  IdentityEventFilter,
  StoredAccount,
} from './IAuthStorageLayer.js';

const SAFE_ID_RE = /^[A-Za-z0-9_\-]+$/;
const SAFE_MODEL_RE = /^[A-Za-z][A-Za-z0-9]*$/;

interface KvRecord {
  /** Epoch ms; null = no TTL. */
  exp: number | null;
  value: unknown;
}

export interface FilesystemAuthStorageLayerOptions {
  /**
   * Absolute path to the auth-storage root. The factory layer is
   * expected to compute this via `PathService.resolveDataDir('state')`
   * (typically yielding `<state>/auth/`); tests pass a tmpdir.
   */
  rootDir: string;
}

export class FilesystemAuthStorageLayer implements IAuthStorageLayer {
  readonly rootDir: string;
  private readonly accountsPath: string;
  private readonly auditPath: string;
  private readonly kvDir: string;
  private readonly bootstrapPath: string;
  private readonly locks = new FileLockManager();
  private initialized = false;

  constructor(options: FilesystemAuthStorageLayerOptions) {
    if (!path.isAbsolute(options.rootDir)) {
      throw new Error(
        `FilesystemAuthStorageLayer rootDir must be absolute, got: ${options.rootDir}`,
      );
    }
    this.rootDir = options.rootDir;
    this.accountsPath = path.join(this.rootDir, 'accounts.json');
    this.auditPath = path.join(this.rootDir, 'audit.jsonl');
    this.kvDir = path.join(this.rootDir, 'kv');
    this.bootstrapPath = path.join(this.rootDir, 'bootstrap.json');
  }

  // ---- Accounts (must-fix #18) ----

  async findAccountByExternalId(provider: string, externalSub: string): Promise<StoredAccount | null> {
    const accounts = await this.readAccounts();
    return accounts.find(a => a.provider === provider && a.externalSub === externalSub) ?? null;
  }

  async upsertAccount(account: StoredAccount): Promise<void> {
    await this.locks.withLock(`auth:accounts:${this.accountsPath}`, async () => {
      const accounts = await this.readAccountsRaw();
      const idx = accounts.findIndex(a => a.sub === account.sub);
      if (idx >= 0) accounts[idx] = account;
      else accounts.push(account);
      await this.ensureRoot();
      await this.locks.atomicWriteFile(this.accountsPath, JSON.stringify(accounts, null, 2));
    });
  }

  async getAccount(sub: string): Promise<StoredAccount | null> {
    const accounts = await this.readAccounts();
    return accounts.find(a => a.sub === sub) ?? null;
  }

  async updateAccountLastAuth(sub: string, lastAuthAt: number): Promise<boolean> {
    return this.locks.withLock(`auth:accounts:${this.accountsPath}`, async () => {
      const accounts = await this.readAccountsRaw();
      const idx = accounts.findIndex(a => a.sub === sub);
      if (idx < 0) return false;
      // Surgical update under the same lock that guards upsertAccount —
      // protects the lastAuthAt write from being clobbered by a
      // concurrent upsert that re-writes the row from a stale read.
      accounts[idx] = { ...accounts[idx]!, lastAuthAt, updatedAt: lastAuthAt };
      await this.ensureRoot();
      await this.locks.atomicWriteFile(this.accountsPath, JSON.stringify(accounts, null, 2));
      return true;
    });
  }

  async setAccountRoles(sub: string, roles: string[]): Promise<boolean> {
    return this.locks.withLock(`auth:accounts:${this.accountsPath}`, async () => {
      const accounts = await this.readAccountsRaw();
      const idx = accounts.findIndex(a => a.sub === sub);
      if (idx < 0) return false;
      const next: StoredAccount = {
        ...accounts[idx]!,
        updatedAt: Date.now(),
      };
      // Empty array → drop the field entirely so the on-disk shape
      // matches what upsertAccount({...account /* no roles */}) would
      // produce. Keeps round-trip parity with InMemory + Postgres.
      if (roles.length > 0) {
        next.roles = [...roles];
      } else {
        delete next.roles;
      }
      accounts[idx] = next;
      await this.ensureRoot();
      await this.locks.atomicWriteFile(this.accountsPath, JSON.stringify(accounts, null, 2));
      return true;
    });
  }

  // ---- Bootstrap state (must-fix #22) ----

  async getBootstrapState(): Promise<BootstrapState> {
    return this.locks.withLock(`auth:bootstrap:${this.bootstrapPath}`, async () => {
      try {
        const raw = await fs.readFile(this.bootstrapPath, 'utf-8');
        const parsed = JSON.parse(raw) as BootstrapState;
        // Defensive: fail to "not bootstrapped" rather than to "open" if the
        // file is malformed. The gate stays closed, the operator sees the
        // 503 + actionable message and re-runs the CLI.
        if (typeof parsed?.completed !== 'boolean') return { completed: false };
        return parsed;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { completed: false };
        }
        throw err;
      }
    });
  }

  async markBootstrapComplete(
    adminSub: string,
    adminMethod: 'local-password' | 'magic-link' | 'github',
  ): Promise<void> {
    await this.locks.withLock(`auth:bootstrap:${this.bootstrapPath}`, async () => {
      // Read-modify-write under the lock so concurrent CLI runs serialize.
      // (Unlikely in practice — the CLI is a one-shot invocation — but the
      // lock pattern is consistent with the rest of the layer.)
      let existing: BootstrapState = { completed: false };
      try {
        const raw = await fs.readFile(this.bootstrapPath, 'utf-8');
        existing = JSON.parse(raw) as BootstrapState;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      if (existing.completed && existing.adminSub !== adminSub) {
        throw new Error(
          `bootstrap already completed for admin '${existing.adminSub}'; ` +
          `re-running with a different admin '${adminSub}' is rejected (admin transfer is a separate operation)`,
        );
      }

      const next: BootstrapState = {
        completed: true,
        adminSub,
        adminMethod,
        completedAt: Date.now(),
      };
      await this.ensureRoot();
      await this.locks.atomicWriteFile(this.bootstrapPath, JSON.stringify(next, null, 2));
    });
  }

  // ---- Audit (must-fix #21) ----

  async recordIdentityEvent(event: IdentityAuditEvent): Promise<void> {
    await this.locks.withLock(`auth:audit:${this.auditPath}`, async () => {
      await this.ensureRoot();
      await fs.appendFile(this.auditPath, `${JSON.stringify(event)}\n`, 'utf8');
    });
    logger.info('[AuthStorage:fs] identity event', {
      type: event.type,
      sub: event.sub,
      provider: event.provider,
    });
  }

  async listIdentityEvents(filter?: IdentityEventFilter): Promise<IdentityAuditEvent[]> {
    const events = await this.readAudit();
    let filtered = events;
    if (filter?.type) filtered = filtered.filter(e => e.type === filter.type);
    if (filter?.sub) filtered = filtered.filter(e => e.sub === filter.sub);
    if (filter?.since !== undefined) {
      const since = filter.since;
      filtered = filtered.filter(e => e.timestamp >= since);
    }
    return filtered.slice().sort((a, b) => a.timestamp - b.timestamp);
  }

  // ---- Grants (Phase 5 H14) ----

  async findGrantsByAccountId(sub: string): Promise<string[]> {
    const grantDir = this.modelDir('Grant');
    let entries: string[];
    try {
      entries = await fs.readdir(grantDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const ids: string[] = [];
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      const record = await this.readKv('Grant', id);
      if (!record) continue;
      if (record.exp !== null && record.exp <= now) continue;
      const payload = record.value as { accountId?: string } | null;
      if (payload && payload.accountId === sub) ids.push(id);
    }
    return ids;
  }

  // ---- Generic K/V (oidc-provider adapter sink) ----

  async genericGet(model: string, id: string): Promise<unknown | null> {
    // Defense in depth: assert at the public surface in addition to the
    // internal `readKv` check. Keeps the path-traversal guarantee from
    // depending on a private helper a future refactor might bypass.
    assertSafeModel(model);
    assertSafeId(id);
    const record = await this.readKv(model, id);
    if (!record) return null;
    if (record.exp !== null && record.exp <= Date.now()) {
      // Lazy expiry: clean up while we're here. Best-effort.
      void this.unlinkKv(model, id);
      return null;
    }
    return record.value;
  }

  async genericSet(model: string, id: string, payload: unknown, expiresInSec?: number): Promise<void> {
    assertSafeModel(model);
    assertSafeId(id);
    const record: KvRecord = {
      exp: expiresInSec ? Date.now() + expiresInSec * 1000 : null,
      value: payload,
    };
    const filePath = this.kvPath(model, id);
    await this.locks.withLock(`auth:kv:${filePath}`, async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await this.locks.atomicWriteFile(filePath, JSON.stringify(record));
    });
  }

  async genericDestroy(model: string, id: string): Promise<void> {
    assertSafeModel(model);
    assertSafeId(id);
    await this.unlinkKv(model, id);
  }

  async genericInsertIfAbsent(
    model: string,
    id: string,
    payload: unknown,
    expiresInSec?: number,
  ): Promise<boolean> {
    assertSafeModel(model);
    assertSafeId(id);
    const filePath = this.kvPath(model, id);
    return this.locks.withLock(`auth:kv:${filePath}`, async () => {
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const existing = JSON.parse(raw) as KvRecord;
        if (existing.exp === null || existing.exp > Date.now()) {
          return false;
        }
        // Expired record present — fall through to overwrite.
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // Not present — proceed with insert.
      }
      const record: KvRecord = {
        exp: expiresInSec ? Date.now() + expiresInSec * 1000 : null,
        value: payload,
      };
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await this.locks.atomicWriteFile(filePath, JSON.stringify(record));
      return true;
    });
  }

  async genericConsume(model: string, id: string): Promise<boolean> {
    assertSafeModel(model);
    assertSafeId(id);
    const filePath = this.kvPath(model, id);
    return this.locks.withLock(`auth:kv:${filePath}`, async () => {
      let record: KvRecord;
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        record = JSON.parse(raw) as KvRecord;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
      if (record.exp !== null && record.exp <= Date.now()) {
        return false;
      }
      const value = record.value as Record<string, unknown> & { consumed?: number };
      if (value && typeof value.consumed === 'number') return false;
      // Same lock that guards genericSet — this read-modify-write is
      // serialized against any concurrent set/destroy/consume on the
      // same record. Two simultaneous consume() calls cannot both
      // observe an unconsumed record and both report success.
      const next: KvRecord = {
        exp: record.exp,
        value: { ...(value ?? {}), consumed: Date.now() },
      };
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await this.locks.atomicWriteFile(filePath, JSON.stringify(next));
      return true;
    });
  }

  async genericRevokeByGrantId(grantId: string): Promise<void> {
    // Delete the Grant entry itself. Then scan every model directory
    // and remove entries whose payload references grantId. Tokens,
    // sessions, and codes can all reference a grant.
    if (SAFE_ID_RE.test(grantId)) {
      await this.unlinkKv('Grant', grantId);
    }
    let entries: string[];
    try {
      entries = await fs.readdir(this.kvDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const model of entries) {
      // Skip non-directory entries defensively.
      if (!SAFE_MODEL_RE.test(model)) continue;
      let ids: string[];
      try {
        ids = await fs.readdir(path.join(this.kvDir, model));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      for (const idFile of ids) {
        if (!idFile.endsWith('.json')) continue;
        const id = idFile.slice(0, -'.json'.length);
        // A single malformed/orphan file in the kv directory must not
        // abort the entire revoke — without this guard, one bad file
        // permanently blocks H14 grant revocation. assertSafeId throws
        // in readKv on suspicious names; readJSON throws on parse fail.
        let record;
        try {
          record = await this.readKv(model, id);
        } catch (err) {
          logger.warn('[FilesystemAuthStorageLayer] skipping unreadable kv file during grant revoke', {
            model, id, error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (!record) continue;
        const payload = record.value as { grantId?: string } | null;
        if (payload && payload.grantId === grantId) {
          await this.unlinkKv(model, id);
        }
      }
    }
  }

  async clearGenericByModels(models: readonly string[]): Promise<number> {
    let deleted = 0;
    for (const model of models) {
      assertSafeModel(model);
      const dir = this.modelDir(model);
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          await fs.unlink(path.join(dir, entry));
          deleted += 1;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    }
    return deleted;
  }

  /**
   * Linear scan over the Session model. Tolerated cost given solo/team
   * deployment volumes; the Postgres backend should index `uid`.
   */
  async genericFindByUid(uid: string): Promise<unknown | null> {
    const sessionDir = this.modelDir('Session');
    let entries: string[];
    try {
      entries = await fs.readdir(sessionDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      const record = await this.readKv('Session', id);
      if (!record) continue;
      if (record.exp !== null && record.exp <= now) continue;
      const payload = record.value as { uid?: string } | null;
      if (payload && payload.uid === uid) return record.value;
    }
    return null;
  }

  // ---- internals ----

  /**
   * Public for tests + factory diagnostics; idempotent.
   */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.ensureRoot();
    this.initialized = true;
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
  }

  private async readAccounts(): Promise<StoredAccount[]> {
    return this.locks.withLock(`auth:accounts:${this.accountsPath}`, () => this.readAccountsRaw());
  }

  private async readAccountsRaw(): Promise<StoredAccount[]> {
    try {
      const raw = await fs.readFile(this.accountsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        logger.warn('[AuthStorage:fs] accounts.json is not an array; treating as empty', {
          path: this.accountsPath,
        });
        return [];
      }
      return parsed as StoredAccount[];
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      if (err instanceof SyntaxError) {
        logger.warn('[AuthStorage:fs] accounts.json failed to parse; treating as empty', {
          path: this.accountsPath,
          error: err.message,
        });
        return [];
      }
      throw err;
    }
  }

  private async readAudit(): Promise<IdentityAuditEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.auditPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const events: IdentityAuditEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as IdentityAuditEvent);
      } catch {
        // Tolerate a torn last-line write; ignore and continue.
      }
    }
    return events;
  }

  private async readKv(model: string, id: string): Promise<KvRecord | null> {
    assertSafeModel(model);
    assertSafeId(id);
    try {
      const raw = await fs.readFile(this.kvPath(model, id), 'utf8');
      return JSON.parse(raw) as KvRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Treat parse error as missing — same contract as expired entries.
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  private async unlinkKv(model: string, id: string): Promise<void> {
    assertSafeModel(model);
    assertSafeId(id);
    try {
      await fs.unlink(this.kvPath(model, id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  private kvPath(model: string, id: string): string {
    return path.join(this.kvDir, model, `${id}.json`);
  }

  private modelDir(model: string): string {
    return path.join(this.kvDir, model);
  }
}

function assertSafeModel(model: string): void {
  if (!SAFE_MODEL_RE.test(model)) {
    throw new Error(`unsafe model name: ${JSON.stringify(model)}`);
  }
}

function assertSafeId(id: string): void {
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`unsafe id: ${JSON.stringify(id)}`);
  }
}
