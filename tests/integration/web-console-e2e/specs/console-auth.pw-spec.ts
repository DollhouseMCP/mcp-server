// Real browser auth lifecycle against the booted e2e app: local-password login
// -> enroll TOTP -> step-up -> step-down -> logout. This exercises the actual
// login / OAuth / step-up CODE that the forged-session HTTP suite deliberately
// skips. Run: npm run test:console-e2e:auth
import { test, expect, type Page } from '@playwright/test';
import { TOTP, Secret } from 'otpauth';

import { SEED_PASSWORD } from '../harness/seed.js';
import { BASE_URL } from '../setup/provision.js';

const USER = 'e2e_admin';
const OPERATE = '/api/v1/admin/operate/health';

async function status(page: Page, path: string): Promise<number> {
  const r = await page.request.get(BASE_URL + path, { maxRedirects: 0, failOnStatusCode: false });
  return r.status();
}

async function csrfPost(page: Page, path: string): Promise<number> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find(c => c.name === 'dh_csrf')?.value ?? '';
  const r = await page.request.post(BASE_URL + path, {
    maxRedirects: 0,
    failOnStatusCode: false,
    headers: { 'x-csrf-token': csrf, 'x-console-request': '1', origin: BASE_URL },
  });
  return r.status();
}

// The AS shows an OAuth client-consent page after authentication; approve it
// when present so the authorization completes and the BFF callback runs.
async function approveClientConsentIfShown(page: Page): Promise<void> {
  const approve = page.locator('button[value="authorize_oauth_client"]');
  if (await approve.count()) {
    await Promise.all([page.waitForLoadState('networkidle'), approve.click()]);
  }
}

async function loginFromConsole(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/ui`, { waitUntil: 'domcontentloaded' });
  await page.locator('#auth-gate-signin').click();
  await page.fill('input[name="username"]', USER);
  await page.fill('input[name="password"]', SEED_PASSWORD);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button[value="login"]')]);
  await approveClientConsentIfShown(page);
  await page.locator('#console-shell').waitFor({ state: 'visible' });
}

test('console UI serves its asset graph and boots from server metadata', async ({ page }) => {
  const assetFailures: string[] = [];
  const loadedPaths = new Set<string>();
  const unavailableRoutes = new Set([
    'DELETE /api/v1/me/security/sessions/:session_id',
    'POST /api/v1/me/security/sessions/revoke-all-others',
    'DELETE /api/v1/me/sessions/:session_id',
    'POST /api/v1/me/sessions/revoke-all',
    'GET /api/v1/me/security/factors/enroll/totp',
  ]);
  await page.route('**/api/v1/me/manifest', async route => {
    const response = await route.fetch();
    const manifest = await response.json() as { routes: Array<{ method: string; path: string }> };
    const routes = manifest.routes.filter(item => !unavailableRoutes.has(`${item.method} ${item.path}`));
    await route.fulfill({ response, json: { ...manifest, routes } });
  });
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/ui/')) assetFailures.push(`${url.pathname}: ${request.failure()?.errorText}`);
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/ui/')) {
      loadedPaths.add(url.pathname);
      if (response.status() >= 400) assetFailures.push(`${url.pathname}: ${response.status()}`);
    }
    if (url.pathname === '/api/v1/me/manifest' || url.pathname === '/api/v1/me/role-catalog') {
      loadedPaths.add(url.pathname);
    }
  });

  await loginFromConsole(page);
  await page.locator('#pf-grid').waitFor({ state: 'visible' });

  await expect(page.locator('.console-tab[data-tab="portfolio"]')).toBeVisible();
  await expect(page.locator('.console-tab[data-tab="sessions"]')).toBeVisible();
  await expect(page.locator('.console-tab[data-tab="permissions"]')).toHaveCount(0);
  await expect(page.locator('.console-tab[data-tab="setup"]')).toHaveCount(0);
  await expect(page.locator('#pf-source')).toBeHidden();
  expect([...loadedPaths]).toContain('/api/v1/me/manifest');
  expect([...loadedPaths]).toContain('/api/v1/me/role-catalog');
  expect([...loadedPaths]).toContain('/ui/app.js');
  expect([...loadedPaths]).toContain('/ui/portfolio.js');
  expect(assetFailures).toEqual([]);

  await page.locator('.console-tab[data-tab="sessions"]').click();
  await expect(page.locator('#sessions-body .session-card').first()).toBeVisible();
  await expect(page.locator('[data-revoke-console], [data-disconnect-mcp], #sess-revoke-others')).toHaveCount(0);

  await page.locator('#site-account').click();
  await page.locator('#account-security').click();
  await expect(page.locator('#security-modal')).toBeVisible();
  await expect(page.locator('#sec-enroll')).toHaveCount(0);
});

test('console auth lifecycle: login -> enroll TOTP -> step-up -> step-down -> logout', async ({ page }) => {
  // 1. LOGIN (local-password)
  await page.goto(`${BASE_URL}/api/v1/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="username"]', USER);
  await page.fill('input[name="password"]', SEED_PASSWORD);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button[value="login"]')]);
  await approveClientConsentIfShown(page);

  expect(await status(page, '/api/v1/auth/me'), 'login establishes a session').toBe(200);

  // 2. SELF works; ADMIN requires step-up (401 step_up_required)
  expect(await status(page, '/api/v1/me/profile')).toBe(200);
  expect(await status(page, OPERATE), 'admin needs elevation before step-up').toBe(401);

  // 3. ENROLL TOTP
  await page.goto(`${BASE_URL}/api/v1/me/security/factors/enroll/totp`, { waitUntil: 'domcontentloaded' });
  const secretText = (await page.locator('code').first().innerText()).trim().replaceAll(/\s+/g, '');
  const totp = new TOTP({ secret: Secret.fromBase32(secretText) });
  await page.fill('input[name="code"]', totp.generate());
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button[type="submit"]')]);

  // 4. STEP-UP for the operate capability (may re-prompt password, then TOTP)
  await page.goto(
    `${BASE_URL}/api/v1/auth/step-up?capability=console:admin:operate&return_to=/api/v1/auth/me`,
    { waitUntil: 'domcontentloaded' },
  );
  if (await page.locator('button[value="login"]').count()) {
    await page.fill('input[name="username"]', USER).catch(() => {});
    await page.fill('input[name="password"]', SEED_PASSWORD).catch(() => {});
    await Promise.all([page.waitForLoadState('networkidle'), page.click('button[value="login"]')]);
  }
  if (await page.locator('input[name="code"]').count()) {
    await page.fill('input[name="code"]', totp.generate());
    await Promise.all([page.waitForLoadState('networkidle'), page.click('button[type="submit"]')]);
  }
  await approveClientConsentIfShown(page);

  // 5. ADMIN now reachable with fresh elevation
  expect(await status(page, OPERATE), 'admin reachable after step-up').toBe(200);

  // The Users surface gets its role list and grants from /me/role-catalog.
  const catalogResponse = await page.request.get(`${BASE_URL}/api/v1/me/role-catalog`);
  const catalog = await catalogResponse.json() as { roles: string[] };
  await page.goto(`${BASE_URL}/ui?tab=users`, { waitUntil: 'domcontentloaded' });
  await page.locator('#console-shell').waitFor({ state: 'visible' });
  await expect(page.locator('.console-tab[data-tab="users"]')).toBeVisible();
  await page.locator('[data-user-row]').first().click();
  await expect(page.locator('[data-role-toggle]')).toHaveCount(catalog.roles.length);

  // 6. STEP-DOWN drops elevation; admin requires step-up again
  const stepDown = await csrfPost(page, '/api/v1/auth/step-down');
  expect(stepDown).toBe(204);
  expect(await status(page, OPERATE), 'admin gated again after step-down').toBe(401);

  // 7. LOGOUT ends the session
  const logout = await csrfPost(page, '/api/v1/auth/logout');
  expect(logout).toBe(204);
  expect(await status(page, '/api/v1/auth/me'), 'session ended after logout').toBe(401);
});
