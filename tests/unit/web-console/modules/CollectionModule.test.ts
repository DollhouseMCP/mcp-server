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
  type IPortfolioElementStore,
} from '../../../../src/web-console/index.js';
import { collectionElementNameFromPath } from '../../../../src/web-console/modules/collection/CollectionDtos.js';
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

    it('omits the install route unless install options are provided', () => {
      const module = createCollectionModule(fakePorts());
      expect(module.routes.some(r => r.method === 'POST')).toBe(false);
    });

    it('adds a self-private install route under the portfolio path when install is enabled', () => {
      const module = createCollectionModule({
        ...fakePorts(),
        install: {
          installer: { fetchAndValidate: () => Promise.reject(new Error('unused')) },
          portfolioStore: {} as unknown as IPortfolioElementStore,
        },
      });
      const install = module.routes.find(r => r.method === 'POST');
      expect(install).toBeDefined();
      expect(install?.path).toBe('/api/v1/me/portfolio/from-collection');
      // Install writes per-user data: self_private, NOT the catalog class.
      expect(install?.privacyClass).toBe('self_private');
      expect(install?.idempotency).toBe('required');
      expect(install?.rateLimit).toBe('collection_fetch');
      expect(install?.ownership).toBe('authenticated_user');
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

    // The stem IS the element's install/detail name: only the final catalog
    // extension is stripped, inner dots survive (a `guide.yaml.md` file lists
    // as `guide.yaml` and round-trips through the detail route unchanged).
    it.each([
      ['library/personas/code-review.md', 'code-review'],
      ['library/memories/guide.yaml', 'guide'],
      ['library/memories/guide.yml', 'guide'],
      ['library/personas/guide.yaml.md', 'guide.yaml'],
      ['library/personas/no-extension', 'no-extension'],
    ])('derives the element name from catalog path %s as %s', (catalogPath, expected) => {
      expect(collectionElementNameFromPath(catalogPath, 'fallback')).toBe(expected);
    });

    it('strips the .yaml extension from memory element names', async () => {
      const definition = routeWith(LIST_PATH, fakePorts({
        index: {
          getIndex: () => Promise.resolve(collectionIndex({
            memories: [indexEntry({
              path: 'library/memories/welcome-to-dollhouse-guide.yaml',
              type: 'memories',
              name: 'Welcome Guide',
            })],
          })),
        },
      }));
      const body = (await invoke(definition, consoleRequest({ query: { type: 'memories' } } as Partial<ConsoleRequest>))).body as CollectionElementListDto;
      expect(body.elements[0].name).toBe('welcome-to-dollhouse-guide');
      expect(body.elements[0].path).toBe('library/memories/welcome-to-dollhouse-guide.yaml');
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

    it('advertises install_enabled=false on a browse-only module and true when install is wired', async () => {
      const browseOnly = (await invoke(route(LIST_PATH), consoleRequest())).body as CollectionElementListDto;
      expect(browseOnly.install_enabled).toBe(false);

      const listRoute = routeWith(LIST_PATH, {
        ...fakePorts(),
        install: {
          installer: { fetchAndValidate: () => Promise.reject(new Error('unused')) },
          portfolioStore: {} as unknown as IPortfolioElementStore,
        },
      });
      const body = (await invoke(listRoute, consoleRequest())).body as CollectionElementListDto;
      expect(body.install_enabled).toBe(true);
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

    it('derives has_more from the engine, not the (unfiltered) total', async () => {
      // Engine reports a large total but says this is the last page. Non-console
      // hits get filtered out; has_more must follow the engine's hasMore=false,
      // not page*page_size<total (which would wrongly advertise another page).
      const definition = routeWith(LIST_PATH, fakePorts({
        search: {
          searchCollectionWithOptions: (query, options) => Promise.resolve({
            items: [
              indexEntry(),
              indexEntry({ path: 'library/tools/foo.md', type: 'tools', name: 'Foo' }),
            ],
            total: 100,
            page: options.page ?? 1,
            pageSize: options.pageSize ?? 50,
            hasMore: false,
            query,
            searchTime: 1,
          } satisfies SearchResults),
        },
      }));
      const body = (await invoke(definition, consoleRequest({ query: { q: 'review' } } as Partial<ConsoleRequest>))).body as CollectionElementListDto;
      expect(body.elements).toHaveLength(1); // non-console 'tools' hit filtered out
      expect(body.has_more).toBe(false);
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

    it('fetches memories with a .yaml extension, not .md', async () => {
      // Memories are stored as YAML in the collection; a hardcoded .md would
      // 404 every memory detail. The path must carry the per-type extension.
      const paths: string[] = [];
      const definition = routeWith(DETAIL_PATH, fakePorts({
        details: {
          getCollectionContent: path => {
            paths.push(path);
            return Promise.resolve({ metadata: { name: 'Guide' }, content: 'body' });
          },
        },
      }));
      const result = await invoke(definition, consoleRequest({
        params: { type: 'memories', name: 'welcome-to-dollhouse-guide' },
      } as Partial<ConsoleRequest>));
      expect(paths).toEqual(['library/memories/welcome-to-dollhouse-guide.yaml']);
      expect(result.status).toBe(200);
    });

    it('preserves an indexed .yml memory path for detail fetching', async () => {
      const paths: string[] = [];
      const definition = routeWith(DETAIL_PATH, fakePorts({
        index: {
          getIndex: () => Promise.resolve(collectionIndex({
            memories: [indexEntry({
              path: 'library/memories/legacy-guide.yml',
              type: 'memories',
              name: 'Legacy Guide',
            })],
          })),
        },
        details: {
          getCollectionContent: path => {
            paths.push(path);
            return Promise.resolve({ metadata: { name: 'Legacy Guide' }, content: 'entries: []' });
          },
        },
      }));

      const result = await invoke(definition, consoleRequest({
        params: { type: 'memories', name: 'legacy-guide' },
      } as Partial<ConsoleRequest>));
      expect(result.status).toBe(200);
      expect(paths).toEqual(['library/memories/legacy-guide.yml']);
      expect((result.body as CollectionElementDetailDto).path).toBe('library/memories/legacy-guide.yml');
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
