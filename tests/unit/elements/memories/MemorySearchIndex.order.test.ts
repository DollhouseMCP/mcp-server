import { MemorySearchIndex } from '../../../../src/elements/memories/MemorySearchIndex.js';
import type { MemoryEntry } from '../../../../src/elements/memories/types.js';

describe('MemorySearchIndex result order', () => {
  it('keeps the newest 100 equal-score matches after indexing', async () => {
    const entries = new Map<string, MemoryEntry>();
    const baseTime = Date.parse('2026-09-28T00:00:00Z');
    for (let i = 0; i < 101; i++) {
      const id = `entry-${i}`;
      entries.set(id, {
        id,
        timestamp: new Date(baseTime + i * 1000),
        content: 'shared searchable content',
        tags: ['shared'],
        metadata: { tags: ['shared'] },
      });
    }
    const index = new MemorySearchIndex({ indexThreshold: 100 });
    const expected = Array.from({ length: 100 }, (_, i) => `entry-${100 - i}`);

    expect(index.search({ content: 'shared' }, entries).map(result => result.entry.id)).toEqual(expected);
    await index.buildIndex(entries);
    expect(index.search({ content: 'shared' }, entries).map(result => result.entry.id)).toEqual(expected);
    expect(index.search({ tags: ['shared'] }, entries).map(result => result.entry.id)).toEqual(expected);
  });

  it('uses later insertion when indexed scores and timestamps tie', async () => {
    const tiedAt = new Date('2026-09-28T00:00:00Z');
    const entries = new Map<string, MemoryEntry>();
    for (let i = 0; i < 101; i++) {
      const id = `entry-${i}`;
      entries.set(id, { id, timestamp: tiedAt, content: 'same' });
    }
    const index = new MemorySearchIndex({ indexThreshold: 100 });
    await index.buildIndex(entries);

    const results = index.search({}, entries).map(result => result.entry.id);
    expect(results[0]).toBe('entry-100');
    expect(results).not.toContain('entry-0');
  });
});
