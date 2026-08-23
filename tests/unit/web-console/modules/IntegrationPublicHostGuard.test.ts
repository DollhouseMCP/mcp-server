import { describe, expect, it } from '@jest/globals';

import {
  assertPublicResolvedHost,
  PublicHostGuardError,
  type DnsLookup,
} from '../../../../src/web-console/modules/integrations/IntegrationPublicHostGuard.js';

const HOSTNAME = 'api.example.com';

async function expectRejection(lookup: DnsLookup, reason: 'resolution_failed' | 'not_allowed'): Promise<void> {
  await expect(assertPublicResolvedHost(HOSTNAME, lookup)).rejects.toMatchObject({
    name: PublicHostGuardError.name,
    reason,
  });
}

describe('assertPublicResolvedHost', () => {
  it('returns a vetted address only when every answer is public', async () => {
    const lookup: DnsLookup = () => Promise.resolve([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::6810:84e5', family: 6 },
    ]);
    await expect(assertPublicResolvedHost(HOSTNAME, lookup)).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('rejects a mixed public and private DNS answer set', async () => {
    await expectRejection(() => Promise.resolve([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]), 'not_allowed');
  });

  it.each(['10.0.0.5', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe'])(
    'rejects non-public or wrapped address %s',
    async address => {
      await expectRejection(() => Promise.resolve([{ address, family: address.includes(':') ? 6 : 4 }]), 'not_allowed');
    },
  );

  it('maps empty and failed resolution to fail-closed reasons', async () => {
    await expectRejection(() => Promise.resolve([]), 'not_allowed');
    await expectRejection(() => Promise.reject(new Error('ENOTFOUND')), 'resolution_failed');
  });

  it('rejects a DNS answer whose family does not match its address', async () => {
    await expectRejection(
      () => Promise.resolve([{ address: '93.184.216.34', family: 6 }]),
      'not_allowed',
    );
  });
});
