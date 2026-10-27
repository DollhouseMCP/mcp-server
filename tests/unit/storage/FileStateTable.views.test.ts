/**
 * Unit tests for FileStateTable
 */

import { FileStateTable } from '../../../src/storage/FileStateTable.js';
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

describe('FileStateTable', () => {
  let index: FileStateTable;

  beforeEach(() => {
    index = new FileStateTable();
  });

  describe('set and get', () => {
    it('should store and retrieve an entry by path', () => {
      const entry = makeEntry('alpha.md', 'Alpha');
      index.applySaved(entry.filePath, entry.mtimeMs, entry);

      const retrieved = index.get('alpha.md');
      expect(retrieved).toMatchObject({ status: 'indexed', entry });
    });

    it('should overwrite existing entry for same path', () => {
      const v1 = makeEntry('alpha.md', 'Alpha V1');
      const v2 = makeEntry('alpha.md', 'Alpha V2');

      index.applySaved(v1.filePath, v1.mtimeMs, v1);
      index.applySaved(v2.filePath, v2.mtimeMs, v2);

      expect(index.entries()[0].name).toBe('Alpha V2');
      expect(index.entries()).toHaveLength(1);
    });
  });

  describe('name lookup', () => {
    it('should find path by name (case-insensitive)', () => {
      index.applySaved('creative-writer.md', 1, makeEntry('creative-writer.md', 'Creative Writer'));

      expect(index.getPathByName('Creative Writer')).toBe('creative-writer.md');
      expect(index.getPathByName('creative writer')).toBe('creative-writer.md');
      expect(index.getPathByName('CREATIVE WRITER')).toBe('creative-writer.md');
    });

    it('should return undefined for unknown name', () => {
      expect(index.getPathByName('nonexistent')).toBeUndefined();
    });

    it('should update name mapping when entry name changes', () => {
      index.applySaved('alpha.md', 1, makeEntry('alpha.md', 'Old Name'));
      index.applySaved('alpha.md', 1, makeEntry('alpha.md', 'New Name'));

      expect(index.getPathByName('New Name')).toBe('alpha.md');
      expect(index.getPathByName('Old Name')).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('should remove entry from both maps', () => {
      index.applySaved('alpha.md', 1, makeEntry('alpha.md', 'Alpha'));
      index.applyDeleted('alpha.md');

      expect(index.get('alpha.md')).toBeUndefined();
      expect(index.getPathByName('Alpha')).toBeUndefined();
      expect(index.entries()).toHaveLength(0);
    });

    it('should be a no-op for non-existent path', () => {
      index.applySaved('alpha.md', 1, makeEntry('alpha.md', 'Alpha'));
      index.applyDeleted('nonexistent.md');

      expect(index.entries()).toHaveLength(1);
    });

    it('should not remove name mapping if another entry uses it', () => {
      index.applySaved('old.md', 1, makeEntry('old.md', 'Shared'));
      index.applySaved('new.md', 2, makeEntry('new.md', 'Shared'));
      index.applyDeleted('old.md');

      expect(index.getPathByName('Shared')).toBe('new.md');
    });
  });

  describe('getAll and getPaths', () => {
    it('should return all entries', () => {
      index.applySaved('a.md', 1, makeEntry('a.md', 'A'));
      index.applySaved('b.md', 1, makeEntry('b.md', 'B'));

      const all = index.entries();
      expect(all).toHaveLength(2);
      expect(all.map(e => e.name).sort()).toEqual(['A', 'B']);
    });

    it('should return all paths', () => {
      index.applySaved('a.md', 1, makeEntry('a.md', 'A'));
      index.applySaved('b.md', 1, makeEntry('b.md', 'B'));

      const paths = index.entries().map(entry => entry.filePath);
      expect(paths.sort()).toEqual(['a.md', 'b.md']);
    });
  });

  describe('clear', () => {
    it('should reset both maps', () => {
      index.applySaved('a.md', 1, makeEntry('a.md', 'A'));
      index.applySaved('b.md', 1, makeEntry('b.md', 'B'));
      index.clear();

      expect(index.entries()).toHaveLength(0);
      expect(index.entries()).toEqual([]);
      expect(index.getPathByName('A')).toBeUndefined();
    });
  });
});
