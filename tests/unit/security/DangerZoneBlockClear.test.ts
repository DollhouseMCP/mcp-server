import { describe, it, expect } from '@jest/globals';
import { prepareDangerZoneBlockClear, revalidateDangerZoneBlockClear } from '../../../src/security/DangerZoneBlockClear.js';

const TARGET = 'orphan-agent';
const blocks = {
  [TARGET]: { eventId: 'event-1', verificationId: 'legacy-id', sessionId: 'default', blockedAt: '2026-01-01T00:00:00Z', reason: 'Stopped', extra: { retained: true } },
  'other-agent': { eventId: 'event-2', sessionId: 'live-owner', blockedAt: '2026-01-02T00:00:00Z', reason: 'Still blocked', extra: ['untouched', 'é'] },
};
const original = JSON.stringify({ version: 1, blocks, extraTopLevel: { retained: 'exact value' } });

describe('Single DangerZone block clear proposal (no authorization or I/O)', () => {
  it('proposes one removal and retains every other block and unknown metadata', () => {
    const proposal = prepareDangerZoneBlockClear(original, TARGET);
    expect(JSON.parse(proposal.replacement)).toEqual({ version: 1, blocks: { 'other-agent': blocks['other-agent'] }, extraTopLevel: { retained: 'exact value' } });
    expect(proposal.originalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal.blockSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(JSON.parse(original).blocks[TARGET]).toEqual(blocks[TARGET]);
    expect(() => revalidateDangerZoneBlockClear(original, proposal)).not.toThrow();
  });

  it('binds legacy blocks without manufacturing a new event or dead-owner claim', () => {
    const raw = JSON.stringify({ version: 1, blocks: { old: { reason: 'Legacy block', blockedAt: '2020-01-01T00:00:00Z' } } });
    expect(JSON.parse(prepareDangerZoneBlockClear(raw, 'old').replacement)).toEqual({ version: 1, blocks: {} });
  });

  it.each([
    original + '\n',
    JSON.stringify({ version: 1, blocks: { ...blocks, [TARGET]: { ...blocks[TARGET], eventId: 'replacement-event' } } }),
    JSON.stringify({ version: 1, blocks: { ...blocks, 'new-agent': { reason: 'Added after display' } } }),
  ])('requires renewed approval for any changed snapshot', current => {
    expect(() => revalidateDangerZoneBlockClear(current, prepareDangerZoneBlockClear(original, TARGET))).toThrow('snapshot changed');
  });

  it('refuses a modified proposed replacement despite an unchanged file', () => {
    const proposal = prepareDangerZoneBlockClear(original, TARGET);
    expect(() => revalidateDangerZoneBlockClear(original, { ...proposal, replacement: '{"version":1,"blocks":{}}' })).toThrow('proposal does not match');
  });

  it.each(['{}', '[]', 'null', '{', '{"version":2,"blocks":{}}', '{"version":1,"blocks":[]}', '{"version":1,"blocks":{"orphan-agent":null}}'])('refuses unsupported snapshots %p', raw => {
    expect(() => prepareDangerZoneBlockClear(raw, TARGET)).toThrow();
  });

  it.each(['', ' orphan-agent', 'orphan-agent ', 'missing-agent', 'constructor'])('refuses an absent or inexact own key %p', name => {
    expect(() => prepareDangerZoneBlockClear(original, name)).toThrow();
  });

  it('handles an own __proto__ block as data without changing the object prototype', () => {
    const raw = '{"version":1,"blocks":{"__proto__":{"reason":"Legacy"},"other":{"reason":"Keep"}}}';
    const proposal = prepareDangerZoneBlockClear(raw, '__proto__');
    expect(JSON.parse(proposal.replacement).blocks).toEqual({ other: { reason: 'Keep' } });
    expect(Object.hasOwn({}, 'reason')).toBe(false);
  });

  it('bounds UTF-8 bytes before JSON parsing', () => {
    expect(() => prepareDangerZoneBlockClear('é'.repeat(5 * 1024 * 1024 + 1), TARGET)).toThrow('10 MiB byte limit');
  });

  it.each([
    '{"version":1,"blocks":{"orphan-agent":{},"other":{"sequence":9007199254740993}}}',
    '{"version":1,"blocks":{"orphan-agent":{"eventId":"old","eventId":"new"},"other":{}}}',
    '{"version":1,"blocks":{"orphan-agent":{},"other":{}},"blocks":{"orphan-agent":{}}}',
  ])('refuses ambiguous snapshots rather than altering unrelated data', raw => {
    expect(() => prepareDangerZoneBlockClear(raw, TARGET)).toThrow('noncanonical JSON tokens');
  });
});
