import { describe, expect, it } from '@jest/globals';
import { InvertedIndex } from '../../../src/collection/InvertedIndex.js';
import type { IndexEntry } from '../../../src/types/collection.js';

function entry(path: string, name: string, description = '', tags: string[] = []): IndexEntry {
  return { path, name, description, tags, type: 'skills', version: '1', author: 'fixture', sha: 'fixture', created: '2024-01-01' };
}

describe('InvertedIndex stopword search behavior', () => {
  it('filters all fixed stopwords while retaining mixed-query content and weights', () => {
    const index = new InvertedIndex();
    index.build([
      entry('first', 'Orbit', 'orbit', ['orbit']),
      entry('orbit', 'second'),
      entry('third', 'other', 'orbit'),
      entry('fourth', 'a an and are as at be by for from has he in is it its of on that the to was will with')
    ]);
    expect(index.search('a an and are as at be by for from has he in is it its of on that the to was will with')).toEqual([]);
    expect(index.search('quasar')).toEqual([]);
    const expected = [{ entryId: 0, score: 175 }, { entryId: 2, score: 50 }, { entryId: 1, score: 10 }];
    expect(index.search('orbit')).toEqual(expected);
    expect(index.search('the orbit and')).toEqual(expected);
    expect(index.search('the orbit and')).toEqual(expected);
  });

  it('preserves case, separator and Unicode normalization through build and search', () => {
    const index = new InvertedIndex();
    index.build([entry('one', 'Café-Orbit'), entry('two', 'other')]);
    expect(index.search('CAFÉ_orbit')).toEqual([{ entryId: 0, score: 200 }]);
    expect(index.search('cafe\u0301 orbit')).toEqual([{ entryId: 0, score: 200 }]);
    expect(index.search('THE--CAFÉ')).toEqual([{ entryId: 0, score: 100 }]);
  });

  it('clears old entries on rebuild and keeps subsequent queries stable', () => {
    const index = new InvertedIndex();
    index.build([entry('old-path', 'Orbit')]);
    expect(index.search('orbit')).toEqual([{ entryId: 0, score: 100 }]);
    index.build([entry('new-path', 'Nebula')]);
    expect(index.search('orbit')).toEqual([]);
    const expected = [{ entryId: 0, score: 100 }];
    expect(index.search('the nebula')).toEqual(expected);
    expect(index.search('the nebula')).toEqual(expected);
    expect(index.getEntry(0)?.name).toBe('Nebula');
    expect(index.size()).toBe(1);
  });
});
