import { isIP } from 'node:net';

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

export async function assertPublicResolvedHost(hostname: string, lookup: DnsLookup): Promise<void> {
  let addresses: readonly DnsLookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new PublicHostGuardError('resolution_failed');
  }
  if (addresses.length === 0 || addresses.some(entry => !isPublicIpAddress(entry.address))) {
    throw new PublicHostGuardError('not_allowed');
  }
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = normalizeIpv4MappedAddress(address);
  const version = isIP(normalized);
  if (version === 4) return isPublicIpv4(normalized);
  if (version === 6) return isPublicIpv6(normalized);
  return false;
}

function normalizeIpv4MappedAddress(address: string): string {
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return mapped?.[1] ?? address;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(part => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return false;
  const firstGroup = Number.parseInt(normalized.split(':')[0] || '0', 16);
  if (Number.isNaN(firstGroup)) return false;
  if ((firstGroup & 0xfe00) === 0xfc00) return false;
  if ((firstGroup & 0xffc0) === 0xfe80) return false;
  if ((firstGroup & 0xff00) === 0xff00) return false;
  return true;
}
