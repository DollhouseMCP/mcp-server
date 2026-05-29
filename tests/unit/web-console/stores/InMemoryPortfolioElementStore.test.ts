import { describe, expect, it } from '@jest/globals';

import {
  ConsoleStoreValidationError,
  InMemoryPortfolioElementStore,
  validatePortfolioElementSummaryRecord,
  type ConsolePortfolioElementDetailRecord,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const OTHER_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const NOW = new Date('2026-05-29T12:00:00.000Z');
const REVIEW_HELPER_NAME = 'review-helper';

function portfolioElement(
  overrides: Partial<ConsolePortfolioElementDetailRecord> = {},
): ConsolePortfolioElementDetailRecord {
  return {
    userId: USER_ID,
    type: 'skills',
    name: REVIEW_HELPER_NAME,
    canonicalName: REVIEW_HELPER_NAME,
    displayName: 'Review Helper',
    version: 1,
    updatedAt: NOW,
    validationStatus: 'valid',
    tags: ['review'],
    metadata: { description: 'Review helper' },
    content: '# Review Helper',
    ...overrides,
  };
}

describe('InMemoryPortfolioElementStore', () => {
  it('lists and summarizes only elements owned by the requested user', async () => {
    const store = new InMemoryPortfolioElementStore([
      portfolioElement(),
      portfolioElement({
        type: 'personas',
        name: 'architect',
        canonicalName: 'architect',
        tags: ['planning'],
      }),
      portfolioElement({
        userId: OTHER_USER_ID,
        name: 'other-skill',
        canonicalName: 'other-skill',
      }),
    ]);

    await expect(store.summarizeByUser(USER_ID)).resolves.toHaveLength(2);
    await expect(store.listByUser(USER_ID, { type: 'skills', tag: 'review' })).resolves.toMatchObject([
      {
        userId: USER_ID,
        type: 'skills',
        name: REVIEW_HELPER_NAME,
      },
    ]);
  });

  it('finds by canonical name and clones private content fields', async () => {
    const record = portfolioElement({
      metadata: { nested: { value: 'original' } },
    });
    const store = new InMemoryPortfolioElementStore([record]);

    const found = await store.findByName(USER_ID, 'skills', REVIEW_HELPER_NAME);
    if (!found) throw new Error('expected portfolio element fixture');
    (found.metadata as { nested: { value: string } }).nested.value = 'mutated';

    await expect(store.findByName(USER_ID, 'skills', REVIEW_HELPER_NAME)).resolves.toMatchObject({
      metadata: { nested: { value: 'original' } },
      content: '# Review Helper',
    });
  });

  it('canonicalizes inserted element names', async () => {
    const store = new InMemoryPortfolioElementStore([
      portfolioElement({
        name: 'Review-Helper.md',
        canonicalName: 'will-be-normalized',
      }),
    ]);

    await expect(store.findByName(USER_ID, 'skills', REVIEW_HELPER_NAME)).resolves.toMatchObject({
      name: 'Review-Helper.md',
      canonicalName: REVIEW_HELPER_NAME,
    });
  });

  it('validates element records before storing them', () => {
    expect(() => new InMemoryPortfolioElementStore([
      portfolioElement({ type: 'unknown' as 'skills' }),
    ])).toThrow(ConsoleStoreValidationError);
    expect(() => new InMemoryPortfolioElementStore([
      portfolioElement({ version: 0 }),
    ])).toThrow(ConsoleStoreValidationError);
    expect(() => new InMemoryPortfolioElementStore([
      portfolioElement({ validationStatus: 'pending' as 'valid' }),
    ])).toThrow(ConsoleStoreValidationError);
  });

  it('validates canonical name consistency for store adapters that do not normalize first', () => {
    expect(() => validatePortfolioElementSummaryRecord(portfolioElement({
      canonicalName: 'different-name',
    }))).toThrow('canonicalName must match canonicalized name');
  });
});
