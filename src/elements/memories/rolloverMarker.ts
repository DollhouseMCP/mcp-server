import type { MemoryVolumeRecord } from './types.js';

/** Informational marker text shared by the preflight and the actual write. */
export function rolloverMarkerText(
  sealedCount: number,
  records: readonly MemoryVolumeRecord[],
  reason?: string,
): string {
  const volumes = records.map(record => record.volume);
  const first = records[0]?.firstEntryAt;
  const last = records.at(-1)?.lastEntryAt;
  const range = first && last ? ` (${first} to ${last})` : '';
  return `Rolled over ${sealedCount} entries into archive volume${volumes.length === 1 ? '' : 's'} ` +
    `${volumes.join(', ')}${range}.` + (reason ? ` Reason: ${reason}` : '');
}
