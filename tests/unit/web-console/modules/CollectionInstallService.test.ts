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
import {
  CollectionContentInvalidError,
  CollectionElementNotFoundError,
  CollectionPathInvalidError,
} from '../../../../src/collection/CollectionErrors.js';
import { ApplicationError, ErrorCategory } from '../../../../src/utils/ErrorHandler.js';
import { ValidationErrorCodes } from '../../../../src/utils/errorCodes.js';

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

  // Exhaustive fetch-error classification: typed errors from the installer /
  // GitHub client, ApplicationErrors from the shared input validators, and the
  // message-based fallbacks for errors that crossed a wrapping boundary.
  it.each([
    ['typed not-found', new CollectionElementNotFoundError('File not found in collection. Try search.'), 404, 'collection_element_not_found'],
    ['typed not-a-file', new CollectionElementNotFoundError('Path does not point to a file'), 404, 'collection_element_not_found'],
    ['typed invalid path', new CollectionPathInvalidError('Unknown element type: gadgets. Valid types: personas'), 400, 'invalid_request'],
    ['typed wrong extension', new CollectionPathInvalidError('Invalid file type for memories. Expected .yaml/.yml.'), 400, 'invalid_request'],
    ['typed invalid content', new CollectionContentInvalidError('Security threat in content: bad'), 422, 'collection_element_invalid'],
    ['typed missing fields', new CollectionContentInvalidError('Invalid content: missing required name or description'), 422, 'collection_element_invalid'],
    ['typed oversized file', new CollectionContentInvalidError('File too large (3000000 bytes, max 2097152 bytes)'), 422, 'collection_element_invalid'],
    ['validator path too deep', new ApplicationError('Path too deep (max 10 levels)', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_PATH), 400, 'invalid_request'],
    ['validator traversal', new ApplicationError('Path traversal attempt detected', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_PATH), 400, 'invalid_request'],
    ['validator missing inline content', new ApplicationError('Content must be a non-empty string', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.REQUIRED_FIELD), 422, 'collection_element_invalid'],
    // The GitHub client wraps everything in an McpError whose message may be
    // redacted — the typed original survives as `cause` and must classify even
    // when the wrapper message matches no fallback string.
    ['wrapped typed not-found via cause chain', (() => {
      const wrapper = new Error('Failed to fetch from GitHub: [REDACTED]');
      wrapper.cause = new CollectionElementNotFoundError('File not found in collection.');
      return wrapper;
    })(), 404, 'collection_element_not_found'],
    ['fallback not-found message', new Error('File not found in collection. Try search.'), 404, 'collection_element_not_found'],
    ['fallback invalid-path message', new Error('Unknown element type: gadgets.'), 400, 'invalid_request'],
    ['fallback path-too-deep message', new Error('Path too deep (max 10 levels)'), 400, 'invalid_request'],
    ['fallback security message', new Error('Security threat in content: bad'), 422, 'collection_element_invalid'],
    ['fallback missing-content message', new Error('Content must be a non-empty string'), 422, 'collection_element_invalid'],
    ['unclassified upstream failure', new Error('GitHub API error: 500'), 503, 'collection_unavailable'],
  ])('maps %s to the right status', async (_case, error, status, code) => {
    const service = serviceWith(installerThrowing(error));
    const result = await run(service, { path: 'library/skills/x.md' });
    expect(result.status).toBe(status);
    expect((result.body as { code: string }).code).toBe(code);
  });

  it('rejects an element whose type is not a supported portfolio type with 422', async () => {
    const service = serviceWith(installerReturning(validatedSkill({ elementType: 'tools' })));
    const result = await run(service, { path: 'library/skills/x.md' });
    expect(result.status).toBe(422);
    expect((result.body as { code: string }).code).toBe('collection_element_unsupported');
  });

  it('rejects an element violating the portfolio record contract with 422 before any store write', async () => {
    const store = { create: jest.fn<IPortfolioElementStore['create']>() } as unknown as IPortfolioElementStore;
    const tooManyTags = Array.from({ length: 51 }, (_, i) => `tag-${i}`);
    const service = serviceWith(installerReturning(validatedSkill({
      metadata: { name: CODE_REVIEW_NAME, description: 'Reviews PRs', tags: tooManyTags },
    })), store);
    const result = await run(service, { path: 'library/skills/code-review.md' });

    expect(result.status).toBe(422);
    expect((result.body as { code: string }).code).toBe('collection_element_invalid');
    expect((result.body as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('rejects an over-long element name with 422 before any store write', async () => {
    const store = { create: jest.fn<IPortfolioElementStore['create']>() } as unknown as IPortfolioElementStore;
    const longName = 'n'.repeat(201);
    const service = serviceWith(installerReturning(validatedSkill({
      name: longName,
      metadata: { name: longName, description: 'd' },
    })), store);
    const result = await run(service, { path: 'library/skills/long.md' });

    expect(result.status).toBe(422);
    expect(store.create).not.toHaveBeenCalled();
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
