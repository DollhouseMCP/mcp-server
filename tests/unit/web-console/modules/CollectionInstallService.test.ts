import { describe, expect, it, jest } from '@jest/globals';

import {
  CollectionInstallService,
  type CollectionInstallPort,
  type CollectionValidatedElement,
  InMemoryPortfolioElementStore,
  PortfolioElementAlreadyExistsError,
  type ConsoleHandlerResult,
  type ConsoleRequest,
  type IPortfolioElementStore,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const NOW = new Date('2026-07-03T12:00:00.000Z');
const CODE_REVIEW_NAME = 'Code Review';

function consoleRequest(body: unknown): ConsoleRequest {
  return {
    params: {},
    query: {},
    body,
    headers: {},
    consoleAuthentication: {
      sessionIdHash: Buffer.alloc(32, 7),
      userId: USER_ID,
      authSub: 'github_user-7',
      authzVersion: 1,
      grantedCapabilities: ['console:self'],
      elevation: null,
    },
  } as unknown as ConsoleRequest;
}

function validatedSkill(overrides: Partial<CollectionValidatedElement> = {}): CollectionValidatedElement {
  return {
    elementType: 'skills',
    name: CODE_REVIEW_NAME,
    metadata: { name: CODE_REVIEW_NAME, description: 'Reviews PRs', tags: ['review'] },
    content: '# Code Review\nBody.',
    ...overrides,
  };
}

function installerReturning(element: CollectionValidatedElement): CollectionInstallPort {
  return { fetchAndValidate: jest.fn<CollectionInstallPort['fetchAndValidate']>().mockResolvedValue(element) };
}

function installerThrowing(error: unknown): CollectionInstallPort {
  return { fetchAndValidate: jest.fn<CollectionInstallPort['fetchAndValidate']>().mockRejectedValue(error) };
}

function serviceWith(installer: CollectionInstallPort, store: IPortfolioElementStore = new InMemoryPortfolioElementStore()): CollectionInstallService {
  return new CollectionInstallService({ installer, portfolioStore: store, now: () => NOW });
}

async function run(service: CollectionInstallService, body: unknown): Promise<ConsoleHandlerResult> {
  return await service.install(consoleRequest(body));
}

describe('CollectionInstallService', () => {
  it('installs a validated element into the portfolio and returns 201', async () => {
    const store = new InMemoryPortfolioElementStore();
    const service = serviceWith(installerReturning(validatedSkill()), store);
    const result = await run(service, { path: 'library/skills/code-review.md' });

    expect(result.status).toBe(201);
    expect(result.headers?.ETag).toBeDefined();
    // The element is now in the user's portfolio (end-to-end through the store).
    const listed = await store.listByUser(USER_ID, { type: 'skills' });
    expect(listed).toHaveLength(1);
  });

  it('passes the validated element straight to the store create input', async () => {
    const store = { create: jest.fn<IPortfolioElementStore['create']>().mockResolvedValue({
      userId: USER_ID, type: 'skills', name: CODE_REVIEW_NAME, canonicalName: 'code-review',
      displayName: CODE_REVIEW_NAME, version: 1, updatedAt: NOW, validationStatus: 'valid',
      tags: ['review'], metadata: {}, content: 'x',
    }) } as unknown as IPortfolioElementStore;
    const service = serviceWith(installerReturning(validatedSkill()), store);
    await run(service, { path: 'library/skills/code-review.md' });

    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      type: 'skills',
      name: CODE_REVIEW_NAME,
      content: '# Code Review\nBody.',
      tags: ['review'],
      now: NOW,
    }));
  });

  it('installs a memory element (type routed through, whole document as content)', async () => {
    const store = { create: jest.fn<IPortfolioElementStore['create']>().mockResolvedValue({
      userId: USER_ID, type: 'memories', name: 'Guide', canonicalName: 'guide',
      displayName: 'Guide', version: 1, updatedAt: NOW, validationStatus: 'valid',
      tags: [], metadata: {}, content: 'x',
    }) } as unknown as IPortfolioElementStore;
    const service = serviceWith(installerReturning(validatedSkill({
      elementType: 'memories', name: 'Guide', metadata: { name: 'Guide', description: 'd' },
      content: 'metadata:\n  name: Guide\nentries: []\n',
    })), store);
    const result = await run(service, { path: 'library/memories/guide.yaml' });

    expect(result.status).toBe(201);
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'memories' }));
  });

  it('rejects a missing/empty path with 400', async () => {
    const service = serviceWith(installerReturning(validatedSkill()));
    expect((await run(service, {})).status).toBe(400);
    expect((await run(service, { path: '' })).status).toBe(400);
    expect((await run(service, { path: 42 })).status).toBe(400);
    expect((await run(service, null)).status).toBe(400);
  });

  it('rejects a non-library path with 400 before fetching', async () => {
    const installer = installerReturning(validatedSkill());
    const service = serviceWith(installer);
    const result = await run(service, { path: 'showcase/skills/x.md' });
    expect(result.status).toBe(400);
    expect(installer.fetchAndValidate).not.toHaveBeenCalled();
  });

  it('maps a not-found fetch error to 404', async () => {
    const service = serviceWith(installerThrowing(new Error('File not found in collection. Try search.')));
    const result = await run(service, { path: 'library/skills/missing.md' });
    expect(result.status).toBe(404);
    expect((result.body as { code: string }).code).toBe('collection_element_not_found');
  });

  it('maps an invalid-path fetch error to 400', async () => {
    const service = serviceWith(installerThrowing(new Error('Unknown element type: gadgets.')));
    expect((await run(service, { path: 'library/gadgets/x.md' })).status).toBe(400);
  });

  it('maps a security/validation fetch error to 422', async () => {
    const service = serviceWith(installerThrowing(new Error('Security threat in content: bad')));
    const result = await run(service, { path: 'library/skills/evil.md' });
    expect(result.status).toBe(422);
    expect((result.body as { code: string }).code).toBe('collection_element_invalid');
  });

  it('maps an unexpected fetch error to 503', async () => {
    const service = serviceWith(installerThrowing(new Error('GitHub API error: 500')));
    const result = await run(service, { path: 'library/skills/x.md' });
    expect(result.status).toBe(503);
    expect((result.body as { code: string }).code).toBe('collection_unavailable');
  });

  it('rejects an element whose type is not a supported portfolio type with 422', async () => {
    const service = serviceWith(installerReturning(validatedSkill({ elementType: 'tools' })));
    const result = await run(service, { path: 'library/skills/x.md' });
    expect(result.status).toBe(422);
    expect((result.body as { code: string }).code).toBe('collection_element_unsupported');
  });

  it('maps a duplicate element to 409', async () => {
    const store = {
      create: jest.fn<IPortfolioElementStore['create']>().mockRejectedValue(new PortfolioElementAlreadyExistsError()),
    } as unknown as IPortfolioElementStore;
    const service = serviceWith(installerReturning(validatedSkill()), store);
    const result = await run(service, { path: 'library/skills/code-review.md' });
    expect(result.status).toBe(409);
    expect((result.body as { code: string }).code).toBe('portfolio_element_exists');
  });
});
