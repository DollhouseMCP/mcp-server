import { expect, it } from '@jest/globals';
import { flattenIndexEntry } from '../../../src/storage/flattenIndexEntry.js';
import type { ElementIndexEntry } from '../../../src/storage/types.js';

it('copies every metadata string and preserves UTF-16 characters and optional fields', () => {
  const value = 'long metadata with emoji 😀 and lone surrogate \ud800';
  const entry: ElementIndexEntry = {
    filePath: value, name: value, description: value, version: value,
    author: value, tags: [value], memoryType: value, userId: value,
    mtimeMs: 123, sizeBytes: 456, autoLoad: true, priority: 2, totalEntries: 3,
  };
  const copied = flattenIndexEntry(entry);
  expect(copied).toEqual(entry);
  expect(copied).not.toBe(entry);
  expect(copied.tags).not.toBe(entry.tags);
});

it('preserves mixed arrays and non-string scalar metadata', () => {
  const entry = { filePath: 'memory.yaml', name: 'memory', tags: ['text', 2024, null, false],
    autoLoad: false, priority: 0, description: null, sizeBytes: 12, extra: undefined } as unknown as ElementIndexEntry;
  const copied = flattenIndexEntry(entry);
  expect(copied).toEqual(entry);
  expect(copied.tags).not.toBe(entry.tags);
});
