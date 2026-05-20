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

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../../../utils/logger.js';
import { FileLockManager } from '../../../security/fileLockManager.js';
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

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
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
  private readonly allowlistPath: string;
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
    this.allowlistPath = path.join(this.rootDir, 'allowlist.json');
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
      accounts[idx] = { ...accounts[idx], lastAuthAt, updatedAt: Date.now() };
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
        ...accounts[idx],
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
      // Cycle-16 fix: layer OS-level atomic create on top of the
      // in-process lock so concurrent `dollhouse-admin-bootstrap`
      // processes (different PIDs, separate in-process locks) can't
      // both succeed and last-writer-wins. Try to create the bootstrap
      // file with O_CREAT|O_EXCL; if EEXIST fires, read what's there
      // and validate adminSub matches before treating as a no-op.
      const next: BootstrapState = {
        completed: true,
        adminSub,
        adminMethod,
        completedAt: Date.now(),
      };
      const serialized = JSON.stringify(next, null, 2);

      await this.ensureRoot();
      try {
        const handle = await fs.open(this.bootstrapPath, 'wx', 0o600);
        try {
          await handle.write(serialized);
        } finally {
          await handle.close();
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }

      // File already exists. Read it, parse, and validate that we're
      // re-claiming the SAME admin (idempotent re-run), not transferring.
      const raw = await fs.readFile(this.bootstrapPath, 'utf-8');
      let existing: BootstrapState;
      try {
        existing = JSON.parse(raw) as BootstrapState;
      } catch {
        // Corrupt or partial file — treat as absent and rewrite.
        await this.locks.atomicWriteFile(this.bootstrapPath, serialized);
        return;
      }
      if (existing.completed && existing.adminSub !== adminSub) {
        throw new Error(
          `bootstrap already completed for admin '${existing.adminSub}'; ` +
          `re-running with a different admin '${adminSub}' is rejected (admin transfer is a separate operation)`,
        );
      }
      // Same admin, idempotent re-run — refresh completedAt and method
      // (a same-admin re-run with a different method is allowed and is
      // the path the CLI takes when adding a second method).
      await this.locks.atomicWriteFile(this.bootstrapPath, serialized);
    });
  }

  // ---- Audit (must-fix #21) ----

  /**
   * Cycle-16 fix (HIGH): rotate audit.jsonl when it grows past this
   * size. Without rotation, listIdentityEvents would eventually load
   * gigabytes into memory (the whole file is read on every call).
   * 50 MB ≈ 100k events worth of moderately-sized JSON; far above
   * normal volume but caps the worst case.
   */
  private static readonly AUDIT_ROTATION_THRESHOLD_BYTES = 50 * 1024 * 1024;

  async recordIdentityEvent(event: IdentityAuditEvent): Promise<void> {
    await this.locks.withLock(`auth:audit:${this.auditPath}`, async () => {
      await this.ensureRoot();
      // Rotate before append when the current file is past threshold.
      // Standard log-rotation shape: rename audit.jsonl → audit.jsonl.1,
      // then start a fresh file. The .1 file is preserved for offline
      // analysis; operators can sweep it on their own retention policy.
      try {
        const stat = await fs.stat(this.auditPath);
        if (stat.size >= FilesystemAuthStorageLayer.AUDIT_ROTATION_THRESHOLD_BYTES) {
          const archived = `${this.auditPath}.1`;
          await fs.rename(this.auditPath, archived).catch(() => undefined);
          logger.info('[AuthStorage:fs] audit log rotated', {
            from: this.auditPath, to: archived, sizeBytes: stat.size,
          });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
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
    const sorted = filtered.slice().sort((a, b) => a.timestamp - b.timestamp);
    // Cycle-12 fix: cap result set (audit log grows unbounded over
    // deployment lifetime).
    const limit = filter?.limit ?? DEFAULT_IDENTITY_EVENTS_LIMIT;
    return limit > 0 && sorted.length > limit ? sorted.slice(0, limit) : sorted;
  }

  // ---- Grants (Phase 5 H14) ----

  async findGrantsByAccountId(sub: string): Promise<string[]> {
    const entries = await this.safelyListJsonEntries(this.modelDir('Grant'));
    if (entries.length === 0) return [];
    const now = Date.now();
    const ids: string[] = [];
    for (const entry of entries) {
      const id = entry.slice(0, -'.json'.length);
      const matched = await this.grantBelongsTo(id, sub, now);
      if (matched) ids.push(id);
    }
    return ids;
  }

  /**
   * Cycle-16 sibling-fix: tolerate a single unreadable / malformed Grant
   * file the same way `genericRevokeByGrantId` does. Without this, a
   * stray non-base64url file in kv/Grant/ throws from the first `readKv`
   * call and breaks every GitHub login.
   */
  private async grantBelongsTo(id: string, sub: string, now: number): Promise<boolean> {
    let record: KvRecord | null;
    try {
      record = await this.readKv('Grant', id);
    } catch (err) {
      logger.warn('[FilesystemAuthStorageLayer] skipping unreadable Grant file', {
        id, error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (!record) return false;
    if (record.exp !== null && record.exp <= now) return false;
    const payload = record.value as { accountId?: string } | null;
    return payload?.accountId === sub;
  }

  /**
   * List `.json` files in a kv directory, tolerating ENOENT (the directory
   * doesn't exist yet because nothing's been written to that model).
   * Other errors propagate. Used by sweep/scan operations that walk one
   * kv subdirectory and must distinguish "empty/uninitialized" from
   * "filesystem broken".
   */
  private async safelyListJsonEntries(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir);
      return entries.filter(e => e.endsWith('.json'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  // ---- Generic K/V (oidc-provider adapter sink) ----

  async genericGet(model: string, id: string): Promise<unknown> {
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
    const models = await this.listModelDirs();
    for (const model of models) {
      await this.revokeModelEntriesReferencingGrant(model, grantId);
    }
  }

  private async listModelDirs(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.kvDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    // Skip non-directory entries defensively.
    return entries.filter(m => SAFE_MODEL_RE.test(m));
  }

  private async revokeModelEntriesReferencingGrant(model: string, grantId: string): Promise<void> {
    const ids = await this.safelyListJsonEntries(path.join(this.kvDir, model));
    for (const idFile of ids) {
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
      if (payload?.grantId === grantId) {
        await this.unlinkKv(model, id);
      }
    }
  }

  async clearGenericByModels(models: readonly string[]): Promise<number> {
    let deleted = 0;
    for (const model of models) {
      assertSafeModel(model);
      deleted += await this.clearOneModel(model);
    }
    return deleted;
  }

  private async clearOneModel(model: string): Promise<number> {
    const dir = this.modelDir(model);
    const entries = await this.safelyListJsonEntries(dir);
    let deleted = 0;
    for (const entry of entries) {
      try {
        await fs.unlink(path.join(dir, entry));
        deleted += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return deleted;
  }

  async sweepExpiredKv(): Promise<number> {
    const kvRoot = path.join(this.rootDir, 'kv');
    const modelDirs = await this.safelyListDirectory(kvRoot);
    const now = Date.now();
    let deleted = 0;
    for (const model of modelDirs) {
      deleted += await this.sweepExpiredKvInModel(kvRoot, model, now);
    }
    return deleted;
  }

  private async sweepExpiredKvInModel(kvRoot: string, model: string, now: number): Promise<number> {
    const dir = path.join(kvRoot, model);
    const entries = await this.safelyListJsonEntries(dir);
    let deleted = 0;
    for (const entry of entries) {
      const id = entry.slice(0, -'.json'.length);
      if (await this.deleteIfExpired(model, id, dir, entry, now)) deleted += 1;
    }
    return deleted;
  }

  private async deleteIfExpired(
    model: string,
    id: string,
    dir: string,
    entry: string,
    now: number,
  ): Promise<boolean> {
    let record: KvRecord | null;
    try {
      record = await this.readKv(model, id);
    } catch {
      return false;
    }
    if (record?.exp == null || record.exp > now) return false;
    try {
      await fs.unlink(path.join(dir, entry));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return false;
    }
  }

  /**
   * `readdir` with ENOENT tolerated as an empty result. Other errors
   * propagate. Companion to `safelyListJsonEntries` for callers that
   * want every entry, not just `.json` files.
   */
  private async safelyListDirectory(dir: string): Promise<string[]> {
    try {
      return await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Linear scan over the Session model. Tolerated cost given solo/team
   * deployment volumes; the Postgres backend should index `uid`.
   */
  async genericFindByUid(uid: string): Promise<unknown> {
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
      if (payload?.uid === uid) return record.value;
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

  // ---- Sign-in allowlist ----

  async allowlistList(): Promise<AuthAllowlistEntry[]> {
    return this.readAllowlist();
  }

  async allowlistFind(id: string): Promise<AuthAllowlistEntry | null> {
    const entries = await this.readAllowlist();
    return entries.find(e => e.id === id) ?? null;
  }

  async allowlistAdd(input: AllowlistAddInput): Promise<AuthAllowlistEntry> {
    return this.locks.withLock(`auth:allowlist:${this.allowlistPath}`, async () => {
      const entries = await this.readAllowlistRaw();
      const value = input.value.toLowerCase();
      const duplicate = entries.find(e => e.kind === input.kind && e.value === value);
      if (duplicate) {
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
      entries.push(entry);
      await this.ensureRoot();
      await this.locks.atomicWriteFile(this.allowlistPath, serializeAllowlist(entries));
      return { ...entry, createdAt: new Date(entry.createdAt) };
    });
  }

  async allowlistUpdate(id: string, patch: AllowlistUpdatePatch): Promise<AuthAllowlistEntry | null> {
    return this.locks.withLock(`auth:allowlist:${this.allowlistPath}`, async () => {
      const entries = await this.readAllowlistRaw();
      const idx = entries.findIndex(e => e.id === id);
      if (idx < 0) return null;
      if (patch.note !== undefined) entries[idx].note = patch.note;
      await this.ensureRoot();
      await this.locks.atomicWriteFile(this.allowlistPath, serializeAllowlist(entries));
      const updated = entries[idx];
      return { ...updated, createdAt: new Date(updated.createdAt) };
    });
  }

  async allowlistRemove(id: string): Promise<boolean> {
    return this.locks.withLock(`auth:allowlist:${this.allowlistPath}`, async () => {
      const entries = await this.readAllowlistRaw();
      const idx = entries.findIndex(e => e.id === id);
      if (idx < 0) return false;
      entries.splice(idx, 1);
      await this.ensureRoot();
      await this.locks.atomicWriteFile(this.allowlistPath, serializeAllowlist(entries));
      return true;
    });
  }

  async allowlistMatchesIdentity(values: AllowlistMatchValues): Promise<boolean> {
    const entries = await this.readAllowlist();
    if (entries.length === 0) return false;
    const email = values.email?.toLowerCase();
    const githubUsername = values.githubUsername?.toLowerCase();
    const githubId = values.githubId;
    for (const e of entries) {
      if (e.kind === 'email' && email && e.value === email) return true;
      if (e.kind === 'github_username' && githubUsername && e.value === githubUsername) return true;
      if (e.kind === 'github_id' && githubId && e.value === githubId) return true;
    }
    return false;
  }

  private async readAllowlist(): Promise<AuthAllowlistEntry[]> {
    const raw = await this.readAllowlistRaw();
    return raw.map(e => ({ ...e, createdAt: new Date(e.createdAt) }));
  }

  private async readAllowlistRaw(): Promise<AuthAllowlistEntry[]> {
    try {
      const raw = await fs.readFile(this.allowlistPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        logger.warn('[AuthStorage:fs] allowlist.json is not an array; treating as empty', {
          path: this.allowlistPath,
        });
        return [];
      }
      return parsed
        .filter((e): e is AuthAllowlistEntry & { createdAt: string | Date } =>
          typeof e === 'object' && e !== null
          && typeof (e as { id?: unknown }).id === 'string'
          && typeof (e as { kind?: unknown }).kind === 'string'
          && ['email', 'github_username', 'github_id'].includes((e as { kind: string }).kind)
          && typeof (e as { value?: unknown }).value === 'string')
        .map(e => ({
          id: e.id,
          kind: e.kind,
          value: e.value,
          note: typeof e.note === 'string' ? e.note : null,
          createdBy: typeof e.createdBy === 'string' ? e.createdBy : null,
          createdAt: typeof e.createdAt === 'string' ? new Date(e.createdAt) : e.createdAt,
        }));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      if (err instanceof SyntaxError) {
        logger.warn('[AuthStorage:fs] allowlist.json failed to parse; treating as empty', {
          path: this.allowlistPath,
          error: err.message,
        });
        return [];
      }
      throw err;
    }
  }
}

function serializeAllowlist(entries: AuthAllowlistEntry[]): string {
  // Pretty-print so operators editing the file by hand get readable output.
  // Dates serialize to ISO-8601 via Date.prototype.toJSON.
  return JSON.stringify(entries, null, 2);
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
