import { describe, expect, it } from '@jest/globals';

import {
  createPortfolioModule,
  InMemoryPortfolioElementStore,
  InMemoryPortfolioSyncJobStore,
  InMemoryUserIntegrationStore,
  PortfolioElementVersionConflictError,
  PORTFOLIO_ELEMENT_METADATA_MAX_BYTES,
  PORTFOLIO_ELEMENT_TAGS_MAX,
  type ConsolePortfolioElementDetailRecord,
  type ConsolePortfolioElementDeleteInput,
  type ConsolePortfolioElementUpdateInput,
  type ConsoleHandlerResult,
  type IPortfolioElementStore,
  type IPortfolioSyncJobStore,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
  type UserIntegrationRecord,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const OTHER_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const PRIMARY_SUB = 'github_user-7';
const SELF_CAPABILITY = 'console:self';
const NOW = new Date('2026-05-29T12:00:00.000Z');
const PORTFOLIO_PATH = '/api/v1/me/portfolio';
const ELEMENTS_PATH = '/api/v1/me/portfolio/elements';
const ELEMENT_DETAIL_PATH = '/api/v1/me/portfolio/elements/:type/:name';
const ELEMENT_VALIDATE_PATH = '/api/v1/me/portfolio/elements/:type/:name/validate';
const ELEMENT_RENDER_PATH = '/api/v1/me/portfolio/elements/:type/:name/render';
const SYNC_PATH = '/api/v1/me/portfolio/sync';
const SYNC_STATUS_PATH = '/api/v1/me/portfolio/sync/:job_id';
const REVIEW_HELPER_NAME = 'review-helper';
const REVIEW_HELPER_V3_ETAG = 'W/"portfolio:skills:review-helper:v3"';
const INTEGRATION_ID = '35e22a52-dc56-4cd0-9d13-b2802524fbd3';

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

function userIntegration(overrides: Partial<UserIntegrationRecord> = {}): UserIntegrationRecord {
  return {
    id: INTEGRATION_ID,
    userId: USER_ID,
    provider: 'github',
    externalAccountLabel: 'alice',
    externalInstallationId: 'installation-123',
    authorizedPermissions: {
      repository_selection: 'selected',
      permissions: { contents: 'read' },
    },
    accessTokenCiphertext: Buffer.from('encrypted-access-token'),
    refreshTokenCiphertext: null,
    credentialKeyVersion: null,
    status: 'connected',
    errorReason: null,
    connectedAt: NOW,
    lastSyncAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function moduleFixtureWithStore(
  store: IPortfolioElementStore,
  integrationStore = new InMemoryUserIntegrationStore([userIntegration()]),
  syncJobStore: IPortfolioSyncJobStore = new InMemoryPortfolioSyncJobStore(),
  enablePortfolioWriteRoutes = true,
) {
  const module = createPortfolioModule({
    portfolioStore: store,
    integrationStore,
    syncJobStore,
    enablePortfolioWriteRoutes,
    now: () => NOW,
  });
  return { module, store, integrationStore, syncJobStore };
}

function moduleFixture(records: readonly ConsolePortfolioElementDetailRecord[] = [portfolioElement()]) {
  return moduleFixtureWithStore(new InMemoryPortfolioElementStore(records));
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

function responseEtag(result: ConsoleHandlerResult): string {
  const value = result.headers?.ETag;
  if (typeof value !== 'string') throw new Error('expected ETag header');
  return value;
}

class ConflictOnWritePortfolioStore extends InMemoryPortfolioElementStore {
  override update(input: ConsolePortfolioElementUpdateInput): Promise<ConsolePortfolioElementDetailRecord | null> {
    void input;
    return Promise.reject(new PortfolioElementVersionConflictError());
  }

  override delete(input: ConsolePortfolioElementDeleteInput): Promise<ConsolePortfolioElementDetailRecord | null> {
    void input;
    return Promise.reject(new PortfolioElementVersionConflictError());
  }
}

describe('PortfolioModule', () => {
  it('keeps portfolio write and sync-start routes gated off by default', () => {
    const module = createPortfolioModule({
      portfolioStore: new InMemoryPortfolioElementStore(),
      integrationStore: new InMemoryUserIntegrationStore(),
      syncJobStore: new InMemoryPortfolioSyncJobStore(),
      now: () => NOW,
    });

    expect(module.routes.some(route => route.method !== 'GET')).toBe(false);
    expect(module.routes.map(route => route.path)).toEqual(expect.arrayContaining([
      PORTFOLIO_PATH,
      ELEMENTS_PATH,
      ELEMENT_DETAIL_PATH,
      SYNC_STATUS_PATH,
    ]));
  });

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
      expect.objectContaining({
        method: 'POST',
        path: '/api/v1/me/portfolio/elements/:type',
        ownership: 'authenticated_user',
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'PATCH',
        path: ELEMENT_DETAIL_PATH,
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'DELETE',
        path: ELEMENT_DETAIL_PATH,
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'POST',
        path: ELEMENT_VALIDATE_PATH,
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'POST',
        path: ELEMENT_RENDER_PATH,
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'POST',
        path: SYNC_PATH,
        ownership: 'authenticated_user',
        privacyClass: 'self_private',
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'GET',
        path: SYNC_STATUS_PATH,
        ownership: 'authenticated_user',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
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
      headers: { ETag: REVIEW_HELPER_V3_ETAG },
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

  it('creates portfolio elements with validation, ETag, and owner scoping', async () => {
    const { module, store } = moduleFixture([]);
    const create = findRoute(module.routes, '/api/v1/me/portfolio/elements/:type', 'POST');

    const result = await create.handler(consoleRequest({
      params: { type: 'skills' },
      body: {
        name: REVIEW_HELPER_NAME,
        display_name: 'Review Helper',
        metadata: { description: 'Review pull requests' },
        content: '# Review Helper',
        tags: ['review'],
      },
    }));

    expect(result).toMatchObject({
      status: 201,
      headers: { ETag: 'W/"portfolio:skills:review-helper:v1"' },
      body: {
        type: 'skills',
        name: REVIEW_HELPER_NAME,
        version: 1,
        metadata: { description: 'Review pull requests' },
        content: '# Review Helper',
      },
    });
    await expect(store.findByName(USER_ID, 'skills', REVIEW_HELPER_NAME)).resolves.toMatchObject({
      userId: USER_ID,
      name: REVIEW_HELPER_NAME,
    });
  });

  it('rejects duplicate creates and invalid mutation bodies', async () => {
    const { module } = moduleFixture();
    const create = findRoute(module.routes, '/api/v1/me/portfolio/elements/:type', 'POST');

    await expect(create.handler(consoleRequest({
      params: { type: 'skills' },
      body: {
        name: REVIEW_HELPER_NAME,
        metadata: {},
        content: '# Duplicate',
      },
    }))).resolves.toMatchObject({
      status: 409,
      body: { code: 'portfolio_element_exists' },
    });
    await expect(create.handler(consoleRequest({
      params: { type: 'skills' },
      body: {
        name: '',
        metadata: [],
      },
    }))).resolves.toMatchObject({
      status: 422,
      body: { code: 'validation_failed' },
    });
    await expect(create.handler(consoleRequest({
      params: { type: 'skills' },
      body: {
        name: 'huge-metadata',
        metadata: { value: 'x'.repeat(PORTFOLIO_ELEMENT_METADATA_MAX_BYTES) },
        content: '# Huge metadata',
      },
    }))).resolves.toMatchObject({
      status: 422,
      body: {
        code: 'validation_failed',
        issues: [expect.objectContaining({ path: 'metadata', code: 'too_large' })],
      },
    });
    await expect(create.handler(consoleRequest({
      params: { type: 'skills' },
      body: {
        name: 'too-many-tags',
        metadata: {},
        content: '# Too many tags',
        tags: Array.from({ length: PORTFOLIO_ELEMENT_TAGS_MAX + 1 }, (_, index) => `tag-${index}`),
      },
    }))).resolves.toMatchObject({
      status: 422,
      body: {
        code: 'validation_failed',
        issues: [expect.objectContaining({ path: 'tags', code: 'too_many' })],
      },
    });
  });

  it('updates portfolio elements only with the current element ETag', async () => {
    const { module } = moduleFixture();
    const update = findRoute(module.routes, ELEMENT_DETAIL_PATH, 'PATCH');
    const detail = findRoute(module.routes, ELEMENT_DETAIL_PATH);
    const current = await detail.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
    }));
    const etag = responseEtag(current);

    await expect(update.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      body: { content: '# Updated' },
    }))).resolves.toMatchObject({
      status: 428,
      body: { code: 'precondition_required' },
    });
    await expect(update.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      headers: { 'if-match': 'W/"portfolio:skills:review-helper:v2"' },
      body: { content: '# Updated' },
    }))).resolves.toMatchObject({
      status: 412,
      body: { code: 'precondition_failed' },
    });

    const result = await update.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      headers: { 'if-match': etag },
      body: {
        display_name: 'Updated Helper',
        content: '# Updated',
        tags: ['updated'],
      },
    }));

    expect(result).toMatchObject({
      status: 200,
      headers: { ETag: 'W/"portfolio:skills:review-helper:v4"' },
      body: {
        display_name: 'Updated Helper',
        version: 4,
        content: '# Updated',
        tags: ['updated'],
      },
    });
    await expect(detail.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
    }))).resolves.toMatchObject({
      body: {
        version: 4,
        content: '# Updated',
      },
    });
  });

  it('accepts a single array-valued If-Match header and rejects empty patches', async () => {
    const { module } = moduleFixture();
    const update = findRoute(module.routes, ELEMENT_DETAIL_PATH, 'PATCH');

    await expect(update.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      headers: { 'if-match': [REVIEW_HELPER_V3_ETAG] },
      body: { content: '# Array header' },
    }))).resolves.toMatchObject({
      status: 200,
      body: { content: '# Array header' },
    });

    const fresh = moduleFixture();
    const freshUpdate = findRoute(fresh.module.routes, ELEMENT_DETAIL_PATH, 'PATCH');
    await expect(freshUpdate.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      headers: { 'if-match': REVIEW_HELPER_V3_ETAG },
      body: {},
    }))).resolves.toMatchObject({
      status: 422,
      body: {
        code: 'validation_failed',
        issues: [expect.objectContaining({ code: 'empty_patch' })],
      },
    });
  });

  it('deletes portfolio elements with current ETag and removes them from active reads', async () => {
    const { module, store } = moduleFixture();
    const remove = findRoute(module.routes, ELEMENT_DETAIL_PATH, 'DELETE');
    const detail = findRoute(module.routes, ELEMENT_DETAIL_PATH);
    const current = await detail.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
    }));

    const result = await remove.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      headers: { 'if-match': responseEtag(current) },
    }));

    expect(result).toEqual({
      status: 200,
      body: {
        deleted: true,
        type: 'skills',
        name: REVIEW_HELPER_NAME,
        version: 4,
        deleted_at: NOW.toISOString(),
      },
    });
    await expect(store.findByName(USER_ID, 'skills', REVIEW_HELPER_NAME)).resolves.toBeNull();
  });

  it('enforces delete preconditions before deleting owned elements', async () => {
    const { module } = moduleFixture();
    const remove = findRoute(module.routes, ELEMENT_DETAIL_PATH, 'DELETE');

    await expect(remove.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
    }))).resolves.toMatchObject({
      status: 428,
      body: { code: 'precondition_required' },
    });
    await expect(remove.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      headers: { 'if-match': 'W/"portfolio:skills:review-helper:v2"' },
    }))).resolves.toMatchObject({
      status: 412,
      body: { code: 'precondition_failed' },
    });
    await expect(remove.handler(consoleRequest({
      params: { type: 'skills', name: 'missing-skill' },
      headers: { 'if-match': 'W/"portfolio:skills:missing-skill:v1"' },
    }))).resolves.toMatchObject({
      status: 404,
      body: { code: 'portfolio_element_not_found' },
    });

    const otherFixture = moduleFixture([portfolioElement({ userId: OTHER_USER_ID })]);
    const otherRemove = findRoute(otherFixture.module.routes, ELEMENT_DETAIL_PATH, 'DELETE');
    await expect(otherRemove.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      headers: { 'if-match': REVIEW_HELPER_V3_ETAG },
    }))).resolves.toMatchObject({
      status: 404,
      body: { code: 'portfolio_element_not_found' },
    });
  });

  it('maps raced store version conflicts to precondition failures', async () => {
    const { module } = moduleFixtureWithStore(new ConflictOnWritePortfolioStore([portfolioElement()]));
    const update = findRoute(module.routes, ELEMENT_DETAIL_PATH, 'PATCH');
    const remove = findRoute(module.routes, ELEMENT_DETAIL_PATH, 'DELETE');

    await expect(update.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      headers: { 'if-match': REVIEW_HELPER_V3_ETAG },
      body: { content: '# Raced update' },
    }))).resolves.toMatchObject({
      status: 412,
      body: { code: 'precondition_failed' },
    });
    await expect(remove.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      headers: { 'if-match': REVIEW_HELPER_V3_ETAG },
    }))).resolves.toMatchObject({
      status: 412,
      body: { code: 'precondition_failed' },
    });
  });

  it('validates and renders previews without mutating portfolio state', async () => {
    const { module, store } = moduleFixture();
    const validate = findRoute(module.routes, ELEMENT_VALIDATE_PATH, 'POST');
    const render = findRoute(module.routes, ELEMENT_RENDER_PATH, 'POST');

    await expect(validate.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      body: { content: '' },
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        valid: false,
        issues: [expect.objectContaining({ path: 'content', code: 'required' })],
      },
    });
    await expect(validate.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      body: { content: '# Valid preview' },
    }))).resolves.toEqual({
      status: 200,
      body: {
        valid: true,
        issues: [],
      },
    });
    await expect(render.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      body: { content: '# Preview only' },
    }))).resolves.toEqual({
      status: 200,
      body: {
        type: 'skills',
        name: REVIEW_HELPER_NAME,
        preview: '# Preview only',
      },
    });
    await expect(render.handler(consoleRequest({
      params: { type: 'skills', name: 'missing-skill' },
      body: { content: '# Missing' },
    }))).resolves.toMatchObject({
      status: 404,
      body: { code: 'portfolio_element_not_found' },
    });
    await expect(render.handler(consoleRequest({
      params: { type: 'skills', name: REVIEW_HELPER_NAME },
      body: { content: '' },
    }))).resolves.toMatchObject({
      status: 422,
      body: {
        code: 'validation_failed',
        issues: [expect.objectContaining({ path: 'content', code: 'required' })],
      },
    });
    await expect(store.findByName(USER_ID, 'skills', REVIEW_HELPER_NAME)).resolves.toMatchObject({
      version: 3,
      content: '# Review Helper\nOwner private content.',
    });
  });

  it('starts portfolio sync jobs only for connected integrations with sufficient permissions', async () => {
    const { module, syncJobStore } = moduleFixture();
    const sync = findRoute(module.routes, SYNC_PATH, 'POST');

    const result = await sync.handler(consoleRequest({
      body: {
        provider: 'github',
        direction: 'pull',
      },
    }));

    expect(result).toMatchObject({
      status: 202,
      body: {
        status: 'queued',
        direction: 'pull',
        conflict_policy: 'fail',
        status_url: expect.stringMatching(/^\/api\/v1\/me\/portfolio\/sync\//u),
        result_summary: null,
        error_code: null,
      },
    });
    const jobId = (result.body as { job_id: string }).job_id;
    await expect(syncJobStore.findById(USER_ID, jobId)).resolves.toMatchObject({
      userId: USER_ID,
      integrationId: INTEGRATION_ID,
      direction: 'pull',
      status: 'queued',
    });
    await expect(sync.handler(consoleRequest({
      body: {
        provider: 'github',
        direction: 'pull',
      },
    }))).resolves.toMatchObject({
      status: 409,
      body: { code: 'sync_already_pending' },
    });
    expect(sync.privacyProjector?.({
      ...(result.body as Record<string, unknown>),
      integration_id: INTEGRATION_ID,
      access_token: 'leak',
      worker_id: 'replica-1',
    })).toEqual(result.body);
  });

  it('rejects portfolio sync requests without integration permission or valid input', async () => {
    const readOnly = moduleFixture();
    const sync = findRoute(readOnly.module.routes, SYNC_PATH, 'POST');

    await expect(sync.handler(consoleRequest({
      body: {
        provider: 'github',
        direction: 'push',
      },
    }))).resolves.toMatchObject({
      status: 409,
      body: { code: 'integration_permission_required' },
    });
    const noContents = moduleFixtureWithStore(
      new InMemoryPortfolioElementStore(),
      new InMemoryUserIntegrationStore([userIntegration({
        authorizedPermissions: {
          repository_selection: 'selected',
          permissions: { contents: 'none' },
        },
      })]),
    );
    await expect(findRoute(noContents.module.routes, SYNC_PATH, 'POST').handler(consoleRequest({
      body: {
        provider: 'github',
        direction: 'pull',
      },
    }))).resolves.toMatchObject({
      status: 409,
      body: { code: 'integration_permission_required' },
    });

    const disconnected = moduleFixtureWithStore(
      new InMemoryPortfolioElementStore(),
      new InMemoryUserIntegrationStore(),
    );
    const disconnectedSync = findRoute(disconnected.module.routes, SYNC_PATH, 'POST');
    await expect(disconnectedSync.handler(consoleRequest({
      body: {
        provider: 'github',
        direction: 'pull',
      },
    }))).resolves.toMatchObject({
      status: 409,
      body: { code: 'integration_required' },
    });
    await expect(sync.handler(consoleRequest({
      body: {
        provider: 'gitlab',
        direction: 'pull',
      },
    }))).resolves.toMatchObject({
      status: 422,
      body: {
        code: 'validation_failed',
        issues: [expect.objectContaining({ path: 'provider' })],
      },
    });
    await expect(sync.handler(consoleRequest({
      body: [],
    }))).resolves.toMatchObject({
      status: 400,
      body: { code: 'invalid_request' },
    });
    await expect(sync.handler(consoleRequest({
      body: {
        provider: 'github',
      },
    }))).resolves.toMatchObject({
      status: 422,
      body: {
        code: 'validation_failed',
        issues: [expect.objectContaining({ path: 'direction' })],
      },
    });
    await expect(sync.handler(consoleRequest({
      body: {
        provider: 'github',
        direction: 'pull',
        conflict_policy: 'prefer_newer',
      },
    }))).resolves.toMatchObject({
      status: 422,
      body: {
        code: 'validation_failed',
        issues: [expect.objectContaining({ path: 'conflict_policy' })],
      },
    });
  });

  it('allows write-granted integrations to start push sync and read owned job status only', async () => {
    const { module } = moduleFixtureWithStore(
      new InMemoryPortfolioElementStore(),
      new InMemoryUserIntegrationStore([userIntegration({
        authorizedPermissions: {
          repository_selection: 'selected',
          permissions: { contents: 'write' },
        },
      })]),
    );
    const sync = findRoute(module.routes, SYNC_PATH, 'POST');
    const status = findRoute(module.routes, SYNC_STATUS_PATH);

    const created = await sync.handler(consoleRequest({
      body: {
        provider: 'github',
        direction: 'bidirectional',
        conflict_policy: 'prefer_local',
      },
    }));
    expect(created).toMatchObject({
      status: 202,
      body: {
        direction: 'bidirectional',
        conflict_policy: 'prefer_local',
      },
    });
    const jobId = (created.body as { job_id: string }).job_id;

    await expect(status.handler(consoleRequest({
      params: { job_id: jobId },
    }))).resolves.toEqual({
      status: 200,
      body: created.body,
    });
    await expect(status.handler(consoleRequest({
      params: { job_id: jobId },
      consoleAuthentication: authenticatedContext(OTHER_USER_ID),
    }))).resolves.toMatchObject({
      status: 404,
      body: { code: 'portfolio_sync_job_not_found' },
    });
    await expect(status.handler(consoleRequest({
      params: { job_id: 'not-a-uuid' },
    }))).resolves.toMatchObject({
      status: 400,
      body: { code: 'invalid_request' },
    });
  });
});
