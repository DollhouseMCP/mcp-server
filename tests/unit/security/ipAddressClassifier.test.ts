import { describe, expect, it } from '@jest/globals';

import { isLoopbackIpAddress, isPublicIpAddress, parseIpAddress } from '../../../src/security/ipAddressClassifier.js';

const IETF_PROTOCOL_ASSIGNMENT = 'IETF protocol assignment';
const GLOBALLY_REACHABLE_PROTOCOL_ASSIGNMENT = 'globally reachable protocol assignment';

const BLOCKED_TRANSITION_FORMS: ReadonlyArray<readonly [string, string]> = [
  ['::ffff:7f00:1', 'hex IPv4-mapped loopback'],
  ['::ffff:a9fe:a9fe', 'hex IPv4-mapped metadata'],
  ['::ffff:10.0.0.1', 'dotted IPv4-mapped RFC1918'],
  ['::7f00:1', 'IPv4-compatible loopback'],
  ['::a9fe:a9fe', 'IPv4-compatible metadata'],
  ['::8.8.8.8', 'IPv4-compatible public address'],
  ['64:ff9b::7f00:1', 'well-known NAT64 wrapping loopback'],
  ['64:ff9b::a9fe:a9fe', 'well-known NAT64 wrapping metadata'],
  ['64:ff9b:1::7f00:1', 'local-use NAT64 wrapping loopback'],
  ['64:ff9b:1::a9fe:a9fe', 'local-use NAT64 wrapping metadata'],
  ['64:ff9b:1::808:808', 'local-use NAT64 wrapping public IPv4'],
  ['2002:7f00:1::', '6to4 wrapping loopback'],
  ['2002:a9fe:a9fe::', '6to4 wrapping metadata'],
  ['2002:ac10:1::', '6to4 wrapping RFC1918'],
  ['2002:808:808::', '6to4 wrapping public IPv4'],
];

const BLOCKED_IPV4: ReadonlyArray<readonly [string, string]> = [
  ['0.0.0.0', 'unspecified'],
  ['10.0.0.1', 'RFC1918 10/8'],
  ['100.64.0.1', 'CGNAT lower bound'],
  ['100.127.255.255', 'CGNAT upper bound'],
  ['127.255.255.255', 'loopback upper bound'],
  ['169.254.169.254', 'link-local metadata'],
  ['172.16.0.1', 'RFC1918 172.16/12'],
  ['172.31.255.255', 'RFC1918 upper bound'],
  ['192.0.0.1', 'IETF protocol assignments'],
  ['192.0.0.8', 'IETF protocol assignments'],
  ['192.0.0.11', 'IETF protocol assignments'],
  ['192.0.2.1', 'documentation'],
  ['192.88.99.2', 'deprecated relay anycast range'],
  ['192.168.1.1', 'RFC1918 192.168/16'],
  ['198.18.0.1', 'benchmarking'],
  ['198.51.100.1', 'documentation'],
  ['203.0.113.1', 'documentation'],
  ['224.0.0.1', 'multicast'],
  ['255.255.255.255', 'broadcast'],
];

const BLOCKED_IPV6: ReadonlyArray<readonly [string, string]> = [
  ['::', 'unspecified'],
  ['::1', 'loopback'],
  ['fc00::1', 'unique local'],
  ['fe80::1', 'link-local'],
  ['ff02::1', 'multicast'],
  ['fec0::1', 'deprecated site-local'],
  ['100::1', 'discard-only'],
  ['100:0:0:1::1', IETF_PROTOCOL_ASSIGNMENT],
  ['2001::1', IETF_PROTOCOL_ASSIGNMENT],
  ['2001:1::4', 'IETF protocol assignment outside global exceptions'],
  ['2001:2::1', 'benchmarking'],
  ['2001:5::1', IETF_PROTOCOL_ASSIGNMENT],
  ['2001:10::1', 'ORCHID'],
  ['2001:20::1', 'ORCHIDv2'],
  ['2001:30::1', IETF_PROTOCOL_ASSIGNMENT],
  ['2001:40::1', IETF_PROTOCOL_ASSIGNMENT],
  ['2001:db8::1', 'documentation'],
  ['3ffe::1', '6bone'],
  ['3fff::1', 'documentation'],
  ['5f00::1', 'outside global-unicast 2000::/3'],
];

const ALLOWED_ADDRESSES: ReadonlyArray<readonly [string, string]> = [
  ['1.1.1.1', 'public IPv4'],
  ['8.8.8.8', 'public IPv4'],
  ['93.184.216.34', 'public IPv4'],
  ['100.63.255.255', 'below CGNAT'],
  ['100.128.0.0', 'above CGNAT'],
  ['172.15.255.255', 'below RFC1918 172 range'],
  ['172.32.0.0', 'above RFC1918 172 range'],
  ['192.0.0.9', GLOBALLY_REACHABLE_PROTOCOL_ASSIGNMENT],
  ['192.0.0.10', GLOBALLY_REACHABLE_PROTOCOL_ASSIGNMENT],
  ['192.0.1.1', 'public IPv4 adjacent to protocol assignments'],
  ['223.255.255.255', 'below multicast'],
  ['2606:4700::6810:84e5', 'public IPv6'],
  ['2a00:1450:4001:81f::200e', 'public IPv6'],
  ['::ffff:8.8.8.8', 'dotted IPv4-mapped public'],
  ['::ffff:808:808', 'hex IPv4-mapped public'],
  ['64:ff9b::808:808', 'well-known NAT64 wrapping public IPv4'],
  ['2001:1::1', GLOBALLY_REACHABLE_PROTOCOL_ASSIGNMENT],
  ['2001:1::2', GLOBALLY_REACHABLE_PROTOCOL_ASSIGNMENT],
  ['2001:1::3', GLOBALLY_REACHABLE_PROTOCOL_ASSIGNMENT],
  ['2001:3::1', GLOBALLY_REACHABLE_PROTOCOL_ASSIGNMENT],
  ['2001:4:112::1', GLOBALLY_REACHABLE_PROTOCOL_ASSIGNMENT],
];

const UNPARSEABLE_INPUTS: ReadonlyArray<readonly [string, string]> = [
  ['', 'empty string'],
  ['example.com', 'hostname'],
  ['1.2.3', 'too few octets'],
  ['1.2.3.4.5', 'too many octets'],
  ['256.1.1.1', 'octet out of range'],
  ['01.2.3.4', 'leading-zero octet'],
  ['2130706433', 'decimal-encoded loopback'],
  ['0x7f.0.0.1', 'hex-encoded octet'],
  ['1:2:3:4:5:6:7:8:9', 'too many IPv6 groups'],
  ['1:2:3:4:5:6:7', 'too few groups without compression'],
  ['1::2::3', 'multiple zero runs'],
  [':::1', 'triple colon'],
  ['12345::1', 'oversized hextet'],
  ['fe80::1%eth0', 'zone identifier'],
  ['::ffff:999.1.1.1', 'embedded IPv4 out of range'],
  ['::ffff:1.2.3', 'embedded IPv4 too short'],
];

describe('ipAddressClassifier', () => {
  describe('isPublicIpAddress', () => {
    it.each(BLOCKED_TRANSITION_FORMS)('blocks %s (%s)', address => {
      expect(isPublicIpAddress(address)).toBe(false);
    });

    it.each(BLOCKED_IPV4)('blocks %s (%s)', address => {
      expect(isPublicIpAddress(address)).toBe(false);
    });

    it.each(BLOCKED_IPV6)('blocks %s (%s)', address => {
      expect(isPublicIpAddress(address)).toBe(false);
    });

    it.each(ALLOWED_ADDRESSES)('allows %s (%s)', address => {
      expect(isPublicIpAddress(address)).toBe(true);
    });

    it.each(UNPARSEABLE_INPUTS)('fails closed on %s (%s)', address => {
      expect(isPublicIpAddress(address)).toBe(false);
    });
  });

  describe('isLoopbackIpAddress', () => {
    it.each([
      ['127.0.0.1', 'IPv4 loopback'],
      ['127.255.255.255', 'IPv4 loopback upper bound'],
      ['::1', 'IPv6 loopback'],
      ['0:0:0:0:0:0:0:1', 'IPv6 loopback long form'],
      ['::ffff:127.0.0.1', 'dotted mapped loopback'],
      ['::ffff:7f00:1', 'hex mapped loopback'],
      ['::7f00:1', 'IPv4-compatible loopback'],
    ] as const)('identifies %s as loopback (%s)', address => {
      expect(isLoopbackIpAddress(address)).toBe(true);
    });

    it.each([
      ['128.0.0.1', 'public IPv4'],
      ['10.0.0.1', 'private but not loopback'],
      ['::', 'unspecified'],
      ['::2', 'compatible but not loopback'],
      ['::ffff:0.0.0.1', 'mapped but not loopback'],
      ['fe80::1', 'link-local'],
      ['64:ff9b::7f00:1', 'NAT64-wrapped loopback'],
      ['2002:7f00:1::', '6to4-wrapped loopback'],
      ['localhost', 'hostname rather than IP'],
    ] as const)('does not identify %s as loopback (%s)', address => {
      expect(isLoopbackIpAddress(address)).toBe(false);
    });
  });

  describe('parseIpAddress', () => {
    it('parses IPv4 into four canonical bytes', () => {
      expect(parseIpAddress('192.168.1.10')).toEqual({
        family: 4,
        bytes: new Uint8Array([192, 168, 1, 10]),
      });
    });

    it('parses compressed IPv6 into sixteen canonical bytes', () => {
      expect(parseIpAddress('2001:db8::1')).toEqual({
        family: 6,
        bytes: new Uint8Array([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
      });
    });

    it('canonicalizes dotted and hex IPv4-mapped forms identically', () => {
      expect(parseIpAddress('::ffff:127.0.0.1')).toEqual(parseIpAddress('::ffff:7f00:1'));
    });

    it('returns null for unparseable input', () => {
      expect(parseIpAddress('not-an-ip')).toBeNull();
    });
  });
});
