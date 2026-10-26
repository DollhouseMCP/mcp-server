import type { ElementIndexEntry } from './types.js';

/**
 * Parsed metadata can be V8 sliced strings retaining the entire source file.
 * A UTF-16 byte round trip owns the characters without altering lone surrogates.
 */
function copyString(value: string): string {
  return Buffer.from(value, 'utf16le').toString('utf16le');
}

/** Copy every string field, including tags and optional metadata, at index ownership. */
export function flattenIndexEntry(entry: ElementIndexEntry): ElementIndexEntry {
  return Object.fromEntries(Object.entries(entry).map(([key, value]) => {
    if (typeof value === 'string') return [key, copyString(value)];
    if (Array.isArray(value)) return [key, value.map(item => typeof item === 'string' ? copyString(item) : item)];
    return [key, value];
  })) as unknown as ElementIndexEntry;
}
