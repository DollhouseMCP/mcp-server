/** Exact, bounded DB handoff data; this is evidence, never restored write authority. */
import { createHash } from 'node:crypto';
import type { MemoryUpdateCandidate } from './MemoryHeadUpdateAdapter.js';

export const MEMORY_HANDOFF_MAX_ROW_BYTES = 1024 * 1024;
export const MEMORY_HANDOFF_MAX_ROWS = 64;
export const MEMORY_HANDOFF_MAX_TENANT_BYTES = 64 * MEMORY_HANDOFF_MAX_ROW_BYTES;
const MAX_CONTENT_UNITS = 256 * 1024;
const MAX_DATA_NODES = 10000;
const MAX_DATA_DEPTH = 40;

/** Undefined and omitted own properties remain distinct; no getter is invoked. */
type Data = ['undefined'] | ['null'] | ['boolean', boolean] | ['number', number] |
  ['string', string] | ['array', Data[]] | ['object', [string, Data][]];

function refuse(): never {
  throw Object.assign(new Error('Memory candidate cannot be preserved by the bounded handoff'),
    { code: 'EMEMORYHANDOFF' });
}

function encodeData(value: unknown): Data {
  let nodes = 0;
  let textUnits = 0;
  const countText = (text: string): void => {
    textUnits += text.length;
    if (textUnits > MEMORY_HANDOFF_MAX_ROW_BYTES / 2) refuse();
  };
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): Data => {
    if (++nodes > MAX_DATA_NODES || depth > MAX_DATA_DEPTH) refuse();
    if (item === undefined) return ['undefined'];
    if (item === null) return ['null'];
    if (typeof item === 'boolean') return ['boolean', item];
    if (typeof item === 'string') { countText(item); return ['string', item]; }
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return ['number', item];
    if (typeof item !== 'object' || ancestors.has(item)) refuse();
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) refuse();
    if (Object.getOwnPropertySymbols(item).length) refuse();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) refuse();
    ancestors.add(item);
    try {
      if (array) {
        const values: Data[] = [];
        // Sparse/extra-property arrays would lose information in a plain list.
        if (Object.keys(descriptors).length !== item.length + 1) refuse();
        for (let index = 0; index < item.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor?.enumerable) refuse();
          values.push(visit(descriptor.value, depth + 1));
        }
        return ['array', values];
      }
      const entries: [string, Data][] = [];
      for (const key of Object.keys(descriptors).sort()) {
        countText(key);
        const descriptor = descriptors[key];
        if (!descriptor.enumerable) refuse();
        entries.push([key, visit(descriptor.value, depth + 1)]);
      }
      return ['object', entries];
    } finally { ancestors.delete(item); }
  };
  return visit(value, 0);
}

function decodeData(data: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > MAX_DATA_NODES || depth > MAX_DATA_DEPTH || !Array.isArray(data) ||
    typeof data[0] !== 'string') refuse();
  const leaf = data[0] === 'undefined' || data[0] === 'null';
  if (data.length !== (leaf ? 1 : 2)) refuse();
  switch (data[0]) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'boolean': if (typeof data[1] !== 'boolean') refuse(); return data[1];
    case 'number': if (typeof data[1] !== 'number' || !Number.isFinite(data[1])) refuse(); return data[1];
    case 'string': if (typeof data[1] !== 'string') refuse(); return data[1];
    case 'array': {
      if (!Array.isArray(data[1])) refuse();
      return data[1].map(value => decodeData(value, depth + 1, budget));
    }
    case 'object': {
      if (!Array.isArray(data[1])) refuse();
      const result: Record<string, unknown> = {};
      for (const entry of data[1]) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
          Object.hasOwn(result, entry[0])) refuse();
        Object.defineProperty(result, entry[0], { value: decodeData(entry[1], depth + 1, budget),
          writable: true, enumerable: true, configurable: true });
      }
      return result;
    }
    default: refuse();
  }
}

export interface EncodedMemoryCandidate {
  readonly bytes: Buffer;
  readonly digest: string;
}

/** UTF-16LE preserves JS code units, including a lone surrogate, without UTF-8 loss. */
export function encodeMemoryCandidate(candidate: MemoryUpdateCandidate): EncodedMemoryCandidate {
  const encoded = encodeData(candidate);
  const plain = decodeData(encoded) as MemoryUpdateCandidate;
  if (!plain || typeof plain.content !== 'string' || plain.content.length > MAX_CONTENT_UNITS ||
    typeof plain.name !== 'string' || !plain.name) refuse();
  const bytes = Buffer.from(JSON.stringify(encoded), 'utf16le');
  if (bytes.length > MEMORY_HANDOFF_MAX_ROW_BYTES) refuse();
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

/** Inspection reconstructs data only. A decoded candidate carries no admission. */
export function decodeMemoryCandidate(envelope: EncodedMemoryCandidate): MemoryUpdateCandidate {
  if (envelope.bytes.length > MEMORY_HANDOFF_MAX_ROW_BYTES || envelope.bytes.length % 2 ||
    createHash('sha256').update(envelope.bytes).digest('hex') !== envelope.digest) refuse();
  let encoded: unknown;
  try { encoded = JSON.parse(envelope.bytes.toString('utf16le')); }
  catch { refuse(); }
  // Re-encoding enforces the same bounded graph and canonical form before return.
  const candidate = decodeData(encoded) as MemoryUpdateCandidate;
  const validated = encodeMemoryCandidate(candidate);
  if (!validated.bytes.equals(envelope.bytes)) refuse();
  return candidate;
}
