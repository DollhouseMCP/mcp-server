/**
 * securityHeaders middleware — must-fix #7 + Phase 7 hardening.
 *
 * Pins the four headers every embedded-AS response should carry:
 *   - CSP frame-ancestors 'none'
 *   - X-Frame-Options: DENY
 *   - Cache-Control: no-store
 *   - Referrer-Policy: no-referrer
 *
 * Without these regression tests, a misconfigured router order or a
 * later middleware that overwrites response headers could silently
 * regress all four. The previous implementation only set the first two
 * and was untested.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { securityHeaders } from '../../../../src/auth/embedded-as/securityHeaders.js';

async function bootApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders());
  app.get('/x', (_req, res) => {
    res.type('html').send('<!doctype html><html><body>ok</body></html>');
  });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
    server.once('error', reject);
  });
}

describe('securityHeaders middleware', () => {
  it('sets all four hardening headers on responses', async () => {
    const { url, close } = await bootApp();
    try {
      const resp = await fetch(`${url}/x`);
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(resp.headers.get('x-frame-options')).toBe('DENY');
      expect(resp.headers.get('cache-control')).toBe('no-store');
      expect(resp.headers.get('referrer-policy')).toBe('no-referrer');
    } finally {
      await close();
    }
  });

  it('also sets Pragma: no-cache for HTTP/1.0 proxies', async () => {
    const { url, close } = await bootApp();
    try {
      const resp = await fetch(`${url}/x`);
      expect(resp.headers.get('pragma')).toBe('no-cache');
    } finally {
      await close();
    }
  });
});

