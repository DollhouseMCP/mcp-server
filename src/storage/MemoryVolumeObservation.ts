/** Metadata declarations only: observations confer no payload or cleanup authority. */
export const MAX_MEMORY_VOLUME_LIST_ENTRIES = 128;
export const MAX_MEMORY_VOLUME_LIST_SCAN = 1000;
export const MAX_MEMORY_VOLUME_LIST_DIAGNOSTICS = 64;
export const MAX_MEMORY_VOLUME_DIAGNOSTIC_LENGTH = 128;

export interface MemoryVolumeListOptions {
  readonly entryLimit?: number;
}

export interface MemoryVolumeListDiagnostic {
  readonly reason: 'entry-limit' | 'scan-limit' | 'partial' | 'unsafe' | 'corrupt' | 'alias' | 'change';
  /** Fixed, bounded explanation; never source content or an unchecked artifact name. */
  readonly message: string;
}

export interface MemoryVolumeObservation<T> {
  readonly entries: readonly T[];
  readonly complete: boolean;
  readonly returnedCount: number;
  /** Candidate entries actually observed, including any overflow sentinel. */
  readonly observedCount: number;
  readonly acceptedCount: number;
  readonly scannedCount: number;
  readonly totalCount: number | null;
  readonly diagnostics: readonly MemoryVolumeListDiagnostic[];
  readonly diagnosticsTruncated: boolean;
}

export function captureMemoryVolumeEntryLimit(options: MemoryVolumeListOptions): number {
  const limit = options.entryLimit;
  if (limit === undefined) return MAX_MEMORY_VOLUME_LIST_ENTRIES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MEMORY_VOLUME_LIST_ENTRIES) {
    throw new RangeError('Memory volume entry limit must be an integer from 1 through 128');
  }
  return limit;
}
