import { describe, expect, it } from '@jest/globals';

import { isLoopbackIpAddress, isPublicIpAddress, parseIpAddress } from '../../../src/security/ipAddressClassifier.js';

const BLOCKED_TRANSITION_FORMS: ReadonlyArray<readonly [string, string]> = [
  ['::ffff:7f00:1', 'hex IPv4-mapped loopback 127.0.0.1'],
  ['::ffff:a9fe:a9fe', 'hex IPv4-mapped metadata 169.254.169.254'],
  ['::ffff:ac10:1', 'hex IPv4-mapped RFC1918 172.16.0.1'],
  ['::ffff:127.0.0.1', 'dotted IPv4-mapped loopback'],
  ['::ffff:10.0.0.1', 'dotted IPv4-mapped RFC1918'],
  ['::ffff:169.254.169.254', 'dotted IPv4-mapped metadata'],
  ['::7f00:1', 'IPv4-compatible loopback'],
  ['::a9fe:a9fe', 'IPv4-compatible metadata'],
  ['64:ff9b::7f00:1', 'NAT64 well-known prefix wrapping loopback'],
  ['64:ff9b::a9fe:a9fe', 'NAT64 well-known prefix wrapping metadata'],
  ['64:ff9b:1::7f00:1', 'NAT64 local-use prefix wrapping loopback'],
  ['2002:7f00:1::', '6to4 wrapping 127.0.0.0/8'],
  ['2002:a9fe:a9fe::', '6to4 wrapping metadata'],
  ['2002:ac10:1::', '6to4 wrapping RFC1918'],
];

const BLOCKED_IPV4: ReadonlyArray<readonly [string, string]> = [
  ['0.0.0.0', 'unspecified'],
  ['0.1.2.3', '0.0.0.0/8'],
  ['10.0.0.1', 'RFC1918 10/8'],
  ['100.64.0.1', 'CGNAT 100.64/10'],
  ['100.127.255.255', 'CGNAT upper bound'],
  ['127.0.0.1', 'loopback'],
  ['127.255.255.255', 'loopback upper bound'],
  ['169.254.169.254', 'link-local / cloud metadata'],
  ['172.16.0.1', 'RFC1918 172.16/12'],
  ['172.31.255.255', 'RFC1918 172.16/12 upper bound'],
  ['192.168.1.1', 'RFC1918 192.168/16'],
  ['224.0.0.1', 'multicast'],
  ['255.255.255.255', 'broadcast'],
];

const BLOCKED_IPV6: ReadonlyArray<readonly [string, string]> = [
  ['::', 'unspecified'],
  ['::1', 'loopback'],
  ['0:0:0:0:0:0:0:1', 'loopback long form'],
  ['fc00::1', 'ULA fc00::/7'],
  ['fd12:3456:789a::1', 'ULA fd-half'],
  ['fe80::1', 'link-local'],
  ['febf:ffff::1', 'link-local upper bound'],
  ['ff02::1', 'multicast'],
  ['2001:db8::1', 'documentation 2001:db8::/32'],
  ['2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', 'documentation upper bound'],
];

const ALLOWED_ADDRESSES: ReadonlyArray<readonly [string, string]> = [
  ['1.1.1.1', 'public IPv4'],
  ['8.8.8.8', 'public IPv4'],
  ['93.184.216.34', 'public IPv4'],
  ['100.63.255.255', 'just below CGNAT range'],
  ['100.128.0.0', 'just above CGNAT range'],
  ['172.15.255.255', 'just below RFC1918 172 range'],
  ['172.32.0.0', 'just above RFC1918 172 range'],
  ['223.255.255.255', 'just below multicast'],
  ['2606:4700::6810:84e5', 'public IPv6'],
  ['2a00:1450:4001:81f::200e', 'public IPv6'],
  ['2600::1', 'public IPv6'],
  ['::ffff:8.8.8.8', 'dotted IPv4-mapped public'],
  ['::ffff:808:808', 'hex IPv4-mapped public'],
  ['64:ff9b::808:808', 'NAT64 wrapping public IPv4'],
  ['2002:808:808::', '6to4 wrapping public IPv4'],
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
  ['1:2:3:4:5:6:7:8:9', 'too many groups'],
  ['1:2:3:4:5:6:7', 'too few groups without ::'],
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
      ['127.0.0.1', 'canonical v4 loopback'],
      ['127.0.0.2', 'non-first loopback address'],
      ['127.255.255.255', 'loopback upper bound'],
      ['::1', 'v6 loopback'],
      ['0:0:0:0:0:0:0:1', 'v6 loopback long form'],
      ['::ffff:127.0.0.1', 'dotted mapped loopback'],
      ['::ffff:7f00:1', 'hex mapped loopback'],
      ['::7f00:1', 'v4-compatible loopback'],
    ] as const)('identifies %s as loopback (%s)', address => {
      expect(isLoopbackIpAddress(address)).toBe(true);
    });

    it.each([
      ['128.0.0.1', 'public v4'],
      ['10.0.0.1', 'private but not loopback'],
      ['::', 'unspecified'],
      ['::2', 'v4-compatible non-loopback'],
      ['::ffff:0.0.0.1', 'mapped non-loopback'],
      ['fe80::1', 'link-local'],
      ['localhost', 'hostname, not an IP'],
      ['', 'empty string'],
      // Intentional distinction: NAT64/6to4-wrapped loopback is NOT a localhost
      // redirect for DCR loopback policy, while isPublicIpAddress still blocks
      // both as non-public on the outbound path.
      ['64:ff9b::7f00:1', 'NAT64-wrapped loopback'],
      ['2002:7f00:1::', '6to4-wrapped loopback'],
    ] as const)('does not identify %s as loopback (%s)', address => {
      expect(isLoopbackIpAddress(address)).toBe(false);
    });
  });

  describe('parseIpAddress', () => {
    it('parses IPv4 into four canonical bytes', () => {
      const parsed = parseIpAddress('192.168.1.10');
      expect(parsed).toEqual({ family: 4, bytes: new Uint8Array([192, 168, 1, 10]) });
    });

    it('parses compressed IPv6 into sixteen canonical bytes', () => {
      const parsed = parseIpAddress('2001:db8::1');
      expect(parsed?.family).toBe(6);
      expect(parsed?.bytes).toEqual(
        new Uint8Array([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
      );
    });

    it('canonicalizes dotted and hex IPv4-mapped forms identically', () => {
      const dotted = parseIpAddress('::ffff:127.0.0.1');
      const hex = parseIpAddress('::ffff:7f00:1');
      expect(dotted).not.toBeNull();
      expect(dotted).toEqual(hex);
    });

    it('returns null for unparseable input', () => {
      expect(parseIpAddress('not-an-ip')).toBeNull();
    });
  });
});
