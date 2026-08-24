import { describe, expect, it } from '@jest/globals';

import {
  buildCredentialRedactions,
  redactIntegrationResponseBody,
  type EffectiveCredentialInjection,
} from '../../../../src/web-console/modules/integrations/IntegrationCredentialRedactor.js';

function bearerInjection(token: string): EffectiveCredentialInjection {
  return {
    location: 'header',
    name: 'Authorization',
    value: `Bearer ${token}`,
    sensitiveValue: token,
    caseInsensitivePrefixLength: 'Bearer '.length,
  };
}

function queryInjection(name: string, value: string): EffectiveCredentialInjection {
  return { location: 'query', name, value, sensitiveValue: value };
}

function redact(
  text: string,
  injection: EffectiveCredentialInjection,
  contentType: string | null = 'text/plain',
): unknown {
  return redactIntegrationResponseBody(
    text,
    contentType,
    buildCredentialRedactions(injection.sensitiveValue, injection),
  );
}

describe('IntegrationCredentialRedactor', () => {
  it('recursively redacts credential-shaped JSON fields and exact token values', () => {
    const token = 'oauth-secret-value';
    const result = redact(JSON.stringify({
      access_token: 'provider-token',
      nested: { api_key: 'provider-key', echoed: token },
      ordinary: 'available',
    }), bearerInjection(token), 'application/json');

    expect(result).toEqual({
      access_token: '[redacted]',
      nested: { api_key: '[redacted]', echoed: '[redacted]' },
      ordinary: 'available',
    });
  });

  it('fails closed for malformed data declared as JSON', () => {
    expect(redact('{"access_token":', bearerInjection('oauth-secret-value'), 'application/json'))
      .toBe('[redacted]');
  });

  it('strips a BOM and preserves ordinary JSON data', () => {
    expect(redact(
      '\uFEFF{"echo":"oauth-secret-value","ordinary":"available"}',
      bearerInjection('oauth-secret-value'),
      'application/problem+json',
    )).toEqual({ echo: '[redacted]', ordinary: 'available' });
  });

  it('preserves exact JSON number lexemes in mislabelled JSON-shaped text', () => {
    const result = redact(
      '{"id":9007199254740995,"exponent":1e+30,"echo":"oauth-secret-value"}',
      bearerInjection('oauth-secret-value'),
    );
    expect(result).toBe('{"id":9007199254740995,"exponent":1e+30,"echo":"[redacted]"}');
  });

  it('redacts long credentials embedded in ordinary text', () => {
    expect(redact(
      'received oauth-secret-value safely',
      bearerInjection('oauth-secret-value'),
    )).toBe('received [redacted] safely');
  });

  it('does not corrupt unrelated text that happens to contain a short token', () => {
    expect(redact('a normal response', bearerInjection('a'))).toBe('a normal response');
    expect(redact('access_token=a; tokenizedValue=a', bearerInjection('a')))
      .toBe('[redacted]; tokenizedValue=a');
  });

  it.each([
    ['literal query', 'received api_key=alpha-secret safely'],
    ['percent-encoded query', 'received api_key%3Dalpha-secret safely'],
    ['encoded value', 'received api_key=alpha%2Dsecret safely'],
  ])('redacts %s echoes', (_label, text) => {
    expect(redact(text, queryInjection('api_key', 'alpha-secret')))
      .toBe('received [redacted] safely');
  });

  it('preserves literal pluses while redacting their encoded form', () => {
    expect(redact('access_token=%61%2Bb', bearerInjection('a+b'))).toBe('[redacted]');
  });

  it('matches authorization schemes case-insensitively but token bytes exactly', () => {
    expect(redact(
      'authorization: bEaReR a; authorization: bearer A',
      bearerInjection('a'),
    )).toBe('[redacted]; authorization: bearer A');
  });

  it('redacts JSON-escaped credential labels and values', () => {
    expect(redact(
      '{"access\\u005ftoken":"oauth\\u002dsecret\\u002dvalue"}',
      bearerInjection('oauth-secret-value'),
    )).toBe('{"access_token":"[redacted]"}');
  });

  it('combines multiple credential injections without dropping retry credentials', () => {
    const primary = bearerInjection('new-access-token');
    const old = bearerInjection('old-access-token');
    const redactions = buildCredentialRedactions(primary.sensitiveValue, primary, [{
      credential: old.sensitiveValue,
      injection: old,
    }]);
    expect(redactIntegrationResponseBody(
      'old-access-token then new-access-token',
      'text/plain',
      redactions,
    )).toBe('[redacted] then [redacted]');
  });

  it('redacts HTTP Basic composites and decoded password components', () => {
    const composite = 'account-id:super-secret';
    const encoded = Buffer.from(composite, 'utf8').toString('base64');
    const injection: EffectiveCredentialInjection = {
      location: 'header',
      name: 'Authorization',
      value: `Basic ${encoded}`,
      sensitiveValue: encoded,
      caseInsensitivePrefixLength: 'Basic '.length,
      additionalSensitiveValues: ['super-secret'],
      additionalBoundedValues: [composite],
    };
    expect(redact(
      `authorization: basic ${encoded}; password=super-secret; ${composite}`,
      injection,
    )).toBe('[redacted]; password=[redacted]; [redacted]');
  });
});
