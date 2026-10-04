/** Dormant UPDATE-only authority. Production DI does not construct this adapter. */
import type { IMemoryHeadStore, MemoryHeadToken } from './IMemoryHeadStore.js';
import type { FileMemoryOwnerSnapshots, OwnedFileMemoryToken } from './FileMemoryOwnerSnapshots.js';
import type { ElementWriteMetadata } from './IStorageLayer.js';

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
interface BoundState {
  token: MemoryUpdateToken;
  name: string;
  contextRoot: string;
  busy: boolean;
  unknown: boolean;
  pending?: PendingMemoryUpdate;
}
export type MemoryUpdateOutcome = { status: 'committed'; token: MemoryUpdateToken; cause?: unknown } |
  { status: 'refused' | 'unknown'; cause: unknown };
const refusalCodes = new Set(['ESTALE', 'EHEADOUTOFSYNC', 'EHEADCONFLICT', 'EINVALIDHEAD', 'EHEADRESOURCE']);
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
  constructor(private readonly port: MemoryUpdatePort, private readonly getCurrentUserId: () => string) {}
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
    const snapshot = await this.port.store.readHeadSnapshot(locator);
    this.requireTenant(tenant);
    if (snapshot.token.backend !== this.port.backend || snapshot.token.userId !== tenant ||
      snapshot.token.locator !== locator || ('tenantRoot' in snapshot.token && snapshot.token.tenantRoot !== tenantRoot) || ('ownership' in snapshot.token && snapshot.token.ownership !== 'owned')) {
      throw refusal('Existing owned memory snapshot required');
    }
    return Object.freeze({ content: snapshot.content, token: copyToken(snapshot.token as MemoryUpdateToken) });
  }
  bindLoaded(memory: object, snapshot: MemoryUpdateSnapshot, name: string, contextRoot: string): void {
    this.requireTenant(snapshot.token.userId);
    if ('name' in snapshot.token && snapshot.token.name !== name) throw refusal('Memory name does not match its owner snapshot');
    this.bindings.set(memory, { token: copyToken(snapshot.token), name, contextRoot, busy: false, unknown: false });
  }
  beginUpdate(memory: object, tenant: string, locator: string | undefined, name: string, contextRoot: string): MemoryUpdateToken {
    this.requireTenant(tenant);
    const state = this.bindings.get(memory);
    if (state?.token.userId !== tenant || state.token.locator !== locator || state.name !== name || state.contextRoot !== contextRoot) {
      throw refusal('UPDATE requires original instance ownership, name and locator');
    }
    if (state.busy || state.unknown) throw refusal('Memory has an in-flight or unresolved update');
    state.busy = true;
    state.pending = undefined;
    return state.token;
  }
  async write(memory: object, tenant: string, candidate: MemoryUpdateCandidate): Promise<MemoryUpdateOutcome> {
    const state = this.requiredState(memory);
    const captured = copyCandidate(candidate);
    const originalToken = state.token;
    this.requireTenant(tenant);
    try {
      const token = this.port.backend === 'database'
        ? await this.port.store.writeHeadIfCurrent(originalToken as MemoryHeadToken, captured.name, captured.content, captured.metadata)
        : await this.port.store.updateOwnedHead(originalToken as OwnedFileMemoryToken, captured.content);
      return this.recordCommit(state, token, originalToken);
    } catch (cause) {
      const error = cause as { committed?: boolean; token?: MemoryUpdateToken; code?: string; residual?: boolean } | null;
      if (this.port.backend === 'file' && error?.committed === true && error.token) {
        const outcome = this.recordCommit(state, error.token, originalToken);
        state.pending = Object.freeze({ status: 'committed-publication-failed', candidate: captured,
          originalToken, committedToken: state.token, cause });
        return { ...outcome, cause };
      }
      const status = error?.residual !== true && refusalCodes.has(error?.code ?? '') ? 'refused' : 'unknown';
      state.unknown = status === 'unknown';
      state.pending = Object.freeze({ status, candidate: captured, originalToken, cause });
      return { status, cause };
    }
  }
  private recordCommit(state: BoundState, token: MemoryUpdateToken, original: MemoryUpdateToken): { status: 'committed'; token: MemoryUpdateToken } {
    if (token.backend !== original.backend || token.userId !== original.userId || token.ownerId !== original.ownerId ||
      token.locator !== original.locator || token.revision === original.revision) throw new Error('Invalid committed memory receipt');
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
