import { describe, expect, it } from '@jest/globals';

import { UserIdentityService } from '../../../src/services/UserIdentityService.js';

describe('UserIdentityService.resolveOrCreateUser', () => {
  // Refused before any connection is opened, so an unreachable address proves no query was made.
  const unreachable = 'postgres://nobody:nobody@127.0.0.1:1/none';
  const service = new UserIdentityService({
    db: undefined, appConnectionUrl: unreachable, adminConnectionUrl: unreachable, ssl: 'disable',
  } as unknown as ConstructorParameters<typeof UserIdentityService>[0]);

  it.each(['dollhousemcp-canary', 'dollhousemcp-system', ' DollhouseMCP-Canary '])(
    'refuses to adopt the server\'s own user %s as an identity',
    async username => {
      await expect(service.resolveOrCreateUser(username)).rejects.toThrow(
        'is reserved for the server\'s own use and cannot be used as an identity.',
      );
    },
  );
});
