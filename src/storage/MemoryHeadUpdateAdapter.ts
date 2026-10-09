/** Dormant UPDATE-only authority. Production DI does not construct this adapter. */
import type { IMemoryHeadStore, MemoryHeadToken } from './IMemoryHeadStore.js';
import type { FileMemoryOwnerSnapshots, OwnedFileMemoryToken } from './FileMemoryOwnerSnapshots.js';
import type { ElementWriteMetadata } from './IStorageLayer.js';
import type { DatabaseMemoryAdmission, DatabaseMemoryAdmissionGate, DatabaseMemoryAdmittedWriteOutcome } from './DatabaseMemoryAdmissionGate.js';
import type { DatabaseMemoryStorageLayer, PreparedDatabaseMemoryHeadWrite } from './DatabaseMemoryStorageLayer.js';
import type { DatabaseMemoryCandidateHandoff, MemoryCandidateHandoffReceipt } from './DatabaseMemoryCandidateHandoff.js';
import { encodeMemoryCandidate, decodeMemoryCandidate } from './DatabaseMemoryCandidateEnvelope.js';

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
  handoff?: { readonly store: DatabaseMemoryCandidateHandoff; readonly receipt: MemoryCandidateHandoffReceipt;
    readonly candidate: MemoryUpdateCandidate; readonly originalToken: MemoryUpdateToken; completed: boolean };
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
    private readonly resolveDatabaseAdmission?: () => DatabaseMemoryAdmissionGate,
    private readonly resolveCandidateHandoff?: () => DatabaseMemoryCandidateHandoff,
    private readonly checkReadCandidate?: (candidate: MemoryUpdateCandidate, token: MemoryUpdateToken) => Promise<void>) {
    if (resolveDatabaseAdmission && port.backend !== 'database') throw refusal('Database admission requires database storage');
    if (resolveCandidateHandoff && !resolveDatabaseAdmission) throw refusal('Candidate handoff requires database admission');
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
    if (state.busy || state.unknown || state.lineage.unresolved || (state.handoff && !state.handoff.completed) || state.token.userId !== tenant ||
      state.token.locator !== locator || state.name !== name || state.contextRoot !== contextRoot || this.bindings.has(candidate)) {
      throw refusal('Cannot derive a current owned memory mutation');
    }
    this.bindings.set(candidate, { ...state, token: copyToken(state.token), busy: false, pending: undefined, handoff: undefined });
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
    if (state.busy || state.unknown || state.lineage.unresolved || (state.handoff && !state.handoff.completed)) throw refusal('Memory has an in-flight or unresolved update');
    state.handoff = undefined;
    state.busy = true;
    state.pending = undefined;
    return state.token;
  }
  async write(memory: object, tenant: string, candidate: MemoryUpdateCandidate): Promise<MemoryUpdateOutcome> {
    const state = this.requiredState(memory);
    // Validate before spreads can invoke arbitrary metadata accessors. The exact
    // data clone also prevents caller-owned nested data changing during handoff.
    const captured = copyCandidate(this.resolveCandidateHandoff
      ? decodeMemoryCandidate(encodeMemoryCandidate(candidate)) : candidate);
    const originalToken = state.token;
    this.requireTenant(tenant);
    if (state.lineage.unresolved) throw refusal('Memory has an unresolved related update');
    let committed: { status: 'committed'; token: MemoryUpdateToken } | undefined;
    try {
      if (this.checkReadCandidate) {
        const refusal = await this.readCandidateRefusal(captured, originalToken, tenant);
        if (refusal) return this.recordPending(state, captured, originalToken, refusal);
        this.requireTenant(tenant);
      }
      if (this.resolveDatabaseAdmission) {
        const handoff = this.resolveCandidateHandoff
          ? await this.prepareCandidateHandoff(state, captured, originalToken) : undefined;
        if (handoff) return this.recordPending(state, captured, originalToken, handoff);
        const outcome = await this.prepareAdmittedWrite(state, captured, originalToken);
        if (outcome.status !== 'committed') {
          return this.recordUncommittedAdmission(state, captured, originalToken, outcome);
        }
        committed = this.recordCommit(state, outcome.value.token, originalToken);
        state.handoff?.store.noteKnownCommit(state.handoff.receipt);
        this.requireTenant(tenant);
        outcome.value.publish();
        return committed;
      }
      const token = this.port.backend === 'database'
        ? await this.port.store.writeHeadIfCurrent(originalToken as MemoryHeadToken, captured.name, captured.content, captured.metadata)
        : await this.port.store.updateOwnedHead(originalToken as OwnedFileMemoryToken, captured.content);
      return this.recordCommit(state, token, originalToken);
    } catch (cause) {
      return this.recordWriteFailure(state, captured, originalToken, cause, committed);
    }
  }
  private recordUncommittedAdmission(state: BoundState, candidate: MemoryUpdateCandidate,
    token: MemoryUpdateToken, outcome: { status: 'refused' | 'unknown'; cause: unknown }): MemoryUpdateOutcome {
    if (outcome.status === 'unknown') state.handoff?.store.close();
    return this.recordPending(state, candidate, token, outcome);
  }
  private async readCandidateRefusal(candidate: MemoryUpdateCandidate, token: MemoryUpdateToken,
    tenant: string): Promise<{ status: 'refused'; cause: unknown } | undefined> {
    try {
      await this.checkReadCandidate!(candidate, token);
      this.requireTenant(tenant);
      return undefined;
    } catch (cause) {
      // No handoff or head transaction has been dispatched at this point.
      return { status: 'refused', cause };
    }
  }
  private async prepareCandidateHandoff(state: BoundState, captured: MemoryUpdateCandidate,
    originalToken: MemoryUpdateToken): Promise<{ status: 'refused' | 'unknown'; cause: unknown } | undefined> {
    if (!this.resolveCandidateHandoff) return undefined;
    const store = this.resolveCandidateHandoff();
    if (!state.admission || !store || state.handoff) throw refusal('Original candidate handoff required');
    const outcome = await store.handoff(state.admission.capture, captured, originalToken as MemoryHeadToken);
    if (outcome.status !== 'committed') return outcome;
    state.handoff = { store, receipt: outcome.value, candidate: captured, originalToken, completed: false };
    store.consume(outcome.value);
    return undefined;
  }
  private recordWriteFailure(state: BoundState, captured: MemoryUpdateCandidate,
    originalToken: MemoryUpdateToken, cause: unknown,
    committed?: { status: 'committed'; token: MemoryUpdateToken }): MemoryUpdateOutcome {
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
    return this.recordPending(state, captured, originalToken, { status, cause });
  }
  private async prepareAdmittedWrite(state: BoundState, captured: MemoryUpdateCandidate,
    originalToken: MemoryUpdateToken): Promise<DatabaseMemoryAdmittedWriteOutcome<PreparedDatabaseMemoryHeadWrite>> {
    const admission = state.admission;
    if (!admission?.gate || this.resolveDatabaseAdmission?.() !== admission.gate || this.port.backend !== 'database') {
      throw refusal('Original database admission gate required');
    }
    const store = this.port.store as DatabaseMemoryStorageLayer;
    return await admission.gate.withAdmittedWrite(admission.capture, async authority => {
      if (state.handoff) await state.handoff.store.requireBeforeDispatch(authority, state.handoff.receipt, captured);
      const prepared = await store.prepareHeadWriteInAdmission(authority,
        originalToken as MemoryHeadToken, captured.name, captured.content, captured.metadata);
      // An invalid prospective receipt must roll back, never become a committed token.
      this.validateReceipt(prepared.token, originalToken);
      if (state.handoff) await state.handoff.store.recordCommitted(authority, state.handoff.receipt, captured, prepared.token);
      return prepared;
    });
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
  /** The owning operation supplies its real publication tail, never a completion boolean. */
  async completePublication<T>(memory: object, publish: () => Promise<T>): Promise<T> {
    const state = this.requiredState(memory);
    if (!this.resolveCandidateHandoff) return publish();
    if (!state.handoff || state.pending) throw refusal('Known committed handoff publication required');
    const handoff = state.handoff;
    try {
      const result = await handoff.store.completePublication(handoff.receipt, publish);
      handoff.completed = true;
      state.handoff = undefined;
      return result;
    } catch (cause) {
      state.pending = Object.freeze({ status: 'committed-publication-failed', candidate: handoff.candidate,
        originalToken: handoff.originalToken, committedToken: state.token, cause });
      throw cause;
    }
  }
  getPendingUpdate(memory: object): PendingMemoryUpdate | undefined { return this.bindings.get(memory)?.pending; }
  private requiredState(memory: object): BoundState {
    const state = this.bindings.get(memory);
    if (!state) throw refusal('Memory has no captured ownership');
    return state;
  }
}
