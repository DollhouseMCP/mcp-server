/**
 * Canonical IP address classification for outbound SSRF guards.
 *
 * Text is parsed into fixed-width bytes before classification so IPv6 forms
 * that embed IPv4 addresses cannot disguise a non-public destination.
 */
const IPV6_BYTE_LENGTH = 16;
const IPV6_GROUP_COUNT = 8;
const HEXTET_PATTERN = /^[0-9a-f]{1,4}$/i;
const IPV4_OCTET_PATTERN = /^\d{1,3}$/;
type Ipv4RangePredicate = (bytes: Uint8Array) => boolean;

interface IpPrefix {
  readonly bytes: readonly number[];
  readonly bits: number;
}

const NON_PUBLIC_IPV4_RANGES: readonly Ipv4RangePredicate[] = [
  bytes => bytes[0] === 0,
  bytes => bytes[0] === 10,
  bytes => bytes[0] === 127,
  bytes => bytes[0] === 100 && bytes[1] >= 64 && bytes[1] <= 127,
  bytes => bytes[0] === 169 && bytes[1] === 254,
  bytes => bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31,
  bytes => bytes[0] === 192 && bytes[1] === 0,
  bytes => bytes[0] === 192 && bytes[1] === 88 && bytes[2] === 99,
  bytes => bytes[0] === 192 && bytes[1] === 168,
  bytes => bytes[0] === 198 && (bytes[1] === 18 || bytes[1] === 19),
  bytes => bytes[0] === 198 && bytes[1] === 51 && bytes[2] === 100,
  bytes => bytes[0] === 203 && bytes[1] === 0 && bytes[2] === 113,
  bytes => bytes[0] >= 224,
];

// Keep the fail-closed exceptions aligned with the IANA IPv6 Special-Purpose Address Registry.
const IPV6_GLOBAL_UNICAST: IpPrefix = { bytes: [0x20], bits: 3 };
const IPV6_IANA_PROTOCOL_ASSIGNMENTS: IpPrefix = { bytes: [0x20, 0x01, 0x00], bits: 23 };
const IPV6_DOCUMENTATION: readonly IpPrefix[] = [
  { bytes: [0x20, 0x01, 0x0d, 0xb8], bits: 32 },
  { bytes: [0x3f, 0xff, 0x00], bits: 20 },
];
const IPV6_DEPRECATED_OR_TRANSITION: readonly IpPrefix[] = [
  { bytes: [0x20, 0x02], bits: 16 },
  { bytes: [0x3f, 0xfe], bits: 16 },
];
const GLOBALLY_REACHABLE_IANA_PROTOCOL_ASSIGNMENTS: readonly IpPrefix[] = [
  { bytes: [0x20, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], bits: 128 },
  { bytes: [0x20, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], bits: 128 },
  { bytes: [0x20, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3], bits: 128 },
  { bytes: [0x20, 0x01, 0x00, 0x03], bits: 32 },
  { bytes: [0x20, 0x01, 0x00, 0x04, 0x01, 0x12], bits: 48 },
  { bytes: [0x20, 0x01, 0x00, 0x20], bits: 28 },
  { bytes: [0x20, 0x01, 0x00, 0x30], bits: 28 },
];
const IPV4_MAPPED_PREFIX: IpPrefix = {
  bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff],
  bits: 96,
};
const WELL_KNOWN_NAT64_PREFIX: IpPrefix = {
  bytes: [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0],
  bits: 96,
};

export interface CanonicalIpAddress {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
}

export function parseIpAddress(address: string): CanonicalIpAddress | null {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== null) return { family: 4, bytes: ipv4 };
  const ipv6 = parseIpv6(address);
  if (ipv6 !== null) return { family: 6, bytes: ipv6 };
  return null;
}

export function isPublicIpAddress(address: string): boolean {
  const canonical = parseIpAddress(address);
  if (canonical === null) return false;
  return canonical.family === 4
    ? isPublicIpv4Bytes(canonical.bytes)
    : isPublicIpv6Bytes(canonical.bytes);
}

export function isLoopbackIpAddress(address: string): boolean {
  const canonical = parseIpAddress(address);
  if (canonical === null) return false;
  if (canonical.family === 4) return canonical.bytes[0] === 127;
  if (hasZeroPrefix(canonical.bytes, 15) && canonical.bytes[15] === 1) return true;
  const mapped = hasZeroPrefix(canonical.bytes, 10) &&
    canonical.bytes[10] === 0xff && canonical.bytes[11] === 0xff;
  const compatible = hasZeroPrefix(canonical.bytes, 12);
  return (mapped || compatible) && canonical.bytes[12] === 127;
}

function parseIpv4(address: string): Uint8Array | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (const [index, part] of parts.entries()) {
    if (!IPV4_OCTET_PATTERN.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const value = Number.parseInt(part, 10);
    if (value > 255) return null;
    bytes[index] = value;
  }
  return bytes;
}

function parseIpv6(address: string): Uint8Array | null {
  if (address.length === 0 || address.includes('%')) return null;
  const hextetForm = rewriteEmbeddedIpv4Tail(address);
  if (hextetForm === null) return null;
  const sections = hextetForm.split('::');
  if (sections.length > 2) return null;
  const head = splitHextets(sections[0]);
  if (head === null) return null;
  let groups: number[] | null = head;
  if (sections.length === 2) {
    const tail = splitHextets(sections[1]);
    if (tail === null) return null;
    groups = expandZeroRun(head, tail);
  }
  if (groups?.length !== IPV6_GROUP_COUNT) return null;
  const bytes = new Uint8Array(IPV6_BYTE_LENGTH);
  for (const [index, group] of groups.entries()) {
    bytes[index * 2] = group >>> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function rewriteEmbeddedIpv4Tail(address: string): string | null {
  if (!address.includes('.')) return address;
  const lastColon = address.lastIndexOf(':');
  if (lastColon === -1) return null;
  const embedded = parseIpv4(address.slice(lastColon + 1));
  if (embedded === null) return null;
  const high = ((embedded[0] << 8) | embedded[1]).toString(16);
  const low = ((embedded[2] << 8) | embedded[3]).toString(16);
  return `${address.slice(0, lastColon + 1)}${high}:${low}`;
}

function splitHextets(section: string): number[] | null {
  if (section.length === 0) return [];
  const groups: number[] = [];
  for (const part of section.split(':')) {
    if (!HEXTET_PATTERN.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function expandZeroRun(head: number[], tail: number[]): number[] | null {
  const zeroCount = IPV6_GROUP_COUNT - head.length - tail.length;
  if (zeroCount < 1) return null;
  return [...head, ...new Array<number>(zeroCount).fill(0), ...tail];
}

function isPublicIpv4Bytes(bytes: Uint8Array): boolean {
  return !NON_PUBLIC_IPV4_RANGES.some(isInRange => isInRange(bytes));
}

function isPublicIpv6Bytes(bytes: Uint8Array): boolean {
  const embedded = extractPubliclyRoutableEmbeddedIpv4(bytes);
  if (embedded !== null) return isPublicIpv4Bytes(embedded);
  if (!matchesPrefix(bytes, IPV6_GLOBAL_UNICAST)) return false;
  if (matchesPrefix(bytes, IPV6_IANA_PROTOCOL_ASSIGNMENTS)) {
    return GLOBALLY_REACHABLE_IANA_PROTOCOL_ASSIGNMENTS.some(prefix => matchesPrefix(bytes, prefix));
  }
  if (IPV6_DOCUMENTATION.some(prefix => matchesPrefix(bytes, prefix))) return false;
  if (IPV6_DEPRECATED_OR_TRANSITION.some(prefix => matchesPrefix(bytes, prefix))) return false;
  return true;
}

function extractPubliclyRoutableEmbeddedIpv4(bytes: Uint8Array): Uint8Array | null {
  if (matchesPrefix(bytes, IPV4_MAPPED_PREFIX) || matchesPrefix(bytes, WELL_KNOWN_NAT64_PREFIX)) {
    return bytes.slice(12);
  }
  return null;
}

function matchesPrefix(address: Uint8Array, prefix: IpPrefix): boolean {
  const completeBytes = Math.floor(prefix.bits / 8);
  for (let index = 0; index < completeBytes; index += 1) {
    if (address[index] !== prefix.bytes[index]) return false;
  }
  const remainingBits = prefix.bits % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (address[completeBytes] & mask) === ((prefix.bytes[completeBytes] ?? 0) & mask);
}

function hasZeroPrefix(bytes: Uint8Array, length: number): boolean {
  return hasZeroRange(bytes, 0, length);
}

function hasZeroRange(bytes: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}
