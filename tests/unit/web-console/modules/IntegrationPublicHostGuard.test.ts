import { describe, expect, it } from '@jest/globals';

import {
  assertPublicResolvedHost,
  PublicHostGuardError,
  type DnsLookup,
  type DnsLookupAddress,
} from '../../../../src/web-console/modules/integrations/IntegrationPublicHostGuard.js';

const HOSTNAME = 'api.example.com';

function lookupReturning(addresses: readonly DnsLookupAddress[]): DnsLookup {
  return () => Promise.resolve(addresses);
}

async function expectGuardRejection(lookup: DnsLookup, reason: 'resolution_failed' | 'not_allowed'): Promise<void> {
  const outcome = assertPublicResolvedHost(HOSTNAME, lookup);
  await expect(outcome).rejects.toBeInstanceOf(PublicHostGuardError);
  await expect(outcome).rejects.toMatchObject({ reason });
}

describe('assertPublicResolvedHost', () => {
  it('returns the first vetted address when every address is public', async () => {
    const lookup = lookupReturning([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::6810:84e5', family: 6 },
    ]);
    await expect(assertPublicResolvedHost(HOSTNAME, lookup)).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('rejects when any resolved address is non-public', async () => {
    const lookup = lookupReturning([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expectGuardRejection(lookup, 'not_allowed');
  });

  it('rejects hex IPv4-mapped internal addresses', async () => {
    const lookup = lookupReturning([{ address: '::ffff:7f00:1', family: 6 }]);
    await expectGuardRejection(lookup, 'not_allowed');
  });

  it('rejects NAT64-wrapped metadata addresses', async () => {
    const lookup = lookupReturning([{ address: '64:ff9b::a9fe:a9fe', family: 6 }]);
    await expectGuardRejection(lookup, 'not_allowed');
  });

  it('rejects when resolution returns no addresses', async () => {
    await expectGuardRejection(lookupReturning([]), 'not_allowed');
  });

  it('maps lookup failure to resolution_failed', async () => {
    const lookup: DnsLookup = () => Promise.reject(new Error('ENOTFOUND'));
    await expectGuardRejection(lookup, 'resolution_failed');
  });
});
