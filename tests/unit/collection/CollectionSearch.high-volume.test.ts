import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import { CollectionSearch } from '../../../src/collection/CollectionSearch.js';
import { InvertedIndex } from '../../../src/collection/InvertedIndex.js';
import type { CollectionIndex, IndexEntry } from '../../../src/types/collection.js';
import type { GitHubClient } from '../../../src/collection/GitHubClient.js';

const generateLargeIndex = (size: number, version: string): CollectionIndex => {
  const entries: Record<string, IndexEntry[]> = {
    personas: [],
    skills: [],
    templates: [],
    agents: []
  };

  for (let i = 0; i < size; i++) {
    const typeKeys = Object.keys(entries) as (keyof typeof entries)[];
    const type = typeKeys[i % typeKeys.length];
    entries[type].push({
      path: `library/${type}/category-${i % 10}/item-${i}.md`,
      type,
      name: `Test Item ${i}`,
      description: `Synthetic description for item ${i} with keyword ${i % 5 === 0 ? 'alpha' : 'beta'}`,
      version: '1.0.0',
      author: `Author ${i % 7}`,
      tags: [`tag-${i % 15}`, type],
      sha: `sha-${i}`,
      category: `category-${i % 10}`,
      created: new Date(2024, 0, (i % 27) + 1).toISOString(),
      license: 'MIT'
    });
  }

  return {
    version,
    generated: new Date().toISOString(),
    total_elements: size,
    index: entries,
    metadata: {
      build_time_ms: 0,
      file_count: size,
      skipped_files: 0,
      categories: 10,
      nodejs_version: process.version,
      builder_version: '1.0.0'
    }
  };
};

const createSearch = () => {
  const githubClient = {
    fetchFromGitHub: jest.fn()
  } as unknown as GitHubClient;

  const search = new CollectionSearch(githubClient);
  return { search, githubClient };
};

describe('CollectionSearch high-volume behavior', () => {
  let buildSpy: jest.SpyInstance;

  beforeEach(() => {
    buildSpy = jest.spyOn(InvertedIndex.prototype, 'build');
  });

  afterEach(() => {
    buildSpy.mockRestore();
  });

  it('reuses inverted index without rebuilding when version remains constant', async () => {
    const { search } = createSearch();
    const indexCache = {
      getIndex: jest.fn().mockResolvedValue(generateLargeIndex(8000, 'v1'))
    };
    (search as any).indexCache = indexCache;

    const firstResults = await search.searchCollectionWithOptions('alpha', {
      pageSize: 10
    });
    expect(firstResults.total).toBeGreaterThan(0);
    expect(buildSpy).toHaveBeenCalledTimes(1);

    const secondResults = await search.searchCollectionWithOptions('beta', {
      pageSize: 25
    });
    expect(secondResults.total).toBeGreaterThan(0);
    expect(buildSpy).toHaveBeenCalledTimes(1); // reused cached inverted index
  });

  it('rebuilds inverted index when index version changes', async () => {
    const { search } = createSearch();
    const indexCache = {
      getIndex: jest
        .fn()
        .mockResolvedValueOnce(generateLargeIndex(4000, 'v1'))
        .mockResolvedValueOnce(generateLargeIndex(4000, 'v2'))
    };
    (search as any).indexCache = indexCache;

    await search.searchCollectionWithOptions('alpha', {});
    await search.searchCollectionWithOptions('alpha', {});

    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it('handles cache churn across many queries without hitting GitHub', async () => {
    const { search, githubClient } = createSearch();
    const largeIndex = generateLargeIndex(12000, 'v-cache');
    (search as any).indexCache = {
      getIndex: jest.fn().mockResolvedValue(largeIndex)
    };

    const queries = ['alpha', 'beta', 'category-3', 'Author 5'];
    for (const query of queries) {
      const results = await search.searchCollectionWithOptions(query, {
        pageSize: 50
      });
      expect(results.total).toBeGreaterThan(0);
    }

    expect(githubClient.fetchFromGitHub).not.toHaveBeenCalled();
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });
});
