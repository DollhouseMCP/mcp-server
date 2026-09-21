import { expect, it, jest } from '@jest/globals';
import type { DatabaseInstance } from '../../../../src/database/connection.js';
import { assertOnboardingSchemaReady } from '../../../../src/invitations/onboarding/OnboardingSchemaPreflight.js';

it.each(['relation missing', 'column missing', 'permission denied', 'connection failed'])('sanitizes %s without preserving SQL, parameters, or a cause', async reason => {
  const execute = jest.fn<DatabaseInstance['execute']>().mockRejectedValue(Object.assign(new Error(reason), {
    code: 'secret-code', query: 'secret-query', parameters: ['secret-parameter'], cause: new Error('secret-cause'),
  }));
  await expect(assertOnboardingSchemaReady({ execute })).rejects.toMatchObject({
    message: 'Private beta onboarding database schema is unavailable.',
  });
  const error = await assertOnboardingSchemaReady({ execute }).catch(value => value as Error);
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain('secret');
  expect(error.stack).not.toContain(reason);
});
