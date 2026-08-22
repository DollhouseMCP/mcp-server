import { describe, expect, it } from '@jest/globals';

import { isUniqueViolation, PG_UNIQUE_VIOLATION } from '../../../src/database/db-utils.js';

describe('database error classification', () => {
  it('recognizes direct and Drizzle-wrapped unique violations', () => {
    const unique = { code: PG_UNIQUE_VIOLATION };

    expect(isUniqueViolation(unique)).toBe(true);
    expect(isUniqueViolation(new Error('query failed', { cause: unique }))).toBe(true);
  });

  it('rejects unrelated, cyclic, and excessively deep cause chains', () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    const tooDeep = new Error('one', {
      cause: new Error('two', {
        cause: new Error('three', {
          cause: new Error('four', {
            cause: new Error('five', { cause: { code: PG_UNIQUE_VIOLATION } }),
          }),
        }),
      }),
    });

    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(cyclic)).toBe(false);
    expect(isUniqueViolation(tooDeep)).toBe(false);
  });
});
