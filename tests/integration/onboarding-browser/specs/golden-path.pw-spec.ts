/* global document, caches, indexedDB */
import { expect, request, test, type Page } from '@playwright/test';
import { ONBOARDING_OWNER_COOKIE, ONBOARDING_SESSION_COOKIE } from '../../../../dist/invitations/onboarding/OnboardingBrowserPolicy.js';

test('activates an invitation through explicit browser and GitHub consent across replicas', async ({ page }) => {
  const origin = required('ONBOARDING_BROWSER_ORIGIN');
  const replica = required('ONBOARDING_BROWSER_REPLICA_A');
  const control = required('ONBOARDING_BROWSER_CONTROL_SECRET');
  const oauthCode = required('ONBOARDING_BROWSER_OAUTH_CODE');
  const controlHeaders = { 'X-Fixture-Control': control, 'Content-Type': 'application/json' };
  const issuedResponse = await fetch(`${replica}/__fixture/issue`, { method: 'POST', headers: controlHeaders, body: '{}' });
  expect(issuedResponse.status).toBe(201);
  const issued = await issuedResponse.json() as { claim_url: string; invitation: { id: string; user_id: string } };
  const credential = new URLSearchParams(new URL(issued.claim_url).hash.slice(1)).get('token');
  expect(credential).toBeTruthy();

  const requestPaths: string[] = [];
  const credentialObservations: Array<Promise<{ path: string; url: boolean; headers: boolean; body: boolean; exactExchange: boolean }>> = [];
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  let exchangeRequests = 0;
  // Observe real browser requests without intercepting bootstrap or supplying
  // security headers; the browser must construct Origin and Referer itself.
  const mutationHeaders: Array<Promise<{ origin: string | undefined; referrer: string | undefined }>> = [];
  page.on('request', browserRequest => {
    const path = new URL(browserRequest.url()).pathname;
    const data = browserRequest.postData() ?? '';
    requestPaths.push(path);
    if (path === '/auth/onboarding/bootstrap') expect(new URL(page.url()).hash).toBe('');
    if (browserRequest.method() === 'POST' && path.startsWith('/auth/onboarding/')) {
      mutationHeaders.push(browserRequest.allHeaders().then(headers => ({ origin: headers.origin, referrer: headers.referer })));
    }
    if (path === '/auth/onboarding/exchange') exchangeRequests++;
    credentialObservations.push(browserRequest.allHeaders().then(headers => ({ path,
      url: browserRequest.url().includes(credential!), headers: JSON.stringify(headers).includes(credential!),
      body: data.includes(credential!), exactExchange: path === '/auth/onboarding/exchange' && exactCredentialBody(data, credential!),
    })));
  });
  const claimPage = await page.goto(issued.claim_url);
  const claimCsp = claimPage?.headers()['content-security-policy'] ?? '';
  expect(claimCsp).toContain("script-src 'nonce-");
  expect(claimCsp).not.toMatch(/unsafe-inline|unsafe-eval/);
  await expect(page.locator('#claim-status')).toContainText('Continue to verify');
  expect(pageErrors).toEqual([]);
  expect(exchangeRequests).toBe(0);
  expect(await Promise.all(mutationHeaders)).toEqual([{ origin, referrer: undefined }]);
  expect(page.url()).toBe(`${origin}/auth/onboarding/invitation`);
  await expectCredentialAbsentFromBrowser(page, credential!);

  await page.locator('#claim-continue').click();
  await expect(page.locator('#claim-details')).toBeVisible();
  await expect(page.locator('#claim-name')).toHaveText('Browser Invitee');
  await expect(page.locator('#claim-roles')).toContainText('Operator');
  expect(exchangeRequests).toBe(1);
  await expectCredentialAbsentFromBrowser(page, credential!);

  let callbackUrl = '';
  await page.route('https://github.com/login/oauth/authorize**', async route => {
    const authorizationUrl = route.request().url();
    const authorization = new URL(authorizationUrl);
    const state = authorization.searchParams.get('state');
    expect(state).toBeTruthy();
    callbackUrl = `${origin}/auth/onboarding/github/callback?state=${encodeURIComponent(state!)}&code=${encodeURIComponent(oauthCode)}&iss=${encodeURIComponent('https://github.com/login/oauth')}`;
    const recorded = await fetch(`${replica}/__fixture/authorization`, { method: 'POST', headers: controlHeaders,
      body: JSON.stringify({ url: authorizationUrl }) });
    expect(recorded.status).toBe(204);
    await route.fulfill({ status: 200, contentType: 'text/html', body:
      `<!doctype html><html lang="en"><title>GitHub consent</title><body><h1>Authorize DollhouseMCP</h1><a id="authorize" href="${escapeHtml(callbackUrl)}">Authorize</a></body></html>` });
  });
  expect(requestPaths.includes('/auth/onboarding/github/start')).toBe(false);
  await page.locator('#claim-github').click();
  await expect(page.locator('#authorize')).toBeVisible();
  expect(page.url()).toContain('https://github.com/login/oauth/authorize');
  expect(await Promise.all(mutationHeaders)).toEqual(Array.from({ length: 3 }, () => ({ origin, referrer: undefined })));
  const replayCookies = (await page.context().cookies(origin))
    .filter(cookie => [ONBOARDING_OWNER_COOKIE, ONBOARDING_SESSION_COOKIE].includes(cookie.name));
  const byName = (left: string, right: string) => left.localeCompare(right);
  expect(replayCookies.map(cookie => cookie.name).sort(byName))
    .toEqual([ONBOARDING_OWNER_COOKIE, ONBOARDING_SESSION_COOKIE].sort(byName));
  const replayCookieHeader = replayCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  await page.locator('#authorize').click();
  await page.waitForURL(`${origin}/api/v1/auth/login?return_to=%2Fui`);
  await expect(page.locator('h1')).toHaveText('Account activated');
  await expectCredentialAbsentFromBrowser(page, credential!);
  const observations = (await Promise.all(credentialObservations)).filter(value => value.url || value.headers || value.body);
  expect(observations).toEqual([{ path: '/auth/onboarding/exchange', url: false, headers: false, body: true, exactExchange: true }]);

  const cookies = await page.context().cookies(origin);
  expect(cookies.find(cookie => cookie.name === ONBOARDING_OWNER_COOKIE)).toBeUndefined();
  expect(cookies.find(cookie => cookie.name === ONBOARDING_SESSION_COOKIE)).toBeUndefined();
  const stats = await controlJson(replica, control, '/__fixture/stats');
  expect(stats).toEqual({ providerCalls: 2, deliveryCalls: 1 });

  const resolved = await controlJson(replica, control, '/__fixture/resolve', { invitationId: issued.invitation.id }) as {
    provisioned: { allowed: boolean }; principal: { userId: string; roles: string[] } | null;
    record: { invitation_state: string; invited_user_id: string; activation_state: string; matching_email_users: number };
    unrelatedUserId: string;
  };
  expect(resolved.provisioned).toEqual({ allowed: true });
  expect(resolved.principal).toMatchObject({ userId: issued.invitation.user_id, roles: ['operator'] });
  expect(resolved.record).toMatchObject({ invitation_state: 'accepted', invited_user_id: issued.invitation.user_id,
    activation_state: 'active', matching_email_users: 1 });
  expect(resolved.unrelatedUserId).not.toBe(issued.invitation.user_id);

  const replay = await request.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { Cookie: replayCookieHeader } });
  try {
    expect((await replay.get(`${origin}/__fixture/stats`)).status()).toBe(404);
    expect((await replay.get(`${origin}/auth/onboarding/invitation?unexpected=1`)).status()).toBe(404);
    const response = await replay.get(callbackUrl, { maxRedirects: 0 });
    expect(response.status()).toBe(400);
  } finally { await replay.dispose(); }
  expect(await controlJson(replica, control, '/__fixture/stats')).toEqual({ providerCalls: 2, deliveryCalls: 1 });
});

async function controlJson(replica: string, secret: string, path: string, body?: object): Promise<unknown> {
  const response = await fetch(replica + path, { method: body ? 'POST' : 'GET',
    headers: { 'X-Fixture-Control': secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  expect(response.ok).toBe(true); return response.json();
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function escapeHtml(value: string): string { return value.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!); }
function exactCredentialBody(data: string, credential: string): boolean {
  try { const value = JSON.parse(data) as Record<string, unknown>; return Object.keys(value).length === 1 && value.credential === credential; }
  catch { return false; }
}
async function expectCredentialAbsentFromBrowser(page: Page, credential: string): Promise<void> {
  expect(await page.evaluate(async token => ({ html: document.documentElement.outerHTML.includes(token),
    local: JSON.stringify({ ...localStorage }).includes(token), session: JSON.stringify({ ...sessionStorage }).includes(token),
    cookie: document.cookie.includes(token), cacheCount: (await caches.keys()).length,
    databaseCount: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0 }), credential))
    .toEqual({ html: false, local: false, session: false, cookie: false, cacheCount: 0, databaseCount: 0 });
}
