/**
 * Cycle-8 fix (H1): rate-limit IP attribution must respect Express's
 * trust-proxy chain rather than reading X-Forwarded-For directly.
 *
 * The earlier shape always trusted the first hop in the X-Forwarded-For
 * header. An attacker connecting directly to a non-loopback bind could
 * spoof their identity by setting `X-Forwarded-For: 1.2.3.4` to defeat
 * per-IP rate limiting. The fix delegates to `req.ip`, which Express
 * resolves through the configured `app.set('trust proxy', ...)` chain:
 *
 *   - Native HTTPS / no upstream proxy: `req.ip` is the TCP peer.
 *   - Behind a trusted reverse proxy: `req.ip` is the resolved
 *     downstream client per the trust-proxy CIDR list.
 *
 * These tests pin the function's behavior given the same `req` shape
 * Express would hand it after trust-proxy resolution. Express's
 * resolution itself is its own well-tested concern.
 */

import { describe, it, expect } from '@jest/globals';
import type { Request } from 'express';
import { getClientKey } from '../../../src/server/StreamableHttpServer.js';

function makeReq(opts: {
  ip?: string;
  forwardedFor?: string;
  socketAddr?: string;
}): Request {
  const headers: Record<string, string | string[] | undefined> = {};
  if (opts.forwardedFor !== undefined) headers['x-forwarded-for'] = opts.forwardedFor;
  return {
    headers,
    ip: opts.ip,
    socket: { remoteAddress: opts.socketAddr },
  } as unknown as Request;
}

describe('getClientKey', () => {
  it('returns req.ip when set (Express has already resolved trust-proxy)', () => {
    expect(getClientKey(makeReq({ ip: '203.0.113.5' }))).toBe('203.0.113.5');
  });

  it('IGNORES X-Forwarded-For header when req.ip is set (no double-resolution)', () => {
    // The bug being fixed: previously this returned '1.2.3.4' (the
    // attacker-supplied value) even when Express had resolved
    // req.ip='10.0.0.1' from a trusted proxy. The header is the
    // attacker-chosen part; req.ip is Express's authoritative answer.
    expect(getClientKey(makeReq({
      ip: '10.0.0.1',
      forwardedFor: '1.2.3.4',
    }))).toBe('10.0.0.1');
  });

  it('IGNORES X-Forwarded-For header even with a long chain (cannot be spoofed past trust-proxy)', () => {
    expect(getClientKey(makeReq({
      ip: '10.0.0.1',
      forwardedFor: '1.2.3.4, 5.6.7.8, 9.10.11.12',
    }))).toBe('10.0.0.1');
  });

  it('falls back to socket.remoteAddress when req.ip is undefined', () => {
    // Should not happen in practice — Express always sets req.ip —
    // but the helper still has to produce a non-throwing answer.
    expect(getClientKey(makeReq({ socketAddr: '127.0.0.1' }))).toBe('127.0.0.1');
  });

  it('returns "unknown" when neither req.ip nor socket is available', () => {
    expect(getClientKey(makeReq({}))).toBe('unknown');
  });

  it('regression: an unauthenticated attacker cannot spoof identity via header alone', () => {
    // Native-HTTPS deployment scenario: no trust proxy configured.
    // Express sets req.ip to the TCP peer; if an attacker sends
    // X-Forwarded-For, Express ignores it (because trust proxy is
    // 'loopback' and the connection is not from loopback) and
    // req.ip stays as the real peer. getClientKey must follow.
    const tcpPeer = '198.51.100.99';
    const spoofed = '127.0.0.1'; // attacker tries to claim loopback-rate-limit identity
    expect(getClientKey(makeReq({
      ip: tcpPeer,
      forwardedFor: spoofed,
    }))).toBe(tcpPeer);
  });

  // Cycle-11 fix (H11-2): on dual-stack Node, IPv4 connections show
  // up as `::ffff:1.2.3.4` rather than `1.2.3.4`. Without normalization,
  // an attacker alternating address families gets 2× the per-IP
  // rate-limit budget. Same fix shape as cycle-10 H10-2 in MagicLink
  // — both now use the shared `normalizeIp` helper from rateLimit.ts.
  it('H11-2: normalizes IPv4-mapped IPv6 (::ffff:1.2.3.4 → 1.2.3.4)', () => {
    expect(getClientKey(makeReq({ ip: '::ffff:203.0.113.5' }))).toBe('203.0.113.5');
  });

  it('H11-2: pure IPv4 passes through unchanged', () => {
    expect(getClientKey(makeReq({ ip: '203.0.113.5' }))).toBe('203.0.113.5');
  });

  it('H11-2: regression — same v4 attacker cannot get two buckets via dual-stack', () => {
    // Pin the bypass class: 1.2.3.4 and ::ffff:1.2.3.4 must hash to
    // the same rate-limit key. Before the fix, an attacker on a
    // dual-stack bind alternating address families got 2× budget.
    const v4 = getClientKey(makeReq({ ip: '203.0.113.42' }));
    const v6Mapped = getClientKey(makeReq({ ip: '::ffff:203.0.113.42' }));
    expect(v4).toBe(v6Mapped);
  });

  it('H11-2: pure IPv6 (not v4-mapped) passes through unchanged', () => {
    // A genuine IPv6 client address (not a v4-mapped form) shouldn't
    // be modified.
    expect(getClientKey(makeReq({ ip: '2001:db8::1' }))).toBe('2001:db8::1');
  });
});
