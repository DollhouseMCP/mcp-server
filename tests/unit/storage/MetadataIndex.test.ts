/**
 * Unit tests for MetadataIndex
 */

import { MetadataIndex } from '../../../src/storage/MetadataIndex.js';
import type { ElementIndexEntry } from '../../../src/storage/types.js';

function makeEntry(filePath: string, name: string): ElementIndexEntry {
  return {
    filePath,
    name,
    description: `Description of ${name}`,
    version: '1.0.0',
    author: 'tester',
    tags: [],
    mtimeMs: Date.now(),
    sizeBytes: 100,
  };
}

describe('MetadataIndex', () => {
  let index: MetadataIndex;

  beforeEach(() => {
    index = new MetadataIndex();
  });

  describe('set and get', () => {
    it('should store and retrieve an entry by path', () => {
      const entry = makeEntry('alpha.md', 'Alpha');
      index.set(entry);

      const retrieved = index.get('alpha.md');
      expect(retrieved).toEqual(entry);
    });

    it('should overwrite existing entry for same path', () => {
      const v1 = makeEntry('alpha.md', 'Alpha V1');
      const v2 = makeEntry('alpha.md', 'Alpha V2');

      index.set(v1);
      index.set(v2);

      expect(index.get('alpha.md')?.name).toBe('Alpha V2');
      expect(index.size).toBe(1);
    });
  });

  describe('name lookup', () => {
    it('should find path by name (case-insensitive)', () => {
      index.set(makeEntry('creative-writer.md', 'Creative Writer'));

      expect(index.getPathByName('Creative Writer')).toBe('creative-writer.md');
      expect(index.getPathByName('creative writer')).toBe('creative-writer.md');
      expect(index.getPathByName('CREATIVE WRITER')).toBe('creative-writer.md');
    });

    it('should return undefined for unknown name', () => {
      expect(index.getPathByName('nonexistent')).toBeUndefined();
    });

    it('should update name mapping when entry name changes', () => {
      index.set(makeEntry('alpha.md', 'Old Name'));
      index.set(makeEntry('alpha.md', 'New Name'));

      expect(index.getPathByName('New Name')).toBe('alpha.md');
      expect(index.getPathByName('Old Name')).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('should remove entry from both maps', () => {
      index.set(makeEntry('alpha.md', 'Alpha'));
      index.remove('alpha.md');

      expect(index.get('alpha.md')).toBeUndefined();
      expect(index.getPathByName('Alpha')).toBeUndefined();
      expect(index.size).toBe(0);
    });

    it('should be a no-op for non-existent path', () => {
      index.set(makeEntry('alpha.md', 'Alpha'));
      index.remove('nonexistent.md');

      expect(index.size).toBe(1);
    });

    it('should not remove name mapping if another entry uses it', () => {
      // Edge case: two files had same normalized name at different times
      index.set(makeEntry('old.md', 'Shared'));
      index.set(makeEntry('new.md', 'Shared'));
      // Now nameToPath points to 'new.md'
      index.remove('old.md');

      // Name mapping should still exist for new.md
      expect(index.getPathByName('Shared')).toBe('new.md');
    });
  });

  describe('getAll and getPaths', () => {
    it('should return all entries', () => {
      index.set(makeEntry('a.md', 'A'));
      index.set(makeEntry('b.md', 'B'));

      const all = index.getAll();
      expect(all).toHaveLength(2);
      expect(all.map(e => e.name).sort()).toEqual(['A', 'B']);
    });

    it('should return all paths', () => {
      index.set(makeEntry('a.md', 'A'));
      index.set(makeEntry('b.md', 'B'));

      const paths = index.getPaths();
      expect(paths.sort()).toEqual(['a.md', 'b.md']);
    });
  });

  describe('clear', () => {
    it('should reset both maps', () => {
      index.set(makeEntry('a.md', 'A'));
      index.set(makeEntry('b.md', 'B'));
      index.clear();

      expect(index.size).toBe(0);
      expect(index.getAll()).toEqual([]);
      expect(index.getPathByName('A')).toBeUndefined();
    });
  });
});
