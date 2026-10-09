/** Dormant DB-only admission. Production DI and existing writers are unchanged. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import type { DrizzleTx } from '../database/db-utils.js';
import { withUserContext, withUserRead } from '../database/rls.js';
import { validateUserId } from '../state/db-persistence-utils.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { logger } from '../utils/logger.js';
import type { DatabaseMemoryStorageLayer } from './DatabaseMemoryStorageLayer.js';
import type { MemoryHeadUpdateAdapter } from './MemoryHeadUpdateAdapter.js';

export const DATABASE_MEMORY_ADMISSION_PROFILE = 'existing-owner-archive-free-update-v1';
export interface DatabaseMemoryAdmissionBinding {
  readonly tenant: string;
  readonly backend: string;
  readonly db: DatabaseInstance;
  readonly store: DatabaseMemoryStorageLayer;
  readonly adapter?: MemoryHeadUpdateAdapter;
  readonly enabled?: boolean;
  readonly profile?: string;
}
/** Opaque within this process: a structural copy has no admission authority. */
export interface DatabaseMemoryAdmission { readonly protocolVersion: 1 }
/** Internal, invocation-bound authority; structural copies convey no transaction. */
export interface DatabaseMemoryWriteAuthority { readonly protocolVersion: 1 }
interface WriteAuthorityState {
  readonly tx: DrizzleTx;
  readonly tenant: string;
  readonly store: DatabaseMemoryStorageLayer;
  readonly requireBinding: () => void;
  active: boolean;
  committed: boolean;
}
const writeAuthorities = new WeakMap<DatabaseMemoryWriteAuthority, WriteAuthorityState>();
/** Internal store entry: never accepts a caller-supplied transaction or tenant. */
export function requireDatabaseMemoryWriteAuthority(
  authority: DatabaseMemoryWriteAuthority, store: DatabaseMemoryStorageLayer, tenant: string,
): DrizzleTx {
  const state = writeAuthorities.get(authority);
  if (!state?.active || state.store !== store || state.tenant !== tenant) refuse();
  state.requireBinding();
  return state.tx;
}
/** Internal publication proof; a prepared receipt alone conveys no committed authority. */
export function requireDatabaseMemoryCommittedWriteAuthority(
  authority: DatabaseMemoryWriteAuthority, store: DatabaseMemoryStorageLayer, tenant: string,
): void {
  const state = writeAuthorities.get(authority);
  if (!state?.committed || state.store !== store || state.tenant !== tenant) refuse();
  state.requireBinding();
}
export type DatabaseMemoryAdmittedWriteOutcome<T> = { readonly status: 'committed'; readonly value: T } |
  { readonly status: 'refused' | 'unknown'; readonly cause: unknown };
interface AdmissionState {
  readonly binding: DatabaseMemoryAdmissionBinding;
  readonly generation: string;
  busy: boolean;
}
function refuse(): never {
  throw Object.assign(new Error('Guarded database memory admission required'), { code: 'EMEMORYADMISSION' });
}
function observeFailure(stage: 'capture' | 'protected'): void {
  try {
    SecurityMonitor.logSecurityEvent({ type: 'OPERATION_FAILED', severity: 'HIGH',
      source: 'DatabaseMemoryAdmissionGate',
      details: `Admission boundary failed; stage=${stage}; storage-outcome=unclassified; invocation=${randomUUID()}` });
  } catch {
    try { logger.warn('Memory admission audit observer failed'); } catch { /* Preserve the original cause. */ }
  }
}

export class DatabaseMemoryAdmissionGate {
  private readonly captures = new WeakMap<DatabaseMemoryAdmission, AdmissionState>();
  constructor(
    private readonly db: DatabaseInstance,
    private readonly store: DatabaseMemoryStorageLayer,
    /** Trusted server composition only; never populated from request fields. */
    private readonly resolveBinding: () => DatabaseMemoryAdmissionBinding,
  ) {}

  async capture(): Promise<DatabaseMemoryAdmission> {
    try {
      const binding = this.currentBinding(); // Before the first await.
      const generation = await withUserRead(this.db, binding.tenant, async tx => {
        await this.requireOrdinaryRole(tx);
        this.requireBinding(binding);
        return this.readMode(tx, binding.tenant, false);
      });
      this.requireBinding(binding);
      const capture = Object.freeze({ protocolVersion: 1 as const });
      this.captures.set(capture, { binding, generation, busy: false });
      return capture;
    } catch (cause) { observeFailure('capture'); throw cause; }
  }

  /** Durable evidence only. It cannot reconstruct the private captured authority. */
  describeCapture(capture: DatabaseMemoryAdmission): {
    readonly tenant: string; readonly backend: 'database'; readonly profile: string; readonly generation: string;
  } {
    const state = this.captures.get(capture);
    if (!state || state.busy) refuse();
    this.requireBinding(state.binding);
    return Object.freeze({ tenant: state.binding.tenant, backend: 'database',
      profile: DATABASE_MEMORY_ADMISSION_PROFILE, generation: state.generation });
  }

  /**
   * Internal composition primitive. Future head writers must use THIS tx for
   * persistence, not dispatch a second transaction after this admission check.
   * Row locking synchronizes durable mode changes, not arbitrary JS config edits.
   */
  async withAdmission<T>(capture: DatabaseMemoryAdmission, body: (tx: DrizzleTx) => Promise<T>): Promise<T> {
    return this.runAdmission(capture, body);
  }

  /** Internal conditional-write path. A callback result is prospective until COMMIT completes. */
  async withAdmittedWrite<T>(capture: DatabaseMemoryAdmission,
    body: (authority: DatabaseMemoryWriteAuthority) => Promise<T>): Promise<DatabaseMemoryAdmittedWriteOutcome<T>> {
    let invocationFinished = false;
    let writeState: WriteAuthorityState | undefined;
    let failure: { readonly sentinel: Error; readonly cause: unknown } | undefined;
    try {
      const value = await this.runAdmission(capture, async tx => {
        if (invocationFinished) refuse();
        const state = this.captures.get(capture)!;
        const authority = Object.freeze({ protocolVersion: 1 as const });
        const authorityState: WriteAuthorityState = { tx, tenant: state.binding.tenant, store: this.store,
          requireBinding: () => this.requireBinding(state.binding), active: true, committed: false };
        writeState = authorityState;
        writeAuthorities.set(authority, authorityState);
        try { return await body(authority); }
        finally { authorityState.active = false; }
      }, cause => {
        // postgres.js awaits ROLLBACK before rethrowing this private identity.
        // Its connection-close race cannot fabricate this per-invocation sentinel.
        failure = { sentinel: new Error('Admitted write callback failed'), cause };
        return failure.sentinel;
      });
      if (writeState) writeState.committed = true;
      return { status: 'committed', value };
    } catch (cause) {
      if (failure && cause === failure.sentinel) return { status: 'refused', cause: failure.cause };
      // SET LOCAL/BEGIN, rollback, connection-close and COMMIT failures have no
      // private completed-rollback receipt, even if they carry a familiar code.
      return { status: 'unknown', cause };
    } finally {
      invocationFinished = true;
      if (writeState) writeState.active = false;
    }
  }

  private async runAdmission<T>(capture: DatabaseMemoryAdmission, body: (tx: DrizzleTx) => Promise<T>,
    protectedFailure?: (cause: unknown) => unknown): Promise<T> {
    const state = this.captures.get(capture);
    try {
      if (!state || state.busy) refuse();
      this.requireBinding(state.binding);
      state.busy = true;
      try {
        return await withUserContext(this.db, state.binding.tenant, async tx => {
          try {
            await this.requireOrdinaryRole(tx);
            this.requireBinding(state.binding);
            const generation = await this.readMode(tx, state.binding.tenant, true);
            this.requireBinding(state.binding);
            if (generation !== state.generation) refuse();
            const result = await body(tx);
            this.requireBinding(state.binding);
            return result;
          } catch (cause) { throw protectedFailure ? protectedFailure(cause) : cause; }
        });
      } finally { state.busy = false; }
    } catch (cause) {
      observeFailure('protected');
      throw cause;
    }
  }

  private currentBinding(): DatabaseMemoryAdmissionBinding {
    const value = this.resolveBinding();
    if (typeof value.tenant !== 'string') refuse();
    try { validateUserId(value.tenant); } catch { refuse(); }
    if (value.backend !== 'database' || value.db !== this.db || value.store !== this.store ||
      value.enabled !== true || value.profile !== DATABASE_MEMORY_ADMISSION_PROFILE || !value.adapter ||
      !this.store.matchesAdmissionContext(this.db, value.tenant) || !value.adapter.matchesDatabaseStore(this.store)) refuse();
    value.adapter.requireTenant(value.tenant);
    return Object.freeze({ ...value });
  }
  private requireBinding(expected: DatabaseMemoryAdmissionBinding): void {
    const actual = this.currentBinding();
    if (actual.tenant !== expected.tenant || actual.adapter !== expected.adapter) refuse();
  }
  private async requireOrdinaryRole(tx: DrizzleTx): Promise<void> {
    const rows = await tx.execute(sql`SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user`);
    if (rows.length !== 1 || rows[0].rolsuper !== false || rows[0].rolbypassrls !== false) refuse();
  }
  private async readMode(tx: DrizzleTx, tenant: string, lock: boolean): Promise<string> {
    const lockClause = lock ? sql`FOR SHARE` : sql``;
    const rows = await tx.execute(sql`SELECT protocol_version, profile, mode, generation::text AS generation
      FROM public.memory_backend_modes WHERE user_id=${tenant}::uuid AND backend='database'
      ${lockClause}`);
    if (rows.length !== 1) refuse();
    const row = rows[0];
    if (row.protocol_version !== 1 || row.profile !== DATABASE_MEMORY_ADMISSION_PROFILE || row.mode !== 'guarded' ||
      typeof row.generation !== 'string' || !/^[1-9]\d*$/u.test(row.generation) ||
      BigInt(row.generation) > 9223372036854775807n) refuse();
    return row.generation;
  }
}
