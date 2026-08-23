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
  ])('canonicalizes %s', (input, expected) => {
    expect(canonicalizeIntegrationApiHost(input)).toBe(expected);
  });

  it.each([
    '',
    ' api.example.com',
    'https://api.example.com',
    'user@api.example.com',
    'api.example.com:443',
    'api.example.com/path',
    'api\u200B.example.com',
    'api..example.com',
  ])('rejects malformed host %j', input => {
    expect(() => canonicalizeIntegrationApiHost(input)).toThrow(IntegrationApiHostValidationError);
  });

  it.each([
    'localhost',
    'service.local',
    'service.internal',
    'router.home.arpa',
    'service.corp',
    'service.lan',
    '127.0.0.1',
  ])('rejects private host %s', input => {
    expect(() => canonicalizeIntegrationApiHost(input)).toThrow();
  });

  it('rejects host input beyond the explicit parser ceiling', () => {
    expect(() => canonicalizeIntegrationApiHost(`${'a'.repeat(1024)}.example`)).toThrow();
  });

  it('deduplicates canonical hosts and compares equivalent spellings', () => {
    expect(canonicalizeIntegrationApiHosts([
      'API.Example.COM',
      'api.example.com.',
      'uploads.example.com',
    ])).toEqual(['api.example.com', 'uploads.example.com']);
    expect(isIntegrationApiHostAllowed('API.Example.COM.', ['api.example.com'])).toBe(true);
  });

  it('keeps private-suffix compatibility read-only', () => {
    expect(canonicalizeIntegrationApiHost(
      'api.company.corp',
      'legacy host',
      { allowLegacyPrivateSuffixes: true },
    )).toBe('api.company.corp');
    expect(isIntegrationApiHostAllowed('api.company.corp', ['api.company.corp'])).toBe(false);
  });
});
