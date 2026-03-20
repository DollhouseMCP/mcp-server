import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';
import { CollectionSearch } from '../../../src/collection/CollectionSearch.js';
import { InvertedIndex } from '../../../src/collection/InvertedIndex.js';
import { CollectionSeeder } from '../../../src/collection/CollectionSeeder.js';
import type { CollectionIndex, IndexEntry } from '../../../src/types/collection.js';
import type { CollectionCache, CollectionItem } from '../../../src/cache/CollectionCache.js';
import type { GitHubClient } from '../../../src/collection/GitHubClient.js';

const sampleEntries: IndexEntry[] = [
  {
    path: 'library/personas/guides/alpha.md',
    type: 'personas',
    name: 'Alpha Guide',
    description: 'Helpful persona',
    version: '1.0.0',
    author: 'Dollhouse',
    tags: ['guide', 'alpha'],
    sha: 'alpha-sha',
    category: 'guides',
    created: new Date('2024-01-01').toISOString(),
    license: 'AGPL'
  },
  {
    path: 'library/skills/dev/beta.md',
    type: 'skills',
    name: 'Beta Skill',
    description: 'Skill beta',
    version: '1.0.0',
    author: 'Dollhouse',
    tags: ['beta'],
    sha: 'beta-sha',
    category: 'dev',
    created: new Date('2024-01-02').toISOString(),
    license: 'AGPL'
  }
];

const sampleIndex: CollectionIndex = {
  version: 'index-v1',
  generated: new Date().toISOString(),
  total_elements: sampleEntries.length,
  index: {
    personas: [sampleEntries[0]],
    skills: [sampleEntries[1]]
  },
  metadata: {
    build_time_ms: 100,
    file_count: sampleEntries.length,
    skipped_files: 0,
    categories: 2,
    nodejs_version: 'v20.10.0',
    builder_version: '1.0.0'
  }
};

type MockIndexCache = { getIndex: jest.Mock };

function createSearch(overrides?: {
  githubClient?: Partial<GitHubClient>;
  collectionCache?: Partial<CollectionCache>;
  indexCache?: MockIndexCache;
}) {
  const githubClient = overrides?.githubClient ?? {
    fetchFromGitHub: jest.fn()
  };

  const collectionCache = overrides?.collectionCache ?? {
    searchCache: jest.fn().mockResolvedValue([]),
    saveCache: jest.fn().mockResolvedValue(undefined)
  };

  const search = new CollectionSearch(
    githubClient as unknown as GitHubClient,
    collectionCache as unknown as CollectionCache
  );

  const indexCache =
    overrides?.indexCache ??
    ({
      getIndex: jest.fn().mockResolvedValue(sampleIndex)
    } as MockIndexCache);

  (search as any).indexCache = indexCache;

  return { search, githubClient, collectionCache, indexCache };
}

let buildSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  if (buildSpy) {
    buildSpy.mockRestore();
  }
  buildSpy = jest.spyOn(InvertedIndex.prototype, 'build');
});

afterAll(() => {
  buildSpy.mockRestore();
});

describe('CollectionSearch - searchCollectionWithOptions', () => {
  it('uses inverted index results with filters and pagination', async () => {
    const { search, indexCache } = createSearch();

    const results = await search.searchCollectionWithOptions('guide', {
      elementType: 'personas',
      pageSize: 1,
      page: 1
    });

    expect(indexCache.getIndex).toHaveBeenCalled();
    expect(buildSpy).toHaveBeenCalled();
    expect(results.items).toHaveLength(1);
    expect(results.items[0].type).toBe('personas');
    expect(results.total).toBe(1);
  });

  it('falls back to linear scan when inverted index is empty', async () => {
    const isEmptySpy = jest.spyOn(InvertedIndex.prototype, 'isEmpty').mockReturnValue(true);
    const { search } = createSearch();

    const results = await search.searchCollectionWithOptions('beta', {
      sortBy: 'name'
    });

    expect(results.total).toBe(1);
    expect(results.items[0].name).toBe('Beta Skill');
    isEmptySpy.mockRestore();
  });

  it('returns empty results when validation fails', async () => {
    const { search, indexCache } = createSearch();
    const results = await search.searchCollectionWithOptions('', {});
    expect(results.items).toHaveLength(0);
    expect(indexCache.getIndex).not.toHaveBeenCalled();
  });

  it('falls back to legacy search when index search fails', async () => {
    const { search } = createSearch();
    jest.spyOn(search as any, 'searchFromIndex').mockRejectedValue(new Error('index failure'));
    jest.spyOn(search as any, 'searchCollection').mockResolvedValue([
      {
        path: 'library/personas/helpers/fallback.md',
        name: 'fallback.md',
        sha: 'fallback-sha'
      }
    ]);

    const results = await search.searchCollectionWithOptions('fallback', { pageSize: 5 });
    expect(results.items).toHaveLength(1);
    expect(results.items[0].type).toBe('personas');
  });
});

describe('CollectionSearch - searchCollection', () => {
  it('returns GitHub API results and updates cache', async () => {
    const githubItems = [
      {
        name: 'alpha.md',
        path: 'library/personas/guides/alpha.md',
        sha: 'api-sha'
      }
    ];

    const githubClient = {
      fetchFromGitHub: jest.fn().mockResolvedValue({ items: githubItems })
    };

    const collectionCache = {
      searchCache: jest.fn(),
      saveCache: jest.fn().mockResolvedValue(undefined)
    };

    const { search } = createSearch({ githubClient, collectionCache });
    const results = await search.searchCollection('alpha');

    expect(results).toEqual(githubItems);
    expect(collectionCache.saveCache).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ path: 'library/personas/guides/alpha.md' })
      ])
    );
  });

  it('falls back to cache search when GitHub API fails', async () => {
    const cacheItems: CollectionItem[] = [
      {
        name: 'cached.md',
        path: 'library/personas/cache/cached.md',
        sha: 'cache-sha',
        last_modified: new Date().toISOString()
      }
    ];

    const githubClient = {
      fetchFromGitHub: jest.fn().mockRejectedValue(new Error('network fail'))
    };

    const collectionCache = {
      searchCache: jest.fn().mockResolvedValue(cacheItems),
      saveCache: jest.fn()
    };

    const { search } = createSearch({ githubClient, collectionCache });
    const results = await search.searchCollection('cached');

    expect(results).toHaveLength(1);
    expect(results[0].path).toBe(cacheItems[0].path);
  });

  it('uses seed data when cache is empty', async () => {
    const seedItems: CollectionItem[] = [
      {
        name: 'seed.md',
        path: 'library/personas/seed/seed.md',
        sha: 'seed-sha',
        last_modified: new Date().toISOString()
      }
    ];
    const seedSpy = jest.spyOn(CollectionSeeder, 'getSeedData').mockReturnValue(seedItems);

    const githubClient = {
      fetchFromGitHub: jest.fn().mockRejectedValue(new Error('network fail'))
    };

    const collectionCache = {
      searchCache: jest.fn().mockResolvedValue([]),
      saveCache: jest.fn().mockResolvedValue(undefined)
    };

    const { search } = createSearch({ githubClient, collectionCache });
    const seedMatches = (search as any).searchSeedData('seed');
    expect(seedMatches).toHaveLength(1);
    const results = await search.searchCollection('seed');

    expect(results).toHaveLength(1);
    expect(results[0].path).toBe(seedItems[0].path);
    expect(collectionCache.saveCache).toHaveBeenCalledWith(expect.any(Array));
    seedSpy.mockRestore();
  });
});

describe('CollectionSearch performance characteristics', () => {
  it('reuses inverted index across repeated queries', async () => {
    const { search } = createSearch();

    await search.searchCollectionWithOptions('alpha', {});
    await search.searchCollectionWithOptions('alpha', {});

    expect(buildSpy).toHaveBeenCalledTimes(1);
  });
});
