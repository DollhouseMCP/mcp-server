import { describe, expect, it } from '@jest/globals';

import {
  createPortfolioModule,
  InMemoryPortfolioElementStore,
  type ConsolePortfolioElementDetailRecord,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const OTHER_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const PRIMARY_SUB = 'github_user-7';
const SELF_CAPABILITY = 'console:self';
const NOW = new Date('2026-05-29T12:00:00.000Z');
const PORTFOLIO_PATH = '/api/v1/me/portfolio';
const ELEMENTS_PATH = '/api/v1/me/portfolio/elements';
const ELEMENT_DETAIL_PATH = '/api/v1/me/portfolio/elements/:type/:name';
const REVIEW_HELPER_NAME = 'review-helper';

function authenticatedContext(userId = USER_ID): NonNullable<ConsoleRequest['consoleAuthentication']> {
  return {
    sessionIdHash: Buffer.alloc(32, 7),
    userId,
    authSub: PRIMARY_SUB,
    authzVersion: 3,
    grantedCapabilities: [SELF_CAPABILITY],
    elevation: null,
  };
}

function consoleRequest(overrides: Partial<ConsoleRequest> = {}): ConsoleRequest {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    consoleAuthentication: authenticatedContext(),
    ...overrides,
  } as ConsoleRequest;
}

function portfolioElement(
  overrides: Partial<ConsolePortfolioElementDetailRecord> = {},
): ConsolePortfolioElementDetailRecord {
  return {
    userId: USER_ID,
    type: 'skills',
    name: REVIEW_HELPER_NAME,
    canonicalName: REVIEW_HELPER_NAME,
    displayName: 'Review Helper',
    version: 3,
    updatedAt: NOW,
    validationStatus: 'valid',
    tags: ['review', 'code'],
    metadata: {
      description: 'Review pull requests',
      private_note: 'owner-only',
    },
    content: '# Review Helper\nOwner private content.',
    ...overrides,
  };
}

function moduleFixture(records: readonly ConsolePortfolioElementDetailRecord[] = [portfolioElement()]) {
  const store = new InMemoryPortfolioElementStore(records);
  const module = createPortfolioModule({ portfolioStore: store });
  return { module, store };
}

function findRoute(
  routes: readonly ConsoleRouteDefinition[],
  path: string,
  method = 'GET',
): ConsoleRouteDefinition {
  const route = routes.find(candidate => candidate.path === path && candidate.method === method);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

describe('PortfolioModule', () => {
  it('registers self-private portfolio read descriptors', () => {
    const { module } = moduleFixture([]);

    expect(module).toMatchObject({
      id: 'portfolio',
      apiVersion: 'v1',
      capabilities: [SELF_CAPABILITY],
    });
    expect(module.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'GET',
        path: PORTFOLIO_PATH,
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        method: 'GET',
        path: ELEMENTS_PATH,
        ownership: 'authenticated_user',
        privacyClass: 'self_private',
      }),
      expect.objectContaining({
        method: 'GET',
        path: ELEMENT_DETAIL_PATH,
        ownership: 'authenticated_user',
        privacyClass: 'self_private',
      }),
    ]));
  });

  it('returns portfolio summary counts for the authenticated owner only', async () => {
    const { module } = moduleFixture([
      portfolioElement(),
      portfolioElement({
        type: 'personas',
        name: 'architect',
        canonicalName: 'architect',
        displayName: 'Architect',
      }),
      portfolioElement({
        userId: OTHER_USER_ID,
        name: 'other-user-skill',
        canonicalName: 'other-user-skill',
      }),
    ]);
    const summary = findRoute(module.routes, PORTFOLIO_PATH);

    await expect(summary.handler(consoleRequest())).resolves.toEqual({
      status: 200,
      body: {
        total_elements: 2,
        counts_by_type: {
          personas: 1,
          skills: 1,
          templates: 0,
          agents: 0,
          memories: 0,
          ensembles: 0,
        },
        updated_at: NOW.toISOString(),
      },
    });
  });

  it('returns an empty portfolio summary with null updated_at', async () => {
    const { module } = moduleFixture([]);
    const summary = findRoute(module.routes, PORTFOLIO_PATH);

    await expect(summary.handler(consoleRequest())).resolves.toEqual({
      status: 200,
      body: {
        total_elements: 0,
        counts_by_type: {
          personas: 0,
          skills: 0,
          templates: 0,
          agents: 0,
          memories: 0,
          ensembles: 0,
        },
        updated_at: null,
      },
    });
  });


  it('lists portfolio elements with type, tag, and fields filters', async () => {
    const { module } = moduleFixture([
      portfolioElement(),
      portfolioElement({
        type: 'templates',
        name: 'incident-report',
        canonicalName: 'incident-report',
        displayName: 'Incident Report',
        tags: ['ops'],
      }),
    ]);
    const list = findRoute(module.routes, ELEMENTS_PATH);

    await expect(list.handler(consoleRequest({
      query: {
        type: 'skills',
        tag: 'REVIEW',
        fields: 'type,name,tags',
      },
    }))).resolves.toEqual({
      status: 200,
      body: {
        elements: [{
          type: 'skills',
          name: REVIEW_HELPER_NAME,
          tags: ['review', 'code'],
        }],
      },
    });
  });

  it('returns detail with owner-private metadata and content for owned elements', async () => {
    const { module } = moduleFixture();
    const detail = findRoute(module.routes, ELEMENT_DETAIL_PATH);

    const result = await detail.handler(consoleRequest({
      params: {
        type: 'skills',
        name: 'review-helper.md',
      },
    }));

    expect(result).toEqual({
      status: 200,
      body: {
        type: 'skills',
        name: REVIEW_HELPER_NAME,
        display_name: 'Review Helper',
        version: 3,
        updated_at: NOW.toISOString(),
        validation_status: 'valid',
        tags: ['review', 'code'],
        metadata: {
          description: 'Review pull requests',
          private_note: 'owner-only',
        },
        content: '# Review Helper\nOwner private content.',
      },
    });
    expect(detail.privacyProjector?.({
      ...(result.body as Record<string, unknown>),
      owner_user_id: USER_ID,
      absolute_path: '/secret/path',
      token: 'leak',
    })).toEqual(result.body);
  });

  it('does not reveal non-owned elements through detail lookup', async () => {
    const { module } = moduleFixture([
      portfolioElement({
        userId: OTHER_USER_ID,
      }),
    ]);
    const detail = findRoute(module.routes, ELEMENT_DETAIL_PATH);

    await expect(detail.handler(consoleRequest({
      params: {
        type: 'skills',
        name: REVIEW_HELPER_NAME,
      },
    }))).resolves.toMatchObject({
      status: 404,
      body: {
        code: 'portfolio_element_not_found',
      },
    });
  });

  it('validates type and fields inputs', async () => {
    const { module } = moduleFixture();
    const list = findRoute(module.routes, ELEMENTS_PATH);
    const detail = findRoute(module.routes, ELEMENT_DETAIL_PATH);

    await expect(list.handler(consoleRequest({ query: { type: 'unknown' } }))).resolves
      .toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    await expect(list.handler(consoleRequest({ query: { fields: 'name,absolute_path' } }))).resolves
      .toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    await expect(detail.handler(consoleRequest({
      params: { type: 'unknown', name: REVIEW_HELPER_NAME },
    }))).resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } });
  });

  it('requires authentication and ignores caller-supplied owner parameters', async () => {
    const { module } = moduleFixture();
    const detail = findRoute(module.routes, ELEMENT_DETAIL_PATH);

    await expect(detail.handler(consoleRequest({
      consoleAuthentication: undefined,
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
    }))).rejects.toThrow('authentication middleware');
    await expect(detail.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME, user_id: OTHER_USER_ID },
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        name: REVIEW_HELPER_NAME,
      },
    });
  });
});
