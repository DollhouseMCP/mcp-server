import type { IActivationStateStore, PersistedActivation } from '../../../state/IActivationStateStore.js';
import type { SessionActivationRegistry, SessionActivationState } from '../../../state/SessionActivationState.js';
import { CONSOLE_ACTIVATABLE_ELEMENT_TYPES } from './ActivationTypes.js';
import type { ConsoleActivatableElementType } from './ActivationTypes.js';

export interface SessionActivationRecord {
  readonly type: ConsoleActivatableElementType;
  readonly name: string;
  readonly activatedAt: Date;
}

export interface SessionActivationChangeResult {
  readonly record: SessionActivationRecord;
  readonly changed: boolean;
}

export interface ISessionActivationStateAdapter {
  list(sessionId: string): Promise<readonly SessionActivationRecord[]>;
  activate(sessionId: string, type: ConsoleActivatableElementType, name: string): Promise<SessionActivationChangeResult>;
  deactivate(sessionId: string, type: ConsoleActivatableElementType, name: string): Promise<boolean>;
}

export class RegistrySessionActivationStateAdapter implements ISessionActivationStateAdapter {
  private readonly fallbackRecords = new Map<string, SessionActivationRecord>();

  constructor(private readonly registry: SessionActivationRegistry) {}

  list(sessionId: string): Promise<readonly SessionActivationRecord[]> {
    const state = this.registry.get(sessionId);
    if (!state) return Promise.resolve([]);
    if (state.activationStore?.isEnabled()) return Promise.resolve(recordsFromStore(state.activationStore));
    const fallbackRecords = this.listFallbackRecords(sessionId);
    return Promise.resolve(mergeRecords(recordsFromStateSets(state), fallbackRecords));
  }

  activate(
    sessionId: string,
    type: ConsoleActivatableElementType,
    name: string,
  ): Promise<SessionActivationChangeResult> {
    const state = this.registry.getOrCreate(sessionId);
    const storeRecord = state.activationStore?.getActivations(type).find(record => record.name === name);
    const fallbackRecord = this.fallbackRecords.get(recordKey(sessionId, type, name));
    const changed = !activationSet(state, type).has(name) && !storeRecord && !fallbackRecord;
    activationSet(state, type).add(name);
    if (state.activationStore?.isEnabled()) {
      state.activationStore.recordActivation(type, name);
    } else if (!fallbackRecord) {
      this.fallbackRecords.set(recordKey(sessionId, type, name), {
        type,
        name,
        activatedAt: new Date(),
      });
    }
    const persistedRecord = state.activationStore?.getActivations(type).find(record => record.name === name);
    const record = {
      type,
      name,
      activatedAt: persistedRecord
        ? parseActivationDate(persistedRecord.activatedAt)
        : this.fallbackRecords.get(recordKey(sessionId, type, name))?.activatedAt ?? new Date(),
    };
    return Promise.resolve({ record: cloneActivationRecord(record), changed });
  }

  deactivate(sessionId: string, type: ConsoleActivatableElementType, name: string): Promise<boolean> {
    const state = this.registry.get(sessionId);
    if (!state) return Promise.resolve(false);
    const stateSet = activationSet(state, type);
    const changed = stateSet.delete(name) ||
      Boolean(state.activationStore?.getActivations(type).some(record => record.name === name)) ||
      this.fallbackRecords.delete(recordKey(sessionId, type, name));
    if (changed && state.activationStore?.isEnabled()) state.activationStore.recordDeactivation(type, name);
    return Promise.resolve(changed);
  }

  private listFallbackRecords(sessionId: string): readonly SessionActivationRecord[] {
    const prefix = `${sessionId}\u0000`;
    return Array.from(this.fallbackRecords.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record);
  }
}

export class InMemorySessionActivationStateAdapter implements ISessionActivationStateAdapter {
  private readonly records = new Map<string, SessionActivationRecord>();

  list(sessionId: string): Promise<readonly SessionActivationRecord[]> {
    const prefix = `${sessionId}\u0000`;
    return Promise.resolve(Array.from(this.records.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
      .sort(compareActivationRecords)
      .map(cloneActivationRecord));
  }

  activate(
    sessionId: string,
    type: ConsoleActivatableElementType,
    name: string,
  ): Promise<SessionActivationChangeResult> {
    const key = recordKey(sessionId, type, name);
    const existing = this.records.get(key);
    if (existing) return Promise.resolve({ record: cloneActivationRecord(existing), changed: false });
    const record = { type, name, activatedAt: new Date() };
    this.records.set(key, record);
    return Promise.resolve({ record: cloneActivationRecord(record), changed: true });
  }

  deactivate(sessionId: string, type: ConsoleActivatableElementType, name: string): Promise<boolean> {
    return Promise.resolve(this.records.delete(recordKey(sessionId, type, name)));
  }
}

function recordsFromStore(store: IActivationStateStore): SessionActivationRecord[] {
  const records: SessionActivationRecord[] = [];
  for (const type of ACTIVATION_TYPES) {
    for (const activation of store.getActivations(type)) {
      records.push(toRecord(type, activation));
    }
  }
  return records.sort(compareActivationRecords);
}

function recordsFromStateSets(state: SessionActivationState): SessionActivationRecord[] {
  const now = new Date();
  const records: SessionActivationRecord[] = [];
  for (const type of ACTIVATION_TYPES) {
    for (const name of activationSet(state, type)) {
      records.push({ type, name, activatedAt: now });
    }
  }
  return records.sort(compareActivationRecords);
}

function toRecord(type: ConsoleActivatableElementType, activation: PersistedActivation): SessionActivationRecord {
  return {
    type,
    name: activation.name,
    activatedAt: parseActivationDate(activation.activatedAt),
  };
}

function parseActivationDate(value: string): Date {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function activationSet(state: SessionActivationState, type: ConsoleActivatableElementType): Set<string> {
  return state[type];
}

function cloneActivationRecord(record: SessionActivationRecord): SessionActivationRecord {
  return {
    ...record,
    activatedAt: new Date(record.activatedAt),
  };
}

function compareActivationRecords(left: SessionActivationRecord, right: SessionActivationRecord): number {
  const time = left.activatedAt.getTime() - right.activatedAt.getTime();
  if (time !== 0) return time;
  const type = left.type.localeCompare(right.type);
  return type === 0 ? left.name.localeCompare(right.name) : type;
}

function recordKey(sessionId: string, type: ConsoleActivatableElementType, name: string): string {
  return `${sessionId}\u0000${type}\u0000${name}`;
}

function mergeRecords(
  stateRecords: readonly SessionActivationRecord[],
  fallbackRecords: readonly SessionActivationRecord[],
): readonly SessionActivationRecord[] {
  const merged = new Map<string, SessionActivationRecord>();
  for (const record of stateRecords) merged.set(`${record.type}\u0000${record.name}`, record);
  for (const record of fallbackRecords) merged.set(`${record.type}\u0000${record.name}`, record);
  return Array.from(merged.values()).sort(compareActivationRecords);
}

const ACTIVATION_TYPES = CONSOLE_ACTIVATABLE_ELEMENT_TYPES;
