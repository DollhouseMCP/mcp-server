import { isPublicIpAddress } from '../../../security/ipAddressClassifier.js';

export { isPublicIpAddress };

export type DnsLookup = (hostname: string, options: { readonly all: true }) => Promise<readonly DnsLookupAddress[]>;

export interface DnsLookupAddress {
  readonly address: string;
  readonly family: number;
}

export type PublicHostGuardReason = 'resolution_failed' | 'not_allowed';

export class PublicHostGuardError extends Error {
  constructor(readonly reason: PublicHostGuardReason) {
    super(reason === 'resolution_failed'
      ? 'Outbound host could not be resolved.'
      : 'Outbound host resolved to a non-public address.');
    this.name = 'PublicHostGuardError';
  }
}

/** Resolve once and return the vetted address that the connection must use. */
export async function assertPublicResolvedHost(hostname: string, lookup: DnsLookup): Promise<DnsLookupAddress> {
  let addresses: readonly DnsLookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new PublicHostGuardError('resolution_failed');
  }
  if (addresses.length === 0 || addresses.some(entry => !isPublicIpAddress(entry.address))) {
    throw new PublicHostGuardError('not_allowed');
  }
  return addresses[0];
}
