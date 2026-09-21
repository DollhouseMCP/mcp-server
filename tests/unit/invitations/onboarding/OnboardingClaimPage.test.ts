import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { JSDOM } from 'jsdom';
import { securityHeaders } from '../../../../src/auth/embedded-as/securityHeaders.js';
import { createOnboardingClaimPageRouter } from '../../../../src/invitations/onboarding/OnboardingClaimPage.js';
import { generateInvitationToken } from '../../../../src/invitations/InvitationToken.js';

const path = '/auth/onboarding/invitation';
const token = generateInvitationToken(randomUUID(), 1).token;
const metadata = { state: 'claimed', account: { username: 'renée', displayName: '<img src=x onerror=alert(1)>Renée', verifiedEmail: 'rene@example.test' },
  intendedRoles: ['operator'], invitationExpiresAt: '2026-10-01T13:00:00Z', sessionExpiresAt: '2026-10-01T12:15:00Z',
  serverTime: '2026-10-01T12:00:00Z', emailVerifiedAt: '2026-10-01T11:59:00Z' };
const app = () => express().use(securityHeaders()).use(createOnboardingClaimPageRouter('Help?/#&@Example.test'))
  .get('/auth/onboarding/status', (_req, res) => res.json({ state: 'unavailable' }));
let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); });
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  expect(predicate()).toBe(true);
}
interface Call { path: string; body?: string; headers: Record<string, string>; hash: string }
async function browser(fragment = `#token=${token}`, reply?: (path: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>) {
  const html = (await request(app()).get(path)).text;
  const calls: Call[] = [];
  dom = new JSDOM(html, { url: `https://console.example.test${path}${fragment}`, runScripts: 'dangerously', beforeParse(window) {
    window.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ path: url, body: init.body as string | undefined, headers: init.headers as Record<string, string>, hash: window.location.hash });
      const result = reply ? await reply(url) : { status: 200, body: url.endsWith('/context') ? metadata :
        { state: url.endsWith('/exchange') ? 'claimed' : 'ready', csrfToken: url.endsWith('/exchange') ? 'new-csrf' : 'csrf' } };
      return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body } as Response;
    }) as typeof fetch;
  } });
  const document = dom.window.document;
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
  await until(() => !document.getElementById('claim-status')!.textContent!.includes('Preparing'));
  return { calls, document, button, window: dom.window };
}

it('uses a route-only nonce policy under the actual parent wrapper while API responses remain script-none', async () => {
  const first = await request(app()).get(path); const second = await request(app()).get(path);
  expect(first.status).toBe(200); expect(first.headers['cache-control']).toBe('no-store');
  expect(first.headers['referrer-policy']).toBe('no-referrer'); expect(first.headers['x-frame-options']).toBe('DENY');
  const nonce = /script-src 'nonce-([^']+)'/.exec(first.headers['content-security-policy'])![1];
  expect(first.text).toContain(`<script nonce="${nonce}">`); expect(first.text).toContain(`<style nonce="${nonce}">`);
  expect(second.headers['content-security-policy']).not.toBe(first.headers['content-security-policy']);
  expect(first.headers['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect((await request(app()).get('/auth/onboarding/status')).headers['content-security-policy']).toContain("script-src 'none'");
  expect((await request(app()).get(`${path}?token=secret`)).status).toBe(400);
  expect(first.text).toContain('mailto:Help%3F%2F%23%26@example.test');
});

it('clears history before network and consumes a credential only on explicit click, rendering verified metadata as text', async () => {
  const b = await browser();
  expect(b.window.location.hash).toBe(''); expect(b.calls.map(call => call.path)).toEqual(['/auth/onboarding/bootstrap']);
  expect(b.calls.every(call => !call.hash)).toBe(true); expect(b.document.body.textContent).not.toContain('rene@example.test');
  expect(b.button('claim-continue').disabled).toBe(false);
  b.button('claim-continue').click();
  await until(() => !b.document.getElementById('claim-details')!.hidden);
  expect(b.calls.map(call => call.path)).toEqual(['/auth/onboarding/bootstrap', '/auth/onboarding/exchange', '/auth/onboarding/context']);
  expect(JSON.parse(b.calls[1].body!)).toEqual({ credential: token }); expect(b.calls[1].headers['X-Onboarding-CSRF']).toBe('csrf');
  expect(b.document.getElementById('claim-name')!.textContent).toBe(metadata.account.displayName);
  expect(b.document.querySelector('#claim-name img')).toBeNull(); expect(b.document.getElementById('claim-relative')!.textContent).toContain('60 minutes');
  expect(b.document.getElementById('claim-roles')!.textContent).toContain('Operator: Monitor server health');
  expect(b.document.documentElement.outerHTML).not.toContain(token); expect(b.window.localStorage.length).toBe(0); expect(b.window.sessionStorage.length).toBe(0);
  expect(b.document.activeElement?.id).toBe('claim-status'); expect(b.document.getElementById('claim-status')!.getAttribute('aria-live')).toBe('polite');
  expect(b.document.querySelector<HTMLButtonElement>('#claim-details button')!.disabled).toBe(true);
});

it('reloads a proven session without replay and does not silently replace a different fragment with existing session metadata', async () => {
  const b = await browser('', url => ({ status: 200, body: url.endsWith('/context') ? metadata : { state: 'claimed', csrfToken: 'reload-csrf' } }));
  await until(() => b.calls.length === 2);
  expect(b.calls.map(call => call.path)).toEqual(['/auth/onboarding/bootstrap', '/auth/onboarding/context']);
  b.window.close();
  const withFragment = await browser(`#token=${token}`, () => ({ status: 200, body: { state: 'claimed', csrfToken: 'reload-csrf' } }));
  expect(withFragment.calls).toHaveLength(1); expect(withFragment.button('claim-continue').disabled).toBe(false);
  expect(withFragment.document.getElementById('claim-details')!.hidden).toBe(true);
});

it.each([403, 409, 503])('keeps status%d neutral and safe, and retries bootstrap without automatically replaying exchange', async status => {
  const b = await browser(`#token=${token}`, url => url.endsWith('/exchange') ? { status, body: { error: token } } :
    { status: 200, body: { state: 'ready', csrfToken: 'csrf' } });
  b.button('claim-continue').click(); b.button('claim-continue').click();
  await until(() => !b.button('claim-retry').hidden);
  expect(b.calls.filter(call => call.path.endsWith('/exchange'))).toHaveLength(1);
  expect(b.document.body.textContent).not.toContain(token); expect(b.document.getElementById('claim-details')!.hidden).toBe(true);
  b.button('claim-retry').click(); await until(() => b.calls.filter(call => call.path.endsWith('/bootstrap')).length === 2);
  expect(b.calls.filter(call => call.path.endsWith('/exchange'))).toHaveLength(1);
});

it('posts logout with rotated CSRF and clears verified page data', async () => {
  const b = await browser(); b.button('claim-continue').click();
  await until(() => !b.button('claim-logout').hidden);
  b.button('claim-logout').click(); await until(() => b.document.getElementById('claim-status')!.textContent!.includes('signed out'));
  expect(b.calls.at(-1)).toMatchObject({ path: '/auth/onboarding/logout', body: '{}', headers: { 'X-Onboarding-CSRF': 'new-csrf' } });
  expect(b.document.body.textContent).not.toContain('rene@example.test'); expect(b.document.getElementById('claim-details')!.hidden).toBe(true);
});

it('clears credentials and account data on pagehide and ignores a late metadata response', async () => {
  let finish: ((value: { status: number; body: unknown }) => void) | undefined;
  const pending = new Promise<{ status: number; body: unknown }>(resolve => { finish = resolve; });
  const b = await browser(`#token=${token}`, url => url.endsWith('/context') ? pending :
    { status: 200, body: { state: url.endsWith('/exchange') ? 'claimed' : 'ready', csrfToken: 'csrf' } });
  b.button('claim-continue').click(); await until(() => b.calls.some(call => call.path.endsWith('/context')));
  b.window.dispatchEvent(new b.window.PageTransitionEvent('pagehide'));
  finish!({ status: 200, body: metadata }); await new Promise(resolve => setTimeout(resolve, 5));
  expect(b.document.getElementById('claim-details')!.hidden).toBe(true);
  expect(b.document.body.textContent).not.toContain('rene@example.test');
  b.window.dispatchEvent(new b.window.PageTransitionEvent('pageshow', { persisted: true }));
  await until(() => b.calls.filter(call => call.path.endsWith('/bootstrap')).length === 2);
  expect(b.calls.filter(call => call.path.endsWith('/exchange'))).toHaveLength(1);
});
