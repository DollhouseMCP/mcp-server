/**
 * Unit tests for StorageManifest
 */

import { StorageManifest } from '../../../src/storage/StorageManifest.js';
import type { StorageItemMetadata } from '../../../src/storage/types.js';

function makeMeta(relPath: string, mtimeMs: number): StorageItemMetadata {
  return { relativePath: relPath, absolutePath: `/dir/${relPath}`, mtimeMs, sizeBytes: 100 };
}

function makeStatsMap(entries: Array<[string, number]>): Map<string, StorageItemMetadata> {
  const map = new Map<string, StorageItemMetadata>();
  for (const [relPath, mtimeMs] of entries) {
    map.set(relPath, makeMeta(relPath, mtimeMs));
  }
  return map;
}

describe('StorageManifest', () => {
  let manifest: StorageManifest;

  beforeEach(() => {
    manifest = new StorageManifest();
  });

  describe('diff on empty manifest', () => {
    it('should report all files as added when manifest is empty', () => {
      const stats = makeStatsMap([['a.md', 1000], ['b.md', 2000]]);
      const result = manifest.diff(stats);

      expect(result.added).toEqual(['a.md', 'b.md']);
      expect(result.modified).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.unchanged).toEqual([]);
    });
  });

  describe('diff with no changes', () => {
    it('should report all files as unchanged when mtimes match', () => {
      const stats = makeStatsMap([['a.md', 1000], ['b.md', 2000]]);
      manifest.update(stats);

      const result = manifest.diff(stats);

      expect(result.added).toEqual([]);
      expect(result.modified).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.unchanged).toEqual(['a.md', 'b.md']);
    });
  });

  describe('diff with mixed changes', () => {
    it('should detect added, modified, removed, and unchanged', () => {
      const initial = makeStatsMap([['a.md', 1000], ['b.md', 2000], ['c.md', 3000]]);
      manifest.update(initial);

      // a.md: unchanged, b.md: modified, c.md: removed, d.md: added
      const current = makeStatsMap([['a.md', 1000], ['b.md', 5000], ['d.md', 4000]]);
      const result = manifest.diff(current);

      expect(result.unchanged).toEqual(['a.md']);
      expect(result.modified).toEqual(['b.md']);
      expect(result.added).toEqual(['d.md']);
      expect(result.removed).toEqual(['c.md']);
    });
  });

  describe('single entry operations', () => {
    it('should set a single entry', () => {
      manifest.set('x.md', 9000);

      const stats = makeStatsMap([['x.md', 9000]]);
      const result = manifest.diff(stats);

      expect(result.unchanged).toEqual(['x.md']);
    });

    it('should remove a single entry', () => {
      manifest.set('a.md', 1000);
      manifest.set('b.md', 2000);
      manifest.remove('a.md');

      const stats = makeStatsMap([['b.md', 2000]]);
      const result = manifest.diff(stats);

      expect(result.unchanged).toEqual(['b.md']);
      expect(result.removed).toEqual([]);
    });
  });

  describe('clear', () => {
    it('should reset to cold-start state', () => {
      manifest.set('a.md', 1000);
      manifest.clear();

      expect(manifest.size).toBe(0);

      const stats = makeStatsMap([['a.md', 1000]]);
      const result = manifest.diff(stats);
      expect(result.added).toEqual(['a.md']);
    });
  });

  describe('size', () => {
    it('should track number of entries', () => {
      expect(manifest.size).toBe(0);
      manifest.set('a.md', 1000);
      expect(manifest.size).toBe(1);
      manifest.set('b.md', 2000);
      expect(manifest.size).toBe(2);
      manifest.remove('a.md');
      expect(manifest.size).toBe(1);
    });
  });
});
