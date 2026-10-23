import type { ActivationSet } from './ActivationSet.js';
import type { PersistedActivation } from './IActivationStateStore.js';

export interface ResolvedActivationTarget {
  metadata: { name: string };
}

interface ElementLocation {
  filePath?: unknown;
  filename?: unknown;
  getFilePath?(): string | null | undefined;
}

export function resolvedActivationLocator(target: object): string | undefined {
  const location = target as ElementLocation;
  const value = location.getFilePath?.() || location.filePath || location.filename;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface PendingActivationDeletion {
  readonly activations: Map<string, Set<PersistedActivation>>;
  captureLive(): Array<() => boolean>;
  settle(): void;
}

/** Manager-owned, session-scoped enrollment; overlapping deletes own independent entries. */
export class PendingActivationDeletions {
  private readonly sessions = new WeakMap<ActivationSet, Map<string, Set<PendingActivationDeletion>>>();

  hasPendingDeletions(session: ActivationSet): boolean {
    return this.sessions.has(session);
  }

  begin(session: ActivationSet, locator: string): PendingActivationDeletion {
    let locations = this.sessions.get(session);
    if (!locations) {
      locations = new Map();
      this.sessions.set(session, locations);
    }
    let entries = locations.get(locator);
    if (!entries) {
      entries = new Set();
      locations.set(locator, entries);
    }
    let settled = false;
    const entry: PendingActivationDeletion = {
      activations: new Map(),
      captureLive: () => [...entry.activations.keys()].map(key => session.captureDeletion(key)),
      settle: () => {
        if (settled) return;
        settled = true;
        entries.delete(entry);
        if (entries.size === 0) locations.delete(locator);
        if (locations.size === 0) this.sessions.delete(session);
      },
    };
    entries.add(entry);
    return entry;
  }

  register(session: ActivationSet, locator: string, name: string, record?: PersistedActivation): void {
    for (const entry of this.sessions.get(session)?.get(locator) ?? []) {
      let records = entry.activations.get(name);
      if (!records) {
        records = new Set();
        entry.activations.set(name, records);
      }
      if (record) records.add(record);
    }
  }
}
