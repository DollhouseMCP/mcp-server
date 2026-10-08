/** Dormant UPDATE-only authority. Production DI does not construct this adapter. */
import type { IMemoryHeadStore, MemoryHeadToken } from './IMemoryHeadStore.js';
import type { FileMemoryOwnerSnapshots, OwnedFileMemoryToken } from './FileMemoryOwnerSnapshots.js';
import type { ElementWriteMetadata } from './IStorageLayer.js';
import type { DatabaseMemoryAdmission, DatabaseMemoryAdmissionGate } from './DatabaseMemoryAdmissionGate.js';
import type { DatabaseMemoryStorageLayer } from './DatabaseMemoryStorageLayer.js';

export type MemoryUpdateToken = MemoryHeadToken | OwnedFileMemoryToken;
export type MemoryUpdateSnapshot = { readonly content: string; readonly token: MemoryUpdateToken };
export type MemoryUpdatePort = { readonly backend: 'database'; readonly store: IMemoryHeadStore } |
  { readonly backend: 'file'; readonly store: Pick<FileMemoryOwnerSnapshots, 'readHeadSnapshot' | 'updateOwnedHead'> };
export interface MemoryUpdateCandidate {
  readonly content: string;
  readonly name: string;
  readonly metadata: ElementWriteMetadata;
}
export interface PendingMemoryUpdate {
  readonly status: 'refused' | 'unknown' | 'committed-publication-failed';
  readonly candidate?: MemoryUpdateCandidate;
  readonly originalToken: MemoryUpdateToken;
  readonly cause: unknown;
  readonly committedToken?: MemoryUpdateToken;
}
interface BoundAdmission { readonly gate: DatabaseMemoryAdmissionGate; readonly capture: DatabaseMemoryAdmission }
interface BoundState {
  admission?: BoundAdmission;
  token: MemoryUpdateToken;
  name: string;
  contextRoot: string;
  busy: boolean;
  unknown: boolean;
  lineage: { unresolved: boolean };
  pending?: PendingMemoryUpdate;
}
export type MemoryUpdateOutcome = { status: 'committed'; token: MemoryUpdateToken; cause?: unknown } |
  { status: 'refused' | 'unknown'; cause: unknown };
const refusalCodes = new Set(['ESTALE', 'EHEADOUTOFSYNC', 'EHEADCONFLICT', 'EINVALIDHEAD', 'EHEADRESOURCE', 'EMEMORYADMISSION']);
function refusal(message: string): Error {
  return Object.assign(new Error(message), { code: 'EHEADCONFLICT' });
}
function copyToken(token: MemoryUpdateToken): MemoryUpdateToken {
  const copy = structuredClone(token);
  if ('fileIdentity' in copy) Object.freeze(copy.fileIdentity);
  return Object.freeze(copy);
}
function copyCandidate(candidate: MemoryUpdateCandidate): MemoryUpdateCandidate {
  return Object.freeze({ ...candidate, metadata: Object.freeze({ ...candidate.metadata,
    tags: Object.freeze([...candidate.metadata.tags]) as unknown as string[] }) });
}
export class MemoryHeadUpdateAdapter {
  private readonly bindings = new WeakMap<object, BoundState>();
  private readonly snapshotAdmissions = new WeakMap<MemoryUpdateSnapshot, BoundAdmission>();
  constructor(private readonly port: MemoryUpdatePort, private readonly getCurrentUserId: () => string,
    /** Trusted dormant composition only; production DI remains unchanged. */
    private readonly resolveDatabaseAdmission?: () => DatabaseMemoryAdmissionGate) {
    if (resolveDatabaseAdmission && port.backend !== 'database') throw refusal('Database admission requires database storage');
  }
  /** Internal composition identity check; exposes no backend port or token. */
  matchesDatabaseStore(store: IMemoryHeadStore): boolean {
    return this.port.backend === 'database' && this.port.store === store;
  }
  captureTenant(): string {
    const tenant = this.getCurrentUserId();
    if (typeof tenant !== 'string' || !tenant) throw refusal('Authenticated memory tenant required');
    return tenant;
  }
  requireTenant(tenant: string): void {
    if (this.captureTenant() !== tenant) throw refusal('Memory tenant changed during operation');
  }
  async readBoundSnapshot(locator: string, tenant: string, tenantRoot: string): Promise<MemoryUpdateSnapshot> {
    this.requireTenant(tenant);
    const gate = this.resolveDatabaseAdmission?.();
    if (this.resolveDatabaseAdmission && !gate) throw refusal('Database admission is unavailable');
    const admission = gate && { gate, capture: await gate.capture() };
    const snapshot = await this.port.store.readHeadSnapshot(locator);
    this.requireTenant(tenant);
    if (snapshot.token.backend !== this.port.backend || snapshot.token.userId !== tenant ||
      snapshot.token.locator !== locator || ('tenantRoot' in snapshot.token && snapshot.token.tenantRoot !== tenantRoot) || ('ownership' in snapshot.token && snapshot.token.ownership !== 'owned')) {
      throw refusal('Existing owned memory snapshot required');
    }
    const bound = Object.freeze({ content: snapshot.content, token: copyToken(snapshot.token as MemoryUpdateToken) });
    if (admission) this.snapshotAdmissions.set(bound, admission);
    return bound;
  }
  bindLoaded(memory: object, snapshot: MemoryUpdateSnapshot, name: string, contextRoot: string): void {
    this.requireTenant(snapshot.token.userId);
    if ('name' in snapshot.token && snapshot.token.name !== name) throw refusal('Memory name does not match its owner snapshot');
    const admission = this.snapshotAdmissions.get(snapshot);
    if (this.resolveDatabaseAdmission && !admission) throw refusal('Memory has no captured database admission');
    this.bindings.set(memory, { token: copyToken(snapshot.token), name, contextRoot, busy: false, unknown: false,
      lineage: { unresolved: false }, ...(admission ? { admission } : {}) });
  }
  /** Internal manager derivation: no refreshed read and no advancement of source authority. */
  deriveBinding(source: object, candidate: object, tenant: string, locator: string | undefined, name: string, contextRoot: string): void {
    this.requireTenant(tenant);
    const state = this.requiredState(source);
    if (state.busy || state.unknown || state.lineage.unresolved || state.token.userId !== tenant ||
      state.token.locator !== locator || state.name !== name || state.contextRoot !== contextRoot || this.bindings.has(candidate)) {
      throw refusal('Cannot derive a current owned memory mutation');
    }
    this.bindings.set(candidate, { ...state, token: copyToken(state.token), busy: false, pending: undefined });
  }

  /** A committed publication shares unresolved sibling state without changing source bytes/token. */
  bindPublication(publication: object, committed: object): void {
    const state = this.requiredState(committed);
    this.bindings.set(publication, { ...state, token: copyToken(state.token), busy: false, pending: undefined });
  }

  beginUpdate(memory: object, tenant: string, locator: string | undefined, name: string, contextRoot: string): MemoryUpdateToken {
    this.requireTenant(tenant);
    const state = this.bindings.get(memory);
    if (state?.token.userId !== tenant || state.token.locator !== locator || state.name !== name || state.contextRoot !== contextRoot) {
      throw refusal('UPDATE requires original instance ownership, name and locator');
    }
    if (state.busy || state.unknown || state.lineage.unresolved) throw refusal('Memory has an in-flight or unresolved update');
    state.busy = true;
    state.pending = undefined;
    return state.token;
  }
  async write(memory: object, tenant: string, candidate: MemoryUpdateCandidate): Promise<MemoryUpdateOutcome> {
    const state = this.requiredState(memory);
    const captured = copyCandidate(candidate);
    const originalToken = state.token;
    this.requireTenant(tenant);
    if (state.lineage.unresolved) throw refusal('Memory has an unresolved related update');
    let committed: { status: 'committed'; token: MemoryUpdateToken } | undefined;
    try {
      if (this.resolveDatabaseAdmission) {
        const admission = state.admission;
        if (!admission || this.resolveDatabaseAdmission() !== admission.gate || this.port.backend !== 'database') {
          throw refusal('Original database admission gate required');
        }
        const store = this.port.store as DatabaseMemoryStorageLayer;
        const outcome = await admission.gate.withAdmittedWrite(admission.capture, async authority => {
          const prepared = await store.prepareHeadWriteInAdmission(authority,
            originalToken as MemoryHeadToken, captured.name, captured.content, captured.metadata);
          // An invalid prospective receipt must roll back, never become a committed token.
          this.validateReceipt(prepared.token, originalToken);
          return prepared;
        });
        if (outcome.status !== 'committed') return this.recordPending(state, captured, originalToken, outcome);
        committed = this.recordCommit(state, outcome.value.token, originalToken);
        this.requireTenant(tenant);
        outcome.value.publish();
        return committed;
      }
      const token = this.port.backend === 'database'
        ? await this.port.store.writeHeadIfCurrent(originalToken as MemoryHeadToken, captured.name, captured.content, captured.metadata)
        : await this.port.store.updateOwnedHead(originalToken as OwnedFileMemoryToken, captured.content);
      return this.recordCommit(state, token, originalToken);
    } catch (cause) {
      if (committed) {
        state.pending = Object.freeze({ status: 'committed-publication-failed', candidate: captured,
          originalToken, committedToken: state.token, cause });
        return { ...committed, cause };
      }
      const error = cause as { committed?: boolean; token?: MemoryUpdateToken; code?: string; residual?: boolean } | null;
      if (this.port.backend === 'file' && error?.committed === true && error.token) {
        const outcome = this.recordCommit(state, error.token, originalToken);
        state.pending = Object.freeze({ status: 'committed-publication-failed', candidate: captured,
          originalToken, committedToken: state.token, cause });
        return { ...outcome, cause };
      }
      const status = error?.residual !== true && refusalCodes.has(error?.code ?? '') ? 'refused' : 'unknown';
      state.unknown = status === 'unknown';
      if (state.unknown) state.lineage.unresolved = true;
      state.pending = Object.freeze({ status, candidate: captured, originalToken, cause });
      return { status, cause };
    }
  }
  private recordPending(state: BoundState, captured: MemoryUpdateCandidate, originalToken: MemoryUpdateToken,
    outcome: { status: 'refused' | 'unknown'; cause: unknown }): MemoryUpdateOutcome {
    state.unknown = outcome.status === 'unknown';
    if (state.unknown) state.lineage.unresolved = true;
    state.pending = Object.freeze({ ...outcome, candidate: captured, originalToken });
    return outcome;
  }
  private validateReceipt(token: MemoryUpdateToken, original: MemoryUpdateToken): void {
    if (token.backend !== original.backend || token.userId !== original.userId || token.ownerId !== original.ownerId ||
      token.locator !== original.locator || token.revision === original.revision) throw new Error('Invalid committed memory receipt');
  }
  private recordCommit(state: BoundState, token: MemoryUpdateToken, original: MemoryUpdateToken): { status: 'committed'; token: MemoryUpdateToken } {
    this.validateReceipt(token, original);
    state.token = copyToken(token);
    state.pending = undefined;
    state.unknown = false;
    return { status: 'committed', token: state.token };
  }
  recordFailure(memory: object, candidate: MemoryUpdateCandidate | undefined, originalToken: MemoryUpdateToken, cause: unknown, committed = false): void {
    const state = this.requiredState(memory);
    if (state.pending) return;
    state.pending = Object.freeze({ status: committed ? 'committed-publication-failed' : 'refused',
      candidate: candidate && copyCandidate(candidate), originalToken, cause,
      ...(committed ? { committedToken: state.token } : {}) });
  }
  finishUpdate(memory: object): void { this.requiredState(memory).busy = false; }
  getPendingUpdate(memory: object): PendingMemoryUpdate | undefined { return this.bindings.get(memory)?.pending; }
  private requiredState(memory: object): BoundState {
    const state = this.bindings.get(memory);
    if (!state) throw refusal('Memory has no captured ownership');
    return state;
  }
}
