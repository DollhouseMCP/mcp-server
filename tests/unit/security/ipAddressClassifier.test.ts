import { describe, expect, it } from '@jest/globals';

import { isLoopbackIpAddress, isPublicIpAddress, parseIpAddress } from '../../../src/security/ipAddressClassifier.js';

describe('ipAddressClassifier', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.255.255.255',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::ffff:10.0.0.1',
    '::7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::a9fe:a9fe',
    '2002:ac10:1::',
  ])('blocks non-public address %s', address => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '100.63.255.255',
    '100.128.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '2606:4700::6810:84e5',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::',
  ])('allows public address %s', address => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  it.each([
    '',
    'example.com',
    '1.2.3',
    '256.1.1.1',
    '01.2.3.4',
    '2130706433',
    '1::2::3',
    'fe80::1%eth0',
    '::ffff:999.1.1.1',
  ])('fails closed on unparseable address %s', address => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    '127.0.0.1',
    '127.255.255.255',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::7f00:1',
  ])('identifies loopback address %s', address => {
    expect(isLoopbackIpAddress(address)).toBe(true);
  });

  it('parses equivalent IPv4-mapped forms identically', () => {
    expect(parseIpAddress('::ffff:127.0.0.1')).toEqual(parseIpAddress('::ffff:7f00:1'));
  });
});
