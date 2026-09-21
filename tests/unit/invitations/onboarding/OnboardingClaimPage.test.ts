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
interface Reply { status: number; body: unknown; bodyError?: Error }
async function browser(fragment = `#token=${token}`, reply?: (path: string) => Reply | Promise<Reply>, withoutSize = false, setup?: (window: JSDOM['window']) => void) {
  const html = (await request(app()).get(path)).text;
  const calls: Call[] = [];
  dom = new JSDOM(html, { url: `https://console.example.test${path}${fragment}`, runScripts: 'dangerously', beforeParse(window) {
    setup?.(window);
    if (withoutSize) Object.defineProperty(window.URLSearchParams.prototype, 'size', { value: undefined });
    window.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ path: url, body: init.body as string | undefined, headers: init.headers as Record<string, string>, hash: window.location.hash });
      const result: Reply = reply ? await reply(url) : { status: 200, body: url.endsWith('/context') ? metadata :
        { state: url.endsWith('/exchange') ? 'claimed' : 'ready', csrfToken: url.endsWith('/exchange') ? 'new-csrf' : 'csrf' } };
      return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => { if (result.bodyError) throw result.bodyError; return result.body; } } as Response;
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
  expect(b.button('claim-github').disabled).toBe(false);
  expect(b.calls.some(call => call.path.endsWith('/github/start'))).toBe(false);
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

it.each(['bootstrap', 'exchange'])('treats rejected %s transport as temporary and retries without automatic credential replay', async failedPath => {
  let failed = false;
  const b = await browser(`#token=${token}`, url => {
    if (url.endsWith('/' + failedPath) && !failed) { failed = true; throw new TypeError('Network secret ' + token); }
    return { status: 200, body: url.endsWith('/context') ? metadata :
      { state: url.endsWith('/exchange') ? 'claimed' : 'ready', csrfToken: 'csrf' } };
  });
  if (failedPath === 'exchange') b.button('claim-continue').click();
  await until(() => !b.button('claim-retry').hidden);
  expect(b.document.getElementById('claim-status')!.textContent).toContain('Temporarily unavailable');
  expect(b.document.body.textContent).not.toContain('Network secret');
  expect(b.document.body.textContent).not.toContain(token);
  const exchanges = b.calls.filter(call => call.path.endsWith('/exchange')).length;
  b.button('claim-retry').click();
  await until(() => !b.button('claim-continue').disabled);
  expect(b.calls.filter(call => call.path.endsWith('/exchange'))).toHaveLength(exchanges);
  b.button('claim-continue').click();
  await until(() => !b.document.getElementById('claim-details')!.hidden);
  expect(b.calls.filter(call => call.path.endsWith('/exchange'))).toHaveLength(exchanges + 1);
});

it.each(['bootstrap', 'exchange', 'context'])('treats interrupted %s response bodies as temporary without replaying an exchange', async failedPath => {
  let failed = false, exchanged = false;
  const b = await browser(`#token=${token}`, url => {
    if (url.endsWith('/exchange')) exchanged = true;
    const result: Reply = { status: 200, body: url.endsWith('/context') ? metadata :
      { state: exchanged ? 'claimed' : 'ready', csrfToken: 'csrf' } };
    if (url.endsWith('/' + failedPath) && !failed) {
      failed = true; result.bodyError = new TypeError('Body secret ' + token);
    }
    return result;
  });
  if (failedPath !== 'bootstrap') b.button('claim-continue').click();
  await until(() => !b.button('claim-retry').hidden);
  expect(b.document.getElementById('claim-status')!.textContent).toContain('Temporarily unavailable');
  expect(b.document.body.textContent).not.toContain('Body secret'); expect(b.document.body.textContent).not.toContain(token);
  const exchanges = b.calls.filter(call => call.path.endsWith('/exchange')).length;
  b.button('claim-retry').click();
  await until(() => !b.button('claim-continue').disabled || !b.document.getElementById('claim-details')!.hidden);
  expect(b.calls.filter(call => call.path.endsWith('/exchange'))).toHaveLength(exchanges);
  if (failedPath !== 'context') {
    b.button('claim-continue').click();
    await until(() => !b.document.getElementById('claim-details')!.hidden);
    expect(b.calls.filter(call => call.path.endsWith('/exchange'))).toHaveLength(exchanges + 1);
  }
});

it('keeps malformed JSON neutral without exposing parser details or automatically retrying', async () => {
  const b = await browser(`#token=${token}`, () => ({ status: 200, body: null, bodyError: new SyntaxError('JSON secret ' + token) }));
  expect(b.document.getElementById('claim-status')!.textContent).toContain('Unable to continue');
  expect(b.document.body.textContent).not.toContain('JSON secret'); expect(b.document.body.textContent).not.toContain(token);
  expect(b.calls).toHaveLength(1); expect(b.calls[0].path).toBe('/auth/onboarding/bootstrap');
});

it('accepts only a single token entry when URLSearchParams.size is unavailable', async () => {
  const valid = await browser(`#token=${token}`, undefined, true);
  expect(valid.button('claim-continue').disabled).toBe(false);
  expect(valid.window.location.hash).toBe(''); valid.window.close();
  for (const fragment of [`#token=${token}&token=${token}`, `#token=${token}&extra=value`]) {
    const invalid = await browser(fragment, undefined, true);
    expect(invalid.button('claim-continue').disabled).toBe(true);
    expect(invalid.window.location.hash).toBe(''); invalid.window.close();
  }
});

it.each([['empty', '#'], ['empty token', '#token='], ['oversized', '#token=' + 'x'.repeat(2048)],
  ['duplicate', `#token=${token}&token=${token}`], ['extra parameter', `#token=${token}&extra=value`]])(
  'does not substitute existing claimed metadata for an invalid %s fragment', async (_label, fragment) => {
    const b = await browser(fragment, url => ({ status: 200, body: url.endsWith('/context') ? metadata : { state: 'claimed', csrfToken: 'csrf' } }));
    expect(b.calls.map(call => call.path)).toEqual(['/auth/onboarding/bootstrap']);
    expect(b.document.getElementById('claim-details')!.hidden).toBe(true);
    expect(b.document.body.textContent).not.toContain(metadata.account.verifiedEmail);
    expect(b.button('claim-continue').disabled).toBe(true); expect(b.window.location.hash).toBe('');
  });

it.each([['missing', undefined], ['oversized', 'x'.repeat(161)]])('recovers metadata after a successful exchange with %s CSRF without replay', async (_label, csrfToken) => {
  let exchanged = false;
  const b = await browser(`#token=${token}`, url => {
    if (url.endsWith('/exchange')) { exchanged = true; return { status: 200, body: { state: 'claimed', csrfToken } }; }
    return { status: 200, body: url.endsWith('/context') ? metadata : { state: exchanged ? 'claimed' : 'ready', csrfToken: 'fresh-csrf' } };
  });
  b.button('claim-continue').click(); await until(() => !b.button('claim-retry').hidden);
  expect(b.calls.filter(call => call.path.endsWith('/exchange'))).toHaveLength(1);
  b.button('claim-retry').click(); await until(() => !b.document.getElementById('claim-details')!.hidden);
  expect(b.calls.filter(call => call.path.endsWith('/exchange'))).toHaveLength(1);
  expect(b.document.getElementById('claim-email')!.textContent).toBe(metadata.account.verifiedEmail);
});


it('starts GitHub only on explicit click with rotated CSRF and does not retry a failed start automatically', async () => {
  let finish: ((value: { status: number; body: unknown }) => void) | undefined;
  const pending = new Promise<{ status: number; body: unknown }>(resolve => { finish = resolve; });
  const b = await browser(`#token=${token}`, url => url.endsWith('/github/start') ? pending :
    { status: 200, body: url.endsWith('/context') ? metadata : { state: url.endsWith('/bootstrap') ? 'ready' : 'claimed', csrfToken: 'rotated-csrf' } });
  expect(b.button('claim-github').disabled).toBe(true);
  b.button('claim-continue').click(); await until(() => !b.button('claim-github').disabled);
  b.button('claim-github').click(); b.button('claim-github').click();
  expect(b.calls.filter(call => call.path.endsWith('/github/start'))).toHaveLength(1);
  expect(b.calls.at(-1)).toMatchObject({ path: '/auth/onboarding/github/start', body: '{}', headers: { 'X-Onboarding-CSRF': 'rotated-csrf' } });
  expect(b.button('claim-github').disabled).toBe(true);
  finish!({ status: 503, body: { error: token } }); await until(() => !b.button('claim-retry').hidden);
  expect(b.document.body.textContent).not.toContain(token); expect(b.document.body.textContent).not.toContain('rene@example.test');
  expect(b.button('claim-github').disabled).toBe(true);
  b.button('claim-retry').click(); await until(() => b.calls.filter(call => call.path.endsWith('/bootstrap')).length === 2);
  expect(b.calls.filter(call => call.path.endsWith('/github/start'))).toHaveLength(1);
  expect(b.calls.filter(call => call.path.endsWith('/exchange'))).toHaveLength(1);
});

it.each(['https://attacker.example/login/oauth/authorize', 'http://github.com/login/oauth/authorize',
  'https://github.com/elsewhere', 'https://name:password@github.com/login/oauth/authorize',
  'https://github.com/login/oauth/authorize#secret', 'javascript:alert(1)'])('rejects an unsafe authorization destination', async authorizationUrl => {
  const b = await browser('', url => ({ status: 200, body: url.endsWith('/context') ? metadata :
    url.endsWith('/github/start') ? { authorizationUrl, expiresAt: '2026-10-01T12:05:00Z' } : { state: 'claimed', csrfToken: 'csrf' } }));
  await until(() => !b.button('claim-github').disabled); b.button('claim-github').click();
  await until(() => !b.button('claim-retry').hidden);
  expect(b.window.location.href).toBe(`https://console.example.test${path}`);
  expect(b.document.body.textContent).not.toContain(authorizationUrl);
  expect(b.document.getElementById('claim-details')!.hidden).toBe(true);
});

it('ignores a GitHub start response after pagehide', async () => {
  let finish: ((value: { status: number; body: unknown }) => void) | undefined;
  const pending = new Promise<{ status: number; body: unknown }>(resolve => { finish = resolve; });
  const b = await browser('', url => url.endsWith('/github/start') ? pending :
    { status: 200, body: url.endsWith('/context') ? metadata : { state: 'claimed', csrfToken: 'csrf' } });
  await until(() => !b.button('claim-github').disabled); b.button('claim-github').click();
  b.window.dispatchEvent(new b.window.PageTransitionEvent('pagehide'));
  finish!({ status: 200, body: { authorizationUrl: 'https://github.com/login/oauth/authorize?state=secret', expiresAt: '2026-10-01T12:05:00Z' } });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(b.window.location.href).toBe(`https://console.example.test${path}`);
  expect(b.document.getElementById('claim-details')!.hidden).toBe(true);
  expect(b.button('claim-github').disabled).toBe(true);
});


it.each([
  ['OAuth state', 5 * 60000 + 1, '2026-10-01T12:05:00Z'],
  ['claim with a suspended timer', 15 * 60000 + 1, '2026-10-01T12:20:00Z'],
])('rejects a delayed GitHub response after %s expiry using server-adjusted monotonic time', async (_label, elapsed, expiresAt) => {
  let now = 0;
  let finish!: (value: Reply) => void;
  const pending = new Promise<Reply>(resolve => { finish = resolve; });
  const b = await browser('', url => url.endsWith('/github/start') ? pending :
    { status: 200, body: url.endsWith('/context') ? metadata : { state: 'claimed', csrfToken: 'csrf' } }, false,
  window => { Object.defineProperty(window.performance, 'now', { value: () => now }); });
  await until(() => !b.button('claim-github').disabled); b.button('claim-github').click();
  now = Number(elapsed);
  finish({ status: 200, body: { authorizationUrl: 'https://github.com/login/oauth/authorize?state=secret', expiresAt } });
  await until(() => !b.button('claim-retry').hidden);
  expect(b.document.getElementById('claim-status')!.textContent).toContain('Unable to continue');
  expect(b.window.location.href).toBe(`https://console.example.test${path}`);
  expect(b.document.getElementById('claim-details')!.hidden).toBe(true);
  expect(b.button('claim-github').disabled).toBe(true);
  expect(b.document.body.textContent).not.toContain('rene@example.test');
  b.button('claim-retry').click(); await until(() => b.calls.filter(call => call.path.endsWith('/bootstrap')).length === 2);
  expect(b.calls.filter(call => call.path.endsWith('/github/start'))).toHaveLength(1);
});

it('rejects a late start after the claim expiry timer clears the session', async () => {
  let expire!: () => void;
  let finish!: (value: Reply) => void;
  const pending = new Promise<Reply>(resolve => { finish = resolve; });
  const b = await browser('', url => url.endsWith('/github/start') ? pending :
    { status: 200, body: url.endsWith('/context') ? metadata : { state: 'claimed', csrfToken: 'csrf' } }, false,
  window => { window.setTimeout = ((callback: () => void) => { expire = callback; return 1; }) as typeof window.setTimeout; });
  await until(() => !b.button('claim-github').disabled); b.button('claim-github').click(); expire();
  expect(b.document.getElementById('claim-status')!.textContent).toContain('no longer available');
  finish({ status: 200, body: { authorizationUrl: 'https://github.com/login/oauth/authorize?state=secret', expiresAt: '2026-10-01T12:05:00Z' } });
  await until(() => !b.button('claim-retry').hidden);
  expect(b.document.getElementById('claim-status')!.textContent).toContain('Unable to continue');
  expect(b.window.location.href).toBe(`https://console.example.test${path}`);
  expect(b.document.getElementById('claim-details')!.hidden).toBe(true);
  expect(b.button('claim-github').disabled).toBe(true);
});
