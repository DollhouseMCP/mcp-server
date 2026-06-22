/**
 * Cycle-8 fix (B1): oidc-provider's `proxy` setting must follow
 * DOLLHOUSE_TRUSTED_PROXIES so deployments behind a TLS-terminating
 * upstream proxy (Cloudflare Tunnel, nginx, ALB, etc.) get correct
 * redirect URI validation.
 *
 * Earlier shape hardcoded `provider.proxy = false`, which broke every
 * deployment that put TLS at an upstream proxy: oidc-provider would
 * compute `req.protocol === 'http'` from the raw request and reject
 * the operator-configured `https://...` redirect URIs as not matching.
 *
 * shouldTrustUpstreamProxy is the predicate that decides this. It
 * reads the same env source of truth (DOLLHOUSE_TRUSTED_PROXIES) that
 * Express's `app.set('trust proxy', ...)` reads in StreamableHttpServer.
 *
 * Truth table:
 *   undefined          → false (no proxy configured at all)
 *   []                 → false (defensive: empty list = unset)
 *   ['loopback']       → false (Express's loopback-only default — no upstream proxy)
 *   ['10.0.0.0/8']     → true (real CIDR = real proxy)
 *   ['loopback','...'] → true (real CIDR present alongside loopback)
 */

import { describe, it, expect } from '@jest/globals';
import { shouldTrustUpstreamProxy } from '../../../../src/auth/embedded-as/EmbeddedAuthorizationServer.js';

describe('shouldTrustUpstreamProxy', () => {
  it('returns false when DOLLHOUSE_TRUSTED_PROXIES is unset (undefined)', () => {
    // Native HTTPS at the server, no proxy in front. oidc-provider
    // should NOT trust X-Forwarded-* headers — req is terminal.
    expect(shouldTrustUpstreamProxy(undefined)).toBe(false);
  });

  it('returns false for an empty array (defensive)', () => {
    // The Zod transform already filters Boolean, so this shouldn't
    // happen in practice, but the predicate must be safe.
    expect(shouldTrustUpstreamProxy([])).toBe(false);
  });

  it("returns false for ['loopback'] (Express's loopback-only default)", () => {
    // This is what env.ts produces when no upstream proxy is
    // configured. Same semantic as undefined — no real proxy.
    expect(shouldTrustUpstreamProxy(['loopback'])).toBe(false);
  });

  it('returns true for a real CIDR range (operator named an upstream proxy)', () => {
    expect(shouldTrustUpstreamProxy(['10.0.0.0/8'])).toBe(true);
  });

  it('returns true for IPv6 CIDR', () => {
    expect(shouldTrustUpstreamProxy(['fd00::/8'])).toBe(true);
  });

  it('returns true when loopback is listed alongside a real CIDR', () => {
    // Operator wants both loopback (for local probes) and the real
    // proxy CIDR trusted. The presence of any non-loopback entry
    // means there IS an upstream proxy.
    expect(shouldTrustUpstreamProxy(['loopback', '10.0.0.0/8'])).toBe(true);
  });

  it("returns true for 'linklocal' / 'uniquelocal' keywords (real network categories)", () => {
    // proxy-addr understands these as Express keyword shorthands.
    // They name actual address ranges, not the loopback-only default.
    expect(shouldTrustUpstreamProxy(['uniquelocal'])).toBe(true);
  });
});
