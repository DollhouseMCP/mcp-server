import { describe, expect, it } from '@jest/globals';

import {
  settleIntegrationCleanup,
} from '../../../../src/web-console/modules/integrations/IntegrationCleanup.js';

describe('settleIntegrationCleanup', () => {
  it('reports successful and rejected cleanup without throwing', async () => {
    await expect(settleIntegrationCleanup(() => Promise.resolve(), 50)).resolves.toBe('completed');
    await expect(settleIntegrationCleanup(() => Promise.reject(new Error('cleanup failed')), 50))
      .resolves.toBe('failed');
  });

  it('contains a synchronous cleanup failure', async () => {
    await expect(settleIntegrationCleanup(() => {
      throw new Error('cleanup failed synchronously');
    }, 50)).resolves.toBe('failed');
  });

  it('bounds cleanup that never settles', async () => {
    await expect(settleIntegrationCleanup(
      () => new Promise<void>(() => undefined),
      5,
    )).resolves.toBe('timed_out');
  });
});
