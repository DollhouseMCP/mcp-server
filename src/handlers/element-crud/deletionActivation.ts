import { logger } from '../../utils/logger.js';
import type { PersistedActivation } from '../../state/IActivationStateStore.js';

export { resolvedActivationLocator as deletionLocator } from '../../state/PendingActivationDeletions.js';
import { resolvedActivationLocator as deletionLocator } from '../../state/PendingActivationDeletions.js';
export { recordedActivation } from '../../state/activation-record-utils.js';

export type DeletionTarget = object;

export function findStoredActivation(records: PersistedActivation[], reference: string): PersistedActivation | undefined {
  const exact = records.find(record => record.identity?.value === reference)
    ?? records.find(record => record.filename === reference);
  if (exact) return exact;
  const names = records.filter(record => record.name === reference);
  return names.length === 1 ? names[0] : undefined;
}

function countActivationNames(records: PersistedActivation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.name, (counts.get(record.name) ?? 0) + 1);
  return counts;
}

/** Resolve name-only aliases while the authoritative definition still exists. */
export async function captureDeletedActivations(
  records: PersistedActivation[], target: DeletionTarget, filename: string,
  resolve: (reference: string) => Promise<DeletionTarget | undefined>,
  type?: string,
): Promise<PersistedActivation[]> {
  const nameCounts = countActivationNames(records);
  const matches = await Promise.all(records.map(async record => {
    const key = record.identity?.value ?? record.filename;
    if (key) return key === filename;
    if (nameCounts.get(record.name) !== 1) return false;
    try {
      const resolved = await resolve(record.name);
      return resolved !== undefined && (resolved === target || deletionLocator(resolved) === filename);
    } catch (error) {
      logger.warn('Retained unresolved activation during deletion capture', { type, name: record.name, error });
      return false;
    }
  }));
  return records.filter((_record, index) => matches[index]);
}

/** Capture is synchronous at storage commit; completion remains best-effort. */
export interface DeletionCleanup {
  (): Promise<void>;
  onCommitted?: () => void;
  settle?: () => void;
}

export function atDeletionCommit(capture: () => () => Promise<void>): DeletionCleanup {
  let complete: () => Promise<void> = () => Promise.resolve();
  return Object.assign(() => complete(), {
    onCommitted: () => {
      try {
        complete = capture();
      } catch (error) {
        // A committed delete must not report failure if cleanup preparation fails.
        complete = () => Promise.reject(error);
      }
    },
  });
}

/** Refresh lifetimes at commit, using aliases resolved while the definition existed. */
export function currentDeletedActivations(
  current: PersistedActivation[], prepared: PersistedActivation[], filename: string,
): PersistedActivation[] {
  const nameCounts = countActivationNames(current);
  const aliases = new Set(prepared.filter(record => !record.identity && !record.filename).map(record => record.name));
  return current.filter(record => {
    const key = record.identity?.value ?? record.filename;
    if (key) return key === filename;
    return aliases.has(record.name) && nameCounts.get(record.name) === 1;
  });
}
