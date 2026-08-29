import { describe, expect, it } from '@jest/globals';

import {
  assertPublicResolvedHost,
  PublicHostGuardError,
  type DnsLookup,
  type DnsLookupAddress,
} from '../../../../src/web-console/modules/integrations/IntegrationPublicHostGuard.js';

const HOSTNAME = 'api.example.com';
const PUBLIC_IPV4 = '93.184.216.34';
const PUBLIC_IPV6 = '2606:4700::6810:84e5';

function lookupReturning(addresses: readonly DnsLookupAddress[]): DnsLookup {
  return () => Promise.resolve(addresses);
}

async function expectGuardRejection(lookup: DnsLookup, reason: 'resolution_failed' | 'not_allowed'): Promise<void> {
  await expect(assertPublicResolvedHost(HOSTNAME, lookup)).rejects.toMatchObject({
    name: PublicHostGuardError.name,
    reason,
  });
}

describe('assertPublicResolvedHost', () => {
  it('returns the first vetted address only when every answer is public', async () => {
    const lookup = lookupReturning([
      { address: PUBLIC_IPV4, family: 4 },
      { address: PUBLIC_IPV6, family: 6 },
    ]);
    await expect(assertPublicResolvedHost(HOSTNAME, lookup)).resolves.toEqual({
      address: PUBLIC_IPV4,
      family: 4,
    });
  });

  it('rejects a mixed public and private DNS answer set', async () => {
    await expectGuardRejection(lookupReturning([
      { address: PUBLIC_IPV4, family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]), 'not_allowed');
  });

  it.each([
    ['::ffff:7f00:1', 'mapped loopback'],
    ['::8.8.8.8', 'IPv4-compatible public address'],
    ['64:ff9b::a9fe:a9fe', 'well-known NAT64 metadata'],
    ['64:ff9b:1::808:808', 'local-use NAT64 public IPv4'],
    ['2002:808:808::', '6to4 public IPv4'],
  ] as const)('rejects transition address %s (%s)', async address => {
    await expectGuardRejection(lookupReturning([{ address, family: 6 }]), 'not_allowed');
  });

  it('rejects when resolution returns no addresses', async () => {
    await expectGuardRejection(lookupReturning([]), 'not_allowed');
  });

  it('maps lookup failure to resolution_failed', async () => {
    const lookup: DnsLookup = () => Promise.reject(new Error('ENOTFOUND'));
    await expectGuardRejection(lookup, 'resolution_failed');
  });

  it.each([
    { address: PUBLIC_IPV4, family: 6 },
    { address: PUBLIC_IPV6, family: 4 },
    { address: PUBLIC_IPV4, family: 0 },
  ])('rejects an address whose DNS family label is invalid: $address/$family', async entry => {
    await expectGuardRejection(lookupReturning([entry]), 'not_allowed');
  });
});
