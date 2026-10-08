import { describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { encodeMemoryCandidate, decodeMemoryCandidate, MEMORY_HANDOFF_MAX_ROW_BYTES } from '../../../src/storage/DatabaseMemoryCandidateEnvelope.js';
import type { MemoryUpdateCandidate } from '../../../src/storage/MemoryHeadUpdateAdapter.js';

const candidate = (): MemoryUpdateCandidate => ({ content: 'Exact candidate\n原文\uD800', name: 'owned-name',
  metadata: { author: 'author', version: '1', description: 'exact', tags: ['one'], visibility: undefined } });
const raw = (data: unknown) => { const bytes = Buffer.from(JSON.stringify(data), 'utf16le');
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') }; };

describe('bounded exact candidate handoff data', () => {
  it('roundtrips all submitted data including undefined, extensions, a surrogate and literal prototype keys', () => {
    const original = candidate();
    Object.defineProperty(original.metadata, '__proto__', { value: 'literal', enumerable: true });
    Object.assign(original.metadata, { extension: { enabled: true, absent: undefined, none: null, nested: [2, '文'] } });
    const restored = decodeMemoryCandidate(encodeMemoryCandidate(original));
    expect(restored).toEqual(original); expect(Object.hasOwn(restored.metadata, 'visibility')).toBe(true);
    expect(Object.getPrototypeOf(restored.metadata)).toBe(Object.prototype);
    expect(restored.content).toBe(original.content);
  });
  it('does not invoke a getter while refusing unrepresentable metadata', () => {
    const original = candidate(); const getter = jest.fn(() => 'must not execute');
    Object.defineProperty(original.metadata, 'hidden', { get: getter, enumerable: true });
    expect(() => encodeMemoryCandidate(original)).toThrow('bounded handoff'); expect(getter).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -0, 1n, new Date(), Symbol('unsupported'), () => 'callback'])('refuses unsupported data without dropping it: %s', value => {
    const original = candidate(); Object.assign(original.metadata, { extension: value });
    expect(() => encodeMemoryCandidate(original)).toThrow('bounded handoff');
  });
  it('refuses cycles, sparse arrays and extra array properties', () => {
    for (const value of [new Array(2), Object.assign(['tag'], { hidden: true })]) {
      const original = candidate(); Object.assign(original.metadata, { extension: value });
      expect(() => encodeMemoryCandidate(original)).toThrow('bounded handoff');
    }
    const original = candidate(); Object.assign(original.metadata, { cycle: original.metadata });
    expect(() => encodeMemoryCandidate(original)).toThrow('bounded handoff');
  });
  it('bounds depth and expanded data work', () => {
    const original = candidate(); let deep: unknown = 'end'; for (let n = 0; n < 41; n++) deep = { nested: deep };
    Object.assign(original.metadata, { extension: deep }); expect(() => encodeMemoryCandidate(original)).toThrow('bounded handoff');
    Object.assign(original.metadata, { extension: new Array(10001).fill(null) });
    expect(() => encodeMemoryCandidate(original)).toThrow('bounded handoff');
  });
  it('refuses the existing save-cap overflow and the encoded byte envelope overflow', () => {
    const original = candidate(); expect(() => encodeMemoryCandidate({ ...original, content: 'x'.repeat(256 * 1024 + 1) })).toThrow('bounded handoff');
    Object.assign(original.metadata, { extension: 'x'.repeat(MEMORY_HANDOFF_MAX_ROW_BYTES) });
    expect(() => encodeMemoryCandidate(original)).toThrow('bounded handoff');
  });
  it('refuses changed bytes and malformed, duplicate-key or deeply nested inspection records', () => {
    const encoded = encodeMemoryCandidate(candidate()); const changed = Buffer.from(encoded.bytes); changed[0] ^= 1;
    expect(() => decodeMemoryCandidate({ ...encoded, bytes: changed })).toThrow('bounded handoff');
    expect(() => decodeMemoryCandidate(raw(['callback', 'ignored']))).toThrow('bounded handoff');
    expect(() => decodeMemoryCandidate(raw(['object', [['same', ['null']], ['same', ['null']]]]))).toThrow('bounded handoff');
    let deep: unknown = ['null']; for (let n = 0; n < 41; n++) deep = ['array', [deep]];
    expect(() => decodeMemoryCandidate(raw(deep))).toThrow('bounded handoff');
  });
});
