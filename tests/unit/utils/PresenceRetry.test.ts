import { expect, it } from '@jest/globals';
import { presenceRetryDelay } from '../../../src/utils/PresenceRetry.js';

  it('jitters retry delays across a bounded ±50% range', () => {
    expect(presenceRetryDelay(1, 1000, () => 0)).toBe(50);
    expect(presenceRetryDelay(1, 1000, () => 1)).toBe(150);
    expect(presenceRetryDelay(20, 1000, () => 0.5)).toBe(1000);
  });
