import { describe, expect, it } from '@jest/globals';
import { removeActivationRecords, upsertActivationRecord } from '../../../src/state/activation-record-utils.js';
import type { PersistedActivation } from '../../../src/state/IActivationStateStore.js';

const activation = (extra: Partial<PersistedActivation>): PersistedActivation =>
  ({ name: 'Shared', activatedAt: '2026-10-21T00:00:00Z', ...extra });

describe('exact activation removal with legacy records', () => {
  it.each(['file', 'database'] as const)('does not broaden a %s identity match into legacy display-name matches', kind => {
    const identity = { kind, value: 'target' };
    const target = activation({ identity });
    const otherFile = activation({ filename: 'other.md' });
    const ambiguousName = activation({});
    expect(removeActivationRecords([otherFile, ambiguousName, target], { name: 'Shared', identity }).records)
      .toEqual([otherFile, ambiguousName]);
  });

  it('does not broaden a filename match into an ambiguous name-only match', () => {
    const target = activation({ filename: 'target.md' });
    const ambiguous = activation({});
    expect(removeActivationRecords([ambiguous, target], { name: 'Shared', filename: 'target.md' }).records)
      .toEqual([ambiguous]);
  });

  it('can remove an exact legacy filename using a file identity', () => {
    const target = activation({ filename: 'target.md' });
    const other = activation({ filename: 'other.md' });
    expect(removeActivationRecords([other, target], { name: 'Shared', identity: { kind: 'file', value: 'target.md' } }).records)
      .toEqual([other]);
  });

  it('preserves the unique name-only upgrade fallback without overriding a conflicting durable key', () => {
    const input = { name: 'Shared', identity: { kind: 'file' as const, value: 'target.md' } };
    expect(removeActivationRecords([activation({})], input).records).toEqual([]);
    const other = activation({ filename: 'other.md' });
    expect(removeActivationRecords([other], input).records).toEqual([other]);
  });
  it.each([false, true])('conditional removal preserves a newer same-key lifetime (deactivated=%s)', deactivated => {
    const input = { name: 'Shared', filename: 'target.md' };
    let records: PersistedActivation[] = [];
    upsertActivationRecord(records, 'persona', input, 'same-timestamp');
    const captured = records[0];
    if (deactivated) records = removeActivationRecords(records, input).records;
    upsertActivationRecord(records, 'persona', input, 'same-timestamp');
    const result = removeActivationRecords(records, input, captured);
    expect(result.removed).toBe(false);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).not.toBe(captured);
  });

  it('conditional removal never widens to another same-name record', () => {
    const captured = activation({});
    const other = activation({ filename: 'other.md' });
    expect(removeActivationRecords([captured, other], { name: 'Shared' }, captured))
      .toEqual({ records: [other], removed: true });
  });

});
