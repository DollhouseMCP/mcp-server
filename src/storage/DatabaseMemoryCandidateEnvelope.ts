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

/** Canonical ordering is UTF-16 ordinal, independent of deployment locale. */
function compareDataKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
function encodeLeaf(value: unknown, countText: (text: string) => void): Data | undefined {
  if (value === undefined) return ['undefined'];
  if (value === null) return ['null'];
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value === 'string') { countText(value); return ['string', value]; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) refuse();
    return ['number', value];
  }
  return undefined;
}
function encodeArray(value: unknown[], descriptors: PropertyDescriptorMap, visit: (value: unknown) => Data): Data {
  const values: Data[] = [];
  // Sparse/extra-property arrays would lose information in a plain list.
  if (Object.keys(descriptors).length !== value.length + 1) refuse();
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable) refuse();
    values.push(visit(descriptor.value));
  }
  return ['array', values];
}
function encodeObject(descriptors: PropertyDescriptorMap, visit: (value: unknown) => Data,
  countText: (text: string) => void): Data {
  const entries: [string, Data][] = [];
  for (const key of Object.keys(descriptors).sort(compareDataKeys)) {
    countText(key);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) refuse();
    entries.push([key, visit(descriptor.value)]);
  }
  return ['object', entries];
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
    const leaf = encodeLeaf(item, countText);
    if (leaf !== undefined) return leaf;
    if (typeof item !== 'object' || item === null || ancestors.has(item)) refuse();
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) refuse();
    if (Object.getOwnPropertySymbols(item).length) refuse();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) refuse();
    ancestors.add(item);
    const child = (value: unknown) => visit(value, depth + 1);
    try { return array ? encodeArray(item, descriptors, child) : encodeObject(descriptors, child, countText); }
    finally { ancestors.delete(item); }
  };
  return visit(value, 0);
}
interface DecodeBudget { nodes: number }
function decodeObject(entries: unknown, depth: number, budget: DecodeBudget): Record<string, unknown> {
  if (!Array.isArray(entries)) refuse();
  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
      Object.hasOwn(result, entry[0])) refuse();
    Object.defineProperty(result, entry[0], { value: decodeData(entry[1], depth + 1, budget),
      writable: true, enumerable: true, configurable: true });
  }
  return result;
}
function decodeData(data: unknown, depth: number, budget: DecodeBudget): unknown {
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
    case 'object': return decodeObject(data[1], depth, budget);
    default: refuse();
  }
}
function decodeBoundedData(data: unknown): unknown { return decodeData(data, 0, { nodes: 0 }); }

export interface EncodedMemoryCandidate {
  readonly bytes: Buffer;
  readonly digest: string;
}

/** UTF-16LE preserves JS code units, including a lone surrogate, without UTF-8 loss. */
export function encodeMemoryCandidate(candidate: MemoryUpdateCandidate): EncodedMemoryCandidate {
  const encoded = encodeData(candidate);
  const plain = decodeBoundedData(encoded) as MemoryUpdateCandidate;
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
  const candidate = decodeBoundedData(encoded) as MemoryUpdateCandidate;
  const validated = encodeMemoryCandidate(candidate);
  if (!validated.bytes.equals(envelope.bytes)) refuse();
  return candidate;
}
