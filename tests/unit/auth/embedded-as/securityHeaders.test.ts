/**
 * securityHeaders middleware — must-fix #7 + Phase 7 hardening.
 *
 * Pins the headers every embedded-AS response should carry:
 *   - restrictive CSP with style nonces
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
import {
  allowCspFormActionOrigin,
  securityHeaders,
} from '../../../../src/auth/embedded-as/securityHeaders.js';

const STYLE_SRC_NONCE_PATTERN = /style-src 'self' 'nonce-([^']+)'/;

function extractStyleNonce(csp: string): string {
  const match = STYLE_SRC_NONCE_PATTERN.exec(csp);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

async function bootApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders());
  app.get('/x', (_req, res) => {
    res.type('html').send('<!doctype html><html><head><style>body{color:#181816}</style></head><body>ok</body></html>');
  });
  app.get('/oauth-consent', (_req, res) => {
    allowCspFormActionOrigin(res, 'https://claude.ai');
    res.type('html').send('<!doctype html><html><head><style>body{color:#181816}</style></head><body>ok</body></html>');
  });
  app.get('/invalid-form-action', (_req, res) => {
    allowCspFormActionOrigin(res, 'javascript:alert(1)');
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
  it('sets hardening headers on responses', async () => {
    const { url, close } = await bootApp();
    try {
      const resp = await fetch(`${url}/x`);
      expect(resp.status).toBe(200);
      const csp = resp.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("img-src 'self' data:");
      expect(csp).toContain("font-src 'self'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("script-src 'none'");
      expect(csp).toContain("style-src 'self' 'nonce-");
      expect(csp).not.toContain("'unsafe-inline'");
      expect(resp.headers.get('x-frame-options')).toBe('DENY');
      expect(resp.headers.get('cache-control')).toBe('no-store');
      expect(resp.headers.get('referrer-policy')).toBe('no-referrer');
    } finally {
      await close();
    }
  });

  it('adds the CSP style nonce to rendered inline styles', async () => {
    const { url, close } = await bootApp();
    try {
      const resp = await fetch(`${url}/x`);
      const csp = resp.headers.get('content-security-policy') ?? '';
      const nonce = extractStyleNonce(csp);
      const body = await resp.text();
      expect(body).toContain(`<style nonce="${nonce}">body{color:#181816}</style>`);
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

  it('can allow the active OAuth callback origin for consent form redirects', async () => {
    const { url, close } = await bootApp();
    try {
      const resp = await fetch(`${url}/oauth-consent`);
      const csp = resp.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("form-action 'self' https://claude.ai");
    } finally {
      await close();
    }
  });

  it('ignores non-HTTP form-action origins', async () => {
    const { url, close } = await bootApp();
    try {
      const resp = await fetch(`${url}/invalid-form-action`);
      const csp = resp.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toContain('javascript:');
    } finally {
      await close();
    }
  });
});
