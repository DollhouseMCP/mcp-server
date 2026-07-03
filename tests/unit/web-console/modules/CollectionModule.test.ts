import { describe, expect, it } from '@jest/globals';

import {
  createCollectionModule,
  type CollectionDetailPort,
  type CollectionElementDetailDto,
  type CollectionElementListDto,
  type CollectionIndexPort,
  type CollectionModuleOptions,
  type CollectionSearchPort,
  type ConsoleHandlerResult,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
} from '../../../../src/web-console/index.js';
import type { CollectionIndexManager } from '../../../../src/collection/CollectionIndexManager.js';
import type { CollectionSearch } from '../../../../src/collection/CollectionSearch.js';
import type { PersonaDetails } from '../../../../src/collection/PersonaDetails.js';
import type { CollectionIndex, IndexEntry, SearchResults } from '../../../../src/types/collection.js';

// Compile-time proof that the real collection engine classes satisfy the
// module's structural ports (the registrar resolves them via untyped DI).
const _indexPortCheck: CollectionIndexPort = {} as CollectionIndexManager;
const _searchPortCheck: CollectionSearchPort = {} as CollectionSearch;
const _detailPortCheck: CollectionDetailPort = {} as PersonaDetails;
void _indexPortCheck;
void _searchPortCheck;
void _detailPortCheck;

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SELF_CAPABILITY = 'console:self';
const LIST_PATH = '/api/v1/collection/elements';
const DETAIL_PATH = '/api/v1/collection/elements/:type/:name';
const CODE_REVIEW_NAME = 'code-review';

function indexEntry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path: 'library/personas/code-review.md',
    type: 'personas',
    name: 'Code Review',
    description: 'Reviews pull requests',
    version: '1.2.0',
    author: 'dollhousemcp',
    tags: ['review', 'code'],
    sha: 'abc123',
    created: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function collectionIndex(entries: Readonly<Record<string, IndexEntry[]>>): CollectionIndex {
  return {
    version: '2.0.0',
    generated: '2026-07-01T00:00:00.000Z',
    total_elements: Object.values(entries).reduce((sum, list) => sum + list.length, 0),
    index: { ...entries },
    metadata: { build_time_ms: 10, file_count: 3, skipped_files: 0 },
  } as CollectionIndex;
}

function fakePorts(overrides: Partial<CollectionModuleOptions> = {}): CollectionModuleOptions {
  return {
    index: {
      getIndex: () => Promise.resolve(collectionIndex({
        personas: [indexEntry()],
        skills: [indexEntry({
          path: 'library/skills/linter.md',
          type: 'skills',
          name: 'Linter',
          description: 'Lints code',
        })],
      })),
    },
    search: {
      searchCollectionWithOptions: (query, options) => Promise.resolve({
        items: [indexEntry()],
        total: 1,
        page: options.page ?? 1,
        pageSize: options.pageSize ?? 50,
        hasMore: false,
        query,
        searchTime: 1,
      } satisfies SearchResults),
    },
    details: {
      getCollectionContent: () => Promise.resolve({
        metadata: {
          name: 'Code Review',
          description: 'Reviews pull requests',
          version: '1.2.0',
          author: 'dollhousemcp',
          tags: ['review'],
        },
        content: '# Code Review\nInstructions.',
      }),
    },
    ...overrides,
  };
}

function consoleRequest(overrides: Partial<ConsoleRequest> = {}): ConsoleRequest {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    consoleAuthentication: {
      sessionIdHash: Buffer.alloc(32, 7),
      userId: USER_ID,
      authSub: 'github_user-7',
      authzVersion: 3,
      grantedCapabilities: [SELF_CAPABILITY],
      elevation: null,
    },
    ...overrides,
  } as ConsoleRequest;
}

function route(path: string): ConsoleRouteDefinition {
  const module = createCollectionModule(fakePorts());
  const match = module.routes.find(candidate => candidate.path === path);
  if (!match) throw new Error(`route ${path} not found`);
  return match;
}

function routeWith(path: string, options: CollectionModuleOptions): ConsoleRouteDefinition {
  const module = createCollectionModule(options);
  const match = module.routes.find(candidate => candidate.path === path);
  if (!match) throw new Error(`route ${path} not found`);
  return match;
}

async function invoke(definition: ConsoleRouteDefinition, req: ConsoleRequest): Promise<ConsoleHandlerResult> {
  return await definition.handler(req);
}

describe('CollectionModule', () => {
  describe('route surface', () => {
    it('declares exactly the two session-gated, rate-limited catalog routes', () => {
      const module = createCollectionModule(fakePorts());
      expect(module.id).toBe('collection');
      expect(module.routes.map(definition => `${definition.method} ${definition.path}`)).toEqual([
        `GET ${LIST_PATH}`,
        `GET ${DETAIL_PATH}`,
      ]);
      for (const definition of module.routes) {
        expect(definition.audience).toBe('self');
        expect(definition.requiredCapability).toBe(SELF_CAPABILITY);
        expect(definition.privacyClass).toBe('public_catalog');
        expect(definition.rateLimit).toBe('collection_fetch');
        expect(definition.elevation).toBe('none');
        expect(definition.privacyProjector).toBeDefined();
      }
    });
  });

  describe('list', () => {
    it('lists all catalog elements across types', async () => {
      const result = await invoke(route(LIST_PATH), consoleRequest());
      expect(result.status).toBe(200);
      const body = result.body as CollectionElementListDto;
      expect(body.total).toBe(2);
      expect(body.source_status).toBe('ok');
      expect(body.elements.map(element => element.name)).toEqual([CODE_REVIEW_NAME, 'linter']);
      expect(body.elements[0]).toMatchObject({
        type: 'personas',
        name: CODE_REVIEW_NAME,
        display_name: 'Code Review',
        description: 'Reviews pull requests',
        path: 'library/personas/code-review.md',
        source: 'collection',
      });
    });

    it('filters by type', async () => {
      const result = await invoke(route(LIST_PATH), consoleRequest({ query: { type: 'skills' } } as Partial<ConsoleRequest>));
      const body = result.body as CollectionElementListDto;
      expect(body.total).toBe(1);
      expect(body.elements[0].type).toBe('skills');
    });

    it('rejects an unsupported type with a clean 400', async () => {
      const result = await invoke(route(LIST_PATH), consoleRequest({ query: { type: '../../../orgs/x' } } as Partial<ConsoleRequest>));
      expect(result.status).toBe(400);
      expect((result.body as { code: string }).code).toBe('invalid_request');
    });

    it('rejects invalid pagination parameters', async () => {
      const badPage = await invoke(route(LIST_PATH), consoleRequest({ query: { page: '0' } } as Partial<ConsoleRequest>));
      expect(badPage.status).toBe(400);
      const badSize = await invoke(route(LIST_PATH), consoleRequest({ query: { page_size: '101' } } as Partial<ConsoleRequest>));
      expect(badSize.status).toBe(400);
    });

    it('paginates browse results', async () => {
      const result = await invoke(route(LIST_PATH), consoleRequest({ query: { page: '2', page_size: '1' } } as Partial<ConsoleRequest>));
      const body = result.body as CollectionElementListDto;
      expect(body.total).toBe(2);
      expect(body.page).toBe(2);
      expect(body.elements).toHaveLength(1);
      expect(body.has_more).toBe(false);
    });

    it('returns the degraded state when the index is unavailable', async () => {
      const errors: unknown[] = [];
      const definition = routeWith(LIST_PATH, fakePorts({
        index: { getIndex: () => Promise.reject(new Error('index fetch failed')) },
        reportSourceError: error => { errors.push(error); },
      }));
      const result = await invoke(definition, consoleRequest());
      expect(result.status).toBe(200);
      const body = result.body as CollectionElementListDto;
      expect(body.source_status).toBe('degraded');
      expect(body.source_detail).toContain('unavailable');
      expect(body.elements).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });
  });

  describe('search', () => {
    it('routes q queries through the search engine', async () => {
      const result = await invoke(route(LIST_PATH), consoleRequest({ query: { q: 'review' } } as Partial<ConsoleRequest>));
      const body = result.body as CollectionElementListDto;
      expect(body.total).toBe(1);
      expect(body.elements[0].name).toBe(CODE_REVIEW_NAME);
    });

    it('rejects an oversized query', async () => {
      const result = await invoke(route(LIST_PATH), consoleRequest({ query: { q: 'a'.repeat(201) } } as Partial<ConsoleRequest>));
      expect(result.status).toBe(400);
    });

    it('degrades cleanly when search fails', async () => {
      const definition = routeWith(LIST_PATH, fakePorts({
        search: { searchCollectionWithOptions: () => Promise.reject(new Error('search backend down')) },
      }));
      const result = await invoke(definition, consoleRequest({ query: { q: 'review' } } as Partial<ConsoleRequest>));
      expect(result.status).toBe(200);
      expect((result.body as CollectionElementListDto).source_status).toBe('degraded');
    });
  });

  describe('detail', () => {
    it('returns metadata and content for a catalog element', async () => {
      const result = await invoke(route(DETAIL_PATH), consoleRequest({
        params: { type: 'personas', name: CODE_REVIEW_NAME },
      } as Partial<ConsoleRequest>));
      expect(result.status).toBe(200);
      const body = result.body as CollectionElementDetailDto;
      expect(body).toMatchObject({
        type: 'personas',
        name: CODE_REVIEW_NAME,
        display_name: 'Code Review',
        path: 'library/personas/code-review.md',
        content: '# Code Review\nInstructions.',
      });
      expect(body.metadata.description).toBe('Reviews pull requests');
    });

    it('constructs the fetch path only from validated components', async () => {
      const paths: string[] = [];
      const definition = routeWith(DETAIL_PATH, fakePorts({
        details: {
          getCollectionContent: path => {
            paths.push(path);
            return Promise.resolve({ metadata: {}, content: '' });
          },
        },
      }));
      await invoke(definition, consoleRequest({
        params: { type: 'skills', name: 'my-skill_v2.1' },
      } as Partial<ConsoleRequest>));
      expect(paths).toEqual(['library/skills/my-skill_v2.1.md']);
    });

    it('rejects traversal-shaped names without fetching', async () => {
      const paths: string[] = [];
      const definition = routeWith(DETAIL_PATH, fakePorts({
        details: {
          getCollectionContent: path => {
            paths.push(path);
            return Promise.resolve({ metadata: {}, content: '' });
          },
        },
      }));
      for (const name of ['../secrets', 'a/b', '.hidden', '']) {
        const result = await invoke(definition, consoleRequest({
          params: { type: 'personas', name },
        } as Partial<ConsoleRequest>));
        expect(result.status).toBe(400);
      }
      expect(paths).toHaveLength(0);
    });

    it('maps a missing catalog file to 404', async () => {
      const definition = routeWith(DETAIL_PATH, fakePorts({
        details: {
          getCollectionContent: () => Promise.reject(
            new Error('File not found in collection. Try using search to get the correct path: search_collection_enhanced "your-search-term"'),
          ),
        },
      }));
      const result = await invoke(definition, consoleRequest({
        params: { type: 'personas', name: 'missing' },
      } as Partial<ConsoleRequest>));
      expect(result.status).toBe(404);
      expect((result.body as { code: string }).code).toBe('collection_element_not_found');
    });

    it('maps other fetch failures to 503 collection_unavailable', async () => {
      const definition = routeWith(DETAIL_PATH, fakePorts({
        details: { getCollectionContent: () => Promise.reject(new Error('GitHub API error: 500')) },
      }));
      const result = await invoke(definition, consoleRequest({
        params: { type: 'personas', name: CODE_REVIEW_NAME },
      } as Partial<ConsoleRequest>));
      expect(result.status).toBe(503);
      expect((result.body as { code: string }).code).toBe('collection_unavailable');
    });
  });
});
