/**
 * Round 5 / H2 + H4: hosted-deployment startup-fail guards.
 *
 * Locks the contract that:
 *   - Multi-user methods + non-loopback bind + auth disabled = throw
 *     (would ship an unauthenticated MCP endpoint).
 *   - Multi-user methods + non-loopback bind + no DOLLHOUSE_TRUSTED_PROXIES
 *     = throw (per-IP rate limits would collapse to the proxy IP).
 *   - Solo localhost (loopback bind) is always allowed regardless of
 *     other settings.
 *   - trivial-consent on non-loopback is NOT caught here — must-fix #8
 *     in AuthProviderFactory handles that case.
 */

import { describe, it, expect } from '@jest/globals';
import { assertHostedDeploymentSafety } from '../../../src/server/StreamableHttpServer.js';

describe('assertHostedDeploymentSafety', () => {
  it('passes for loopback bind regardless of other settings', async () => {
    await expect(assertHostedDeploymentSafety({
      host: '127.0.0.1',
      methods: ['github'],
      authEnabled: false,
      trustedProxies: undefined,
    })).resolves.toBeUndefined();

    await expect(assertHostedDeploymentSafety({
      host: 'localhost',
      methods: ['local-password', 'magic-link'],
      authEnabled: false,
      trustedProxies: undefined,
    })).resolves.toBeUndefined();
  });

  it('Round 6: passes for IPv6 loopback ([::1] and bracketed forms)', async () => {
    // node:net hands the bind host to listeners as either `::1` or
    // `[::1]` depending on the path. The isLoopbackHost helper handles
    // both — the previous test set only covered v4 forms, so a
    // regression in v6 bracket-stripping would not be caught.
    await expect(assertHostedDeploymentSafety({
      host: '::1',
      methods: ['github'],
      authEnabled: false,
      trustedProxies: undefined,
    })).resolves.toBeUndefined();

    await expect(assertHostedDeploymentSafety({
      host: '[::1]',
      methods: ['local-password'],
      authEnabled: false,
      trustedProxies: undefined,
    })).resolves.toBeUndefined();
  });

  it('Round 6: passes when methods mix trivial-consent with a multi-user method on loopback', async () => {
    // Mixed mode: operator runs trivial-consent for solo dev plus
    // github for invited collaborators on the same loopback bind.
    // The H2/H4 guard considers any multi-user method present;
    // loopback short-circuits before the multi-user check, so this
    // must pass.
    await expect(assertHostedDeploymentSafety({
      host: '127.0.0.1',
      methods: ['trivial-consent', 'github'],
      authEnabled: false,
      trustedProxies: undefined,
    })).resolves.toBeUndefined();
  });

  it('Round 6: throws when methods mix trivial-consent with a multi-user method on non-loopback', async () => {
    // Same mix, but on 0.0.0.0 — the multi-user method present must
    // still trip the H2/H4 guards. This pins that the OR-style
    // "any multi-user method" check is correctly implemented (rather
    // than e.g. "all methods are multi-user").
    await expect(assertHostedDeploymentSafety({
      host: '0.0.0.0',
      methods: ['trivial-consent', 'github'],
      authEnabled: false,
      trustedProxies: ['loopback'],
    })).rejects.toThrow(/DOLLHOUSE_AUTH_ENABLED is false/);
  });

  it('passes when no multi-user methods are configured (trivial-consent only)', async () => {
    await expect(assertHostedDeploymentSafety({
      host: '0.0.0.0',
      methods: ['trivial-consent'],
      authEnabled: false,
      trustedProxies: undefined,
    })).resolves.toBeUndefined();

    await expect(assertHostedDeploymentSafety({
      host: '0.0.0.0',
      methods: undefined,
      authEnabled: false,
      trustedProxies: undefined,
    })).resolves.toBeUndefined();
  });

  it('H2: throws when non-loopback bind + multi-user method + auth disabled', async () => {
    await expect(assertHostedDeploymentSafety({
      host: '0.0.0.0',
      methods: ['github'],
      authEnabled: false,
      trustedProxies: ['loopback'], // doesn't matter; H2 fires first
    })).rejects.toThrow(/DOLLHOUSE_AUTH_ENABLED is false/);
  });

  it('H2: error message names the configured method so operators see what to fix', async () => {
    await expect(assertHostedDeploymentSafety({
      host: 'mcp.example.com',
      methods: ['local-password', 'magic-link'],
      authEnabled: false,
      trustedProxies: undefined,
    })).rejects.toThrow(/local-password,magic-link/);
  });

  it('H4: throws when non-loopback bind + multi-user method + auth enabled + no trusted proxies', async () => {
    await expect(assertHostedDeploymentSafety({
      host: '0.0.0.0',
      methods: ['github'],
      authEnabled: true,
      trustedProxies: undefined,
    })).rejects.toThrow(/DOLLHOUSE_TRUSTED_PROXIES is unset/);
  });

  it('H4: passes when non-loopback bind + multi-user + auth enabled + trusted proxies set', async () => {
    await expect(assertHostedDeploymentSafety({
      host: '0.0.0.0',
      methods: ['github'],
      authEnabled: true,
      trustedProxies: ['loopback'],
    })).resolves.toBeUndefined();

    await expect(assertHostedDeploymentSafety({
      host: 'mcp.example.com',
      methods: ['local-password'],
      authEnabled: true,
      trustedProxies: ['10.0.0.0/8', '172.16.0.0/12'],
    })).resolves.toBeUndefined();
  });

  it('empty trusted-proxies array is treated as unset', async () => {
    // Defensive: an explicitly-empty list shouldn't accidentally pass
    // the H4 guard since the operator clearly didn't configure
    // trusted upstream proxies. Only loopback or a real CIDR list passes.
    await expect(assertHostedDeploymentSafety({
      host: '0.0.0.0',
      methods: ['github'],
      authEnabled: true,
      trustedProxies: [],
    })).rejects.toThrow(/DOLLHOUSE_TRUSTED_PROXIES is unset/);
  });
});
