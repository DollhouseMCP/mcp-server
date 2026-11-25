/**
 * Cost pins for indexed name lookups, counted rather than timed: a lookup visits only the entries
 * its keys match (never the whole index), and a repeated lookup recomputes no name key.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { FileStateTable } from '../../../src/storage/FileStateTable.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { UnicodeValidator } from '../../../src/security/validators/unicodeValidator.js';

const ROWS = 2000;

/** A Map that counts whole-map iterations; keyed reads (get/has) are not counted. */
function countingIterations<K, V>(source: Map<K, V>): { map: Map<K, V>; iterations: () => number } {
  let iterations = 0;
  const map = source;
  for (const method of ['entries', 'keys', 'values', 'forEach', Symbol.iterator] as const) {
    const original = (map as any)[method].bind(map);
    (map as any)[method] = (...args: unknown[]) => { iterations++; return original(...args); };
  }
  return { map, iterations: () => iterations };
}

function databaseLayer() {
  const rows = Array.from({ length: ROWS }, (_, index) => ({ id: `id-${index}`, name: `Row ${index}`, updatedAt: new Date() }));
  const where = jest.fn(async () => rows);
  const select = jest.fn(() => ({ from: jest.fn(() => ({ where })) }));
  const tx = { select, execute: jest.fn(async () => undefined) };
  return new DatabaseStorageLayer({ transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx) } as never,
    () => '11111111-1111-4111-8111-111111111111', 'skills');
}

describe('indexed lookup cost', () => {
  it('reads database candidates from the key maps, never by walking every indexed name', async () => {
    const layer = databaseLayer();
    await layer.scan();
    const state = (layer as any).getState();
    const names = countingIterations(state.nameToIdMap as Map<string, string>);
    for (const name of ['Row 5', 'row 1999', 'missing']) await layer.readIndexedPath([name]);
    expect(names.iterations()).toBe(0);
    expect((await layer.readIndexedPath(['Row 5'])).candidates).toEqual([{ reference: 'id-5', name: 'Row 5' }]);
  });

  it('recomputes no name key for a repeated lookup (the keys are memoised per distinct name)', async () => {
    const layer = databaseLayer();
    await layer.scan();
    await layer.readIndexedPath(['Row 7']);
    const normalize = jest.spyOn(UnicodeValidator, 'normalize');
    try {
      for (let attempt = 0; attempt < 5; attempt++) await layer.readIndexedPath(['Row 7']);
      expect(normalize).not.toHaveBeenCalled();
    } finally {
      normalize.mockRestore();
    }
  });

  it('visits only the matching file records for a lookup, never the whole table', () => {
    const table = new FileStateTable();
    for (let index = 0; index < ROWS; index++) {
      table.applySaved(`row-${index}.md`, 1, { filePath: `row-${index}.md`, name: `Row ${index}`,
        mtimeMs: 1, sizeBytes: 1, description: '', author: '', tags: [], version: '1' });
    }
    const records = countingIterations((table as any).records as Map<string, unknown>);
    expect(table.candidates('Row 42').map(entry => entry.filePath)).toEqual(['row-42.md']);
    expect(table.candidates('missing')).toEqual([]);
    expect(records.iterations()).toBe(0);
  });
});
