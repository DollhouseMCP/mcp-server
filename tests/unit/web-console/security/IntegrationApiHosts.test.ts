import { describe, expect, it } from '@jest/globals';

import {
  canonicalizeIntegrationApiHost,
  canonicalizeIntegrationApiHosts,
  IntegrationApiHostValidationError,
  isIntegrationApiHostAllowed,
} from '../../../../src/web-console/security/IntegrationApiHosts.js';

describe('IntegrationApiHosts', () => {
  it.each([
    ['API.Example.COM', 'api.example.com'],
    ['api.example.com.', 'api.example.com'],
    ['bücher.example', 'xn--bcher-kva.example'],
    ['api．example.com', 'api.example.com'],
    ['аpi.example.com', 'xn--pi-6kc.example.com'],
  ])('canonicalizes %s to an unambiguous hostname', (input, expected) => {
    expect(canonicalizeIntegrationApiHost(input)).toBe(expected);
  });

  it('deduplicates equivalent canonical hosts while preserving first-seen order', () => {
    expect(canonicalizeIntegrationApiHosts([
      'API.Example.COM',
      'api.example.com.',
      'bücher.example',
      'xn--bcher-kva.example',
      'uploads.example.com',
    ])).toEqual([
      'api.example.com',
      'xn--bcher-kva.example',
      'uploads.example.com',
    ]);
  });

  it.each([
    '',
    ' api.example.com',
    'api.example.com ',
    'https://api.example.com',
    'user@api.example.com',
    'api.example.com:443',
    'api.example.com/path',
    'api.example.com?debug=true',
    'api.example.com#fragment',
    'api.example.com\\path',
    '%61pi.example.com',
    'api..example.com',
    'api.example.com..',
    'api_example.com',
    'api\u200B.example.com',
    'api\u202E.example.com',
  ])('rejects malformed or visually unsafe host %j', input => {
    expect(() => canonicalizeIntegrationApiHost(input)).toThrow(IntegrationApiHostValidationError);
  });

  it.each([
    'localhost',
    'api.localhost',
    'service.local',
    'service.internal',
    'router.home.arpa',
    'service.corp',
    'service.home',
    'service.lan',
    '127.0.0.1',
    '[::1]',
    'singlelabel',
  ])('rejects non-public host %s', input => {
    expect(() => canonicalizeIntegrationApiHost(input)).toThrow(/public DNS hostname|must be a hostname/);
  });

  it('accepts the DNS maximum and rejects a hostname beyond it', () => {
    const atLimit = [63, 63, 63, 61].map(length => 'a'.repeat(length)).join('.');
    const beyondLimit = [63, 63, 63, 62].map(length => 'a'.repeat(length)).join('.');

    expect(atLimit).toHaveLength(253);
    expect(canonicalizeIntegrationApiHost(atLimit)).toBe(atLimit);
    expect(beyondLimit).toHaveLength(254);
    expect(() => canonicalizeIntegrationApiHost(beyondLimit)).toThrow('must be a public DNS hostname');
  });

  it('requires a bounded non-empty source list even when entries would deduplicate', () => {
    expect(() => canonicalizeIntegrationApiHosts([])).toThrow('must contain 1-25 hosts');
    expect(() => canonicalizeIntegrationApiHosts(Array.from({ length: 26 }, () => 'api.example.com')))
      .toThrow('must contain 1-25 hosts');
  });

  it('matches equivalent URL hostname spellings against canonical allowlists', () => {
    expect(isIntegrationApiHostAllowed('API.Example.COM.', ['api.example.com'])).toBe(true);
    expect(isIntegrationApiHostAllowed('bücher.example.', ['xn--bcher-kva.example'])).toBe(true);
    expect(isIntegrationApiHostAllowed('other.example.com', ['api.example.com'])).toBe(false);
    expect(isIntegrationApiHostAllowed('localhost', ['api.example.com'])).toBe(false);
  });

  it('keeps legacy private-suffix compatibility read-only and blocks runtime egress', () => {
    expect(canonicalizeIntegrationApiHost(
      'api.company.corp',
      'legacy api host',
      { allowLegacyPrivateSuffixes: true },
    )).toBe('api.company.corp');
    expect(() => canonicalizeIntegrationApiHost('api.company.corp')).toThrow('public DNS hostname');
    expect(isIntegrationApiHostAllowed('api.company.corp', ['api.company.corp'])).toBe(false);
  });
});
