import { describe, expect, it } from '@jest/globals';

import {
  MAX_IDEMPOTENCY_BODY_BYTES,
  MAX_IDEMPOTENCY_BODY_DEPTH,
  canonicalRequestTarget,
  fingerprintBody,
} from '../../../../src/web-console/middleware/ConsoleIdempotency.js';
import type {
  ConsoleRequest,
  ConsoleRouteDefinition,
} from '../../../../src/web-console/platform/ConsolePlatformTypes.js';

const PORTFOLIO_MUTATION_ROUTE = {
  method: 'PATCH',
  path: '/api/v1/me/portfolio/elements/:type/:name',
  audience: 'self',
  requiredCapability: 'console:self',
  ownership: 'authenticated_user',
  elevation: 'none',
  privacyClass: 'self_private',
  idempotency: 'required',
  pathParamValueNormalization: { name: 'nfc' },
  handler: () => ({ status: 200 }),
} satisfies ConsoleRouteDefinition;

function requestForTarget(
  originalUrl: string,
  overrides: Partial<Pick<ConsoleRequest, 'params' | 'query'>> = {},
): ConsoleRequest {
  return { originalUrl, params: {}, query: {}, ...overrides } as ConsoleRequest;
}

describe('console idempotency canonicalization', () => {
  it('orders query values using deterministic code-unit comparison', () => {
    expect(canonicalRequestTarget(requestForTarget('/api/v1/me/change?value=%C3%A4&value=a&name=z', {
      query: { value: ['ä', 'a'], name: 'z' },
    })))
      .toBe('/api/v1/me/change?name=z&value=a&value=%C3%A4');
  });

  it('uses normalized params and query values for canonical idempotency targets', () => {
    const request = requestForTarget('/api/v1/me/portfolio/elements/personas/%CE%B1-cafe%CC%81?tag=cafe%CC%81', {
      params: { type: 'personas', name: 'α-café' },
      query: { tag: 'café' },
    });

    expect(canonicalRequestTarget(request, PORTFOLIO_MUTATION_ROUTE))
      .toBe('/api/v1/me/portfolio/elements/personas/%CE%B1-caf%C3%A9?tag=caf%C3%A9');
  });

  it('fingerprints object key order canonically', () => {
    expect(fingerprintBody({ b: 2, a: { d: 4, c: 3 } }))
      .toEqual(fingerprintBody({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it('rejects non-JSON, excessively nested, or oversized request bodies', () => {
    let nested: unknown = null;
    for (let depth = 0; depth <= MAX_IDEMPOTENCY_BODY_DEPTH; depth += 1) {
      nested = [nested];
    }

    expect(() => fingerprintBody({ invalid: undefined })).toThrow('valid JSON');
    expect(() => fingerprintBody(nested)).toThrow('nesting limit');
    expect(() => fingerprintBody({ value: 'x'.repeat(MAX_IDEMPOTENCY_BODY_BYTES) }))
      .toThrow('fingerprint limit');
  });
});
