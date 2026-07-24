// Real browser auth lifecycle against the booted e2e app: local-password login
// -> enroll TOTP -> step-up -> step-down -> logout. This exercises the actual
// login / OAuth / step-up CODE that the forged-session HTTP suite deliberately
// skips. Run: npm run test:console-e2e:auth
import { test, expect, type Page } from '@playwright/test';
import { TOTP, Secret } from 'otpauth';

import { SEED_PASSWORD } from '../harness/seed.js';
import { installPortfolioUiMock } from '../harness/portfolioUiMock.js';
import { installSelfServiceUiMock } from '../harness/selfServiceUiMock.js';
import { installSessionUiMock } from '../harness/sessionUiMock.js';
import { BASE_URL } from '../setup/provision.js';

const USER = 'e2e_admin';
const OPERATE = '/api/v1/admin/operate/health';
const MANIFEST_URL = '**/api/v1/me/manifest';
const CONSOLE_SHELL = '#console-shell';
const SESSIONS_TAB = '.console-tab[data-tab="sessions"]';
const SESSION_DETAIL_HEADER = '#session-detail-header';
const CONFIRM_ACTION = '[data-confirm="1"]';
const ACCOUNT_MENU = '#site-account';
const EDITOR_FEEDBACK = '[data-editor-feedback]';
const EDITOR_CONTENT = '.portfolio-editor [name="content"]';
const THEME_SELECT = '#account-theme-form [name="theme"]';
const BULK_SESSION_ACTION = '#sess-revoke-others';
const AUTH_ME_URL = '**/api/v1/auth/me';
const ADMIN_USER_SESSIONS_URL = '**/api/v1/admin/accounts/users/*/sessions';

async function filterManifestRoutes(page: Page, unavailableRoutes: ReadonlySet<string>): Promise<void> {
  await page.route(MANIFEST_URL, async route => {
    const response = await route.fetch();
    const manifest = await response.json() as { routes: Array<{ method: string; path: string }> };
    const routes = manifest.routes.filter(item => !unavailableRoutes.has(`${item.method} ${item.path}`));
    await route.fulfill({ response, json: { ...manifest, routes } });
  });
}

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
  await page.locator(CONSOLE_SHELL).waitFor({ state: 'visible' });
}

async function stepUpWithTotp(page: Page, totp: TOTP): Promise<void> {
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
}

test('console UI serves its asset graph and boots from server metadata', async ({ page }) => {
  const assetFailures: string[] = [];
  const loadedPaths = new Set<string>();
  const unavailableRoutes = new Set([
    'DELETE /api/v1/me/security/sessions/:session_id',
    'DELETE /api/v1/me/sessions/:session_id',
    'POST /api/v1/me/sessions/revoke-all',
    'GET /api/v1/me/security/factors/enroll/totp',
  ]);
  await filterManifestRoutes(page, unavailableRoutes);
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
  await expect(page.locator(SESSIONS_TAB)).toBeVisible();
  await expect(page.locator('.console-tab[data-tab="permissions"]')).toHaveCount(0);
  await expect(page.locator('.console-tab[data-tab="setup"]')).toHaveCount(0);
  await expect(page.locator('#pf-source')).toBeHidden();
  expect([...loadedPaths]).toContain('/api/v1/me/manifest');
  expect([...loadedPaths]).toContain('/api/v1/me/role-catalog');
  expect([...loadedPaths]).toContain('/ui/app.js');
  expect([...loadedPaths]).toContain('/ui/portfolio.js');
  expect(assetFailures).toEqual([]);

  await page.locator(SESSIONS_TAB).click();
  await expect(page.locator('#sessions-body .session-card').first()).toBeVisible();
  await expect(page.locator('[data-revoke-console], [data-disconnect-mcp]')).toHaveCount(0);
  await expect(page.locator(BULK_SESSION_ACTION)).toHaveText('Sign out other console sessions');

  await page.locator(ACCOUNT_MENU).click();
  await page.locator('#account-security').click();
  await expect(page.locator('#security-modal')).toBeVisible();
  await expect(page.locator('#sec-enroll')).toHaveCount(0);
});

test('portfolio authoring validates drafts, preserves conflicts, and confirms hard deletion', async ({ page }) => {
  const mock = await installPortfolioUiMock(page, { conflictOnFirstPatch: true });
  await loginFromConsole(page);

  await page.locator('#pf-create').click();
  await page.locator('[data-editor-validate]').click();
  await expect(page.locator(EDITOR_FEEDBACK)).toContainText('Name is required');
  await page.locator('.portfolio-editor [name="name"]').fill('browser-created');
  await page.locator('[data-editor-validate]').click();
  await expect(page.locator(EDITOR_FEEDBACK)).toContainText('content is required');
  await page.locator(EDITOR_CONTENT).fill('Created through the browser.');
  await page.locator('[data-editor-validate]').click();
  await expect(page.locator(EDITOR_FEEDBACK)).toContainText('Validation passed');
  await page.locator('.portfolio-editor button[type="submit"]').click();
  await expect(page.locator('[data-name="browser-created"]')).toBeVisible();

  await page.locator('[data-name="alpha-persona"] [data-action="edit"]').click();
  await page.locator(EDITOR_CONTENT).fill('Unsaved browser draft.');
  await page.locator('.portfolio-editor button[type="submit"]').click();
  await expect(page.locator(EDITOR_FEEDBACK)).toContainText('changed after you opened it');
  await expect(page.locator('[data-editor-reload]')).toBeVisible();
  await page.locator('[data-editor-reload]').click();
  await expect(page.locator(EDITOR_CONTENT)).toHaveValue('Latest server content.');
  await page.locator('.portfolio-editor [data-editor-close]').first().click();

  await page.locator('[data-name="alpha-persona"]').click();
  await page.locator('.modal-delete-btn').click();
  await page.locator('#portfolio-confirm [data-confirm="0"]').click();
  expect(mock.deletes).toBe(0);
  await page.locator('[data-name="alpha-persona"]').click();
  await page.locator('.modal-delete-btn').click();
  await page.locator('#portfolio-confirm [data-confirm="1"]').click();
  await expect(page.locator('[data-name="alpha-persona"]')).toHaveCount(0);
  expect(mock.deletes).toBe(1);
});

test('portfolio editor stays blocked when conflict reload omits its ETag', async ({ page }) => {
  await installPortfolioUiMock(page, { conflictOnFirstPatch: true, omitEtagAfterConflict: true });
  await loginFromConsole(page);

  await page.locator('[data-name="alpha-persona"] [data-action="edit"]').click();
  await page.locator(EDITOR_CONTENT).fill('Draft that must not overwrite newer content.');
  await page.locator('.portfolio-editor button[type="submit"]').click();
  await page.locator('[data-editor-reload]').click();

  await expect(page.locator(EDITOR_FEEDBACK)).toContainText('did not include an ETag');
  await expect(page.locator('[data-editor-reload]')).toBeVisible();
  await expect(page.locator(EDITOR_CONTENT)).toHaveValue('Draft that must not overwrite newer content.');
});

test('portfolio sync reports successful and failed terminal jobs', async ({ page }) => {
  const success = await installPortfolioUiMock(page);
  await loginFromConsole(page);
  await page.locator('#pf-sync').click();
  await page.locator('.portfolio-sync button[type="submit"]').click();
  await expect(page.locator('[data-sync-status]')).toContainText('Succeeded', { timeout: 5_000 });
  expect(success.syncReads).toBeGreaterThanOrEqual(2);

  await page.unroute('**/api/v1/me/portfolio**');
  const failed = await installPortfolioUiMock(page, { syncOutcome: 'failed' });
  await page.locator('[data-sync-close]').first().click();
  await page.locator('#pf-sync').click();
  await page.locator('.portfolio-sync button[type="submit"]').click();
  await expect(page.locator('[data-sync-status]')).toContainText('github_sync_failed', { timeout: 5_000 });
  expect(failed.syncReads).toBeGreaterThanOrEqual(2);
});

test('portfolio write controls disappear when the manifest omits write routes', async ({ page }) => {
  await installPortfolioUiMock(page);
  await filterManifestRoutes(page, new Set([
    'POST /api/v1/me/portfolio/sync',
    'GET /api/v1/me/portfolio/sync/:job_id',
    'POST /api/v1/me/portfolio/elements/:type',
    'PATCH /api/v1/me/portfolio/elements/:type/:name',
    'DELETE /api/v1/me/portfolio/elements/:type/:name',
    'POST /api/v1/me/portfolio/elements/:type/:name/validate',
    'POST /api/v1/me/portfolio/elements/:type/:name/render',
  ]));
  await loginFromConsole(page);
  await expect(page.locator('#pf-grid')).toBeVisible();
  await expect(page.locator('#pf-create, #pf-sync, [data-action="edit"]')).toHaveCount(0);
  await page.locator('[data-name="alpha-persona"]').click();
  await expect(page.locator('.modal-edit-btn')).toBeHidden();
  await expect(page.locator('.modal-delete-btn')).toBeHidden();
});

test('profile and allowlisted appearance settings persist without overwriting stale state', async ({ page }) => {
  const mock = await installSelfServiceUiMock(page, { conflictOnFirstSettingsWrite: true });
  await loginFromConsole(page);
  await page.locator(ACCOUNT_MENU).click();
  await page.locator('#account-settings').click();

  await page.locator('#account-profile-form [name="display_name"]').fill('Browser Admin');
  await page.locator('#account-profile-form button[type="submit"]').click();
  await expect(page.locator(ACCOUNT_MENU)).toHaveText('Browser Admin');

  await page.locator(THEME_SELECT).selectOption('light');
  await page.locator('#account-theme-form button[type="submit"]').click();
  await expect(page.locator('[data-theme-feedback]')).toContainText('not saved');
  await expect(page.locator(THEME_SELECT)).toHaveValue('dark');
  await page.locator(THEME_SELECT).selectOption('light');
  await page.locator('#account-theme-form button[type="submit"]').click();
  await expect(page.locator('[data-theme-feedback]')).toContainText('Appearance saved');

  await page.locator('[data-account-close]').last().click();
  await page.reload();
  await page.locator(CONSOLE_SHELL).waitFor({ state: 'visible' });
  await page.locator(ACCOUNT_MENU).click();
  await page.locator('#account-settings').click();
  await expect(page.locator('#account-profile-form [name="display_name"]')).toHaveValue('Browser Admin');
  await expect(page.locator(THEME_SELECT)).toHaveValue('light');
  expect(mock.settingsWrites).toBe(2);
});

test('appearance settings preserve unsupported backend values until explicitly reset', async ({ page }) => {
  const mock = await installSelfServiceUiMock(page, { initialTheme: 'system' });
  await loginFromConsole(page);
  await page.locator(ACCOUNT_MENU).click();
  await page.locator('#account-settings').click();

  const theme = page.locator(THEME_SELECT);
  await expect(theme).toBeDisabled();
  await expect(theme).toHaveValue('__unsupported_saved_theme__');
  await expect(page.locator('[data-theme-feedback]')).toContainText('not supported');
  await expect(page.locator('#account-theme-form button[type="submit"]')).toBeDisabled();
  expect(mock.settingsWrites).toBe(0);

  await page.locator('#account-theme-form [data-theme-reset]').click();
  await expect(theme).toBeEnabled();
  await expect(theme).toHaveValue('light');
  expect(mock.theme).toBeNull();
  expect(mock.settingsWrites).toBe(1);
});

test('owned session workspace handles HITL, snapshots, polling cleanup, and termination acknowledgement', async ({ page }) => {
  const mock = await installSessionUiMock(page);
  await loginFromConsole(page);
  await page.locator(SESSIONS_TAB).click();

  await page.locator('[data-inspect-mcp]').click();
  await expect(page.locator(SESSION_DETAIL_HEADER)).toContainText('Claude Code 1.2.3');
  await expect(page.locator('.session-detail-panel--approvals')).toContainText('install_collection_content');
  await expect(page.locator('.session-detail-panel--logs')).toContainText('request.completed');
  await expect(page.locator('.session-detail-panel--metrics')).toContainText('requests.total');

  const approvals = page.locator('.session-approval');
  const installApproval = approvals.filter({ hasText: 'install_collection_content' });
  await installApproval.locator('[data-approval-action="approve"][data-approval-scope="once"]').click();
  await expect(installApproval).toContainText('approved');

  const deleteApproval = approvals.filter({ hasText: 'delete_element' });
  await deleteApproval.locator('[data-approval-action="deny"]').click();
  await page.locator(CONFIRM_ACTION).click();
  await expect(deleteApproval).toContainText('denied');

  await page.locator('#session-activation-form select[name="type"]').selectOption('skills');
  await page.locator('#session-activation-form input[name="name"]').fill('beta-skill');
  await page.locator('#session-activation-form button[type="submit"]').click();
  await expect(page.locator('.session-detail-panel--activations')).toContainText('beta-skill');

  await page.locator('[data-deactivate-name="beta-skill"]').click();
  await page.locator(CONFIRM_ACTION).click();
  await expect(page.locator('.session-detail-panel--activations')).toContainText('No elements are active for this session.');

  mock.setActivations(['remote-persona']);
  await page.locator('[data-detail-refresh]').click();
  await expect(page.locator('.session-detail-panel--activations')).toContainText('remote-persona');

  await page.locator('[data-execution-id]').click();
  await expect(page.locator('#session-execution-detail')).toContainText('Package validation started.');

  await page.locator('.console-tab[data-tab="portfolio"]').click();
  await page.waitForTimeout(100);
  const readsWhileHidden = mock.approvalReads;
  await page.waitForTimeout(4_500);
  expect(mock.approvalReads, 'session polling stops while another tab is active').toBe(readsWhileHidden);

  await page.locator(SESSIONS_TAB).click();
  await expect(page.locator(SESSION_DETAIL_HEADER)).toContainText('Claude Code 1.2.3');
  await page.locator('[data-session-disconnect]').click();
  await page.locator(CONFIRM_ACTION).click();
  await expect(page.locator(SESSION_DETAIL_HEADER)).toContainText('Session unavailable');
  expect(mock.commandReads).toBeGreaterThanOrEqual(2);
});

test('session termination keeps a failed acknowledgement visible', async ({ page }) => {
  const mock = await installSessionUiMock(page, { commandOutcome: 'failed' });
  await loginFromConsole(page);
  await page.locator(SESSIONS_TAB).click();
  await page.locator('[data-inspect-mcp]').click();

  await page.locator('[data-session-disconnect]').click();
  await page.locator(CONFIRM_ACTION).click();

  await expect(page.locator('.session-command-status')).toContainText('Waiting for the owning replica');
  expect(mock.commandReads).toBe(1);
  await page.locator('.console-tab[data-tab="portfolio"]').click();
  const readsWhileHidden = mock.commandReads;
  await page.waitForTimeout(1_000);
  expect(mock.commandReads, 'termination polling stops while another tab is active').toBe(readsWhileHidden);

  await page.locator(SESSIONS_TAB).click();
  await expect(page.locator('.session-command-status')).toContainText('Disconnect failed (session_disconnect_failed).');
  await expect(page.locator(SESSION_DETAIL_HEADER)).toContainText('Claude Code 1.2.3');
  expect(mock.commandReads).toBeGreaterThanOrEqual(2);
});

test('bulk session termination reports command acknowledgement accurately', async ({ page }) => {
  const mock = await installSessionUiMock(page);
  await loginFromConsole(page);
  await page.locator(SESSIONS_TAB).click();

  await page.locator(BULK_SESSION_ACTION).click();
  await page.locator(CONFIRM_ACTION).click();

  await expect(page.locator('#sessions-command-summary')).toContainText('1 disconnect(s) acknowledged.');
  expect(mock.commandReads).toBeGreaterThanOrEqual(2);
});

test('bulk session termination reports partial failure without claiming full success', async ({ page }) => {
  await installSessionUiMock(page, { bulkRequestFails: true });
  await loginFromConsole(page);
  await page.locator(SESSIONS_TAB).click();

  await page.locator(BULK_SESSION_ACTION).click();
  await page.locator(CONFIRM_ACTION).click();

  await expect(page.locator('#toast-stack .toast--warn')).toContainText(
    'could not disconnect connected apps',
  );
  await expect(page.locator('#sessions-command-summary')).toBeEmpty();
});

test('bulk session termination reports total failure as an error', async ({ page }) => {
  await filterManifestRoutes(page, new Set([
    'POST /api/v1/me/security/sessions/revoke-all-others',
  ]));
  await installSessionUiMock(page, { bulkRequestFails: true });
  await loginFromConsole(page);
  await page.locator(SESSIONS_TAB).click();

  await expect(page.locator(BULK_SESSION_ACTION)).toHaveText('Disconnect all connected apps');
  await page.locator(BULK_SESSION_ACTION).click();
  await page.locator(CONFIRM_ACTION).click();

  await expect(page.locator('#toast-stack .toast--error')).toContainText(
    'Could not disconnect connected apps',
  );
  await expect(page.locator('#sessions-command-summary')).toBeEmpty();
});

test('session detail uses the same neutral state for missing or non-owned sessions', async ({ page }) => {
  await installSessionUiMock(page, { detailUnavailable: true });
  await loginFromConsole(page);
  await page.locator(SESSIONS_TAB).click();
  await page.locator('[data-inspect-mcp]').click();

  await expect(page.locator(SESSION_DETAIL_HEADER)).toContainText('Session unavailable');
  await expect(page.locator(SESSION_DETAIL_HEADER)).toContainText('ended, expired, or is not available to this account');
  await expect(page.locator('#session-detail-panels')).toBeHidden();
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

  // A partial deployment without factor discovery must not send an unenrolled
  // administrator into an AS step-up dead end.
  await filterManifestRoutes(page, new Set(['GET /api/v1/me/security/factors']));
  await page.goto(`${BASE_URL}/ui`, { waitUntil: 'domcontentloaded' });
  await page.locator(CONSOLE_SHELL).waitFor({ state: 'visible' });
  await expect(page.locator('#elevate-btn')).toBeDisabled();
  await expect(page.locator('#elevate-btn')).toHaveText(/Elevation unavailable/);
  await page.unroute(MANIFEST_URL);

  // 3. ENROLL TOTP
  await page.goto(`${BASE_URL}/api/v1/me/security/factors/enroll/totp`, { waitUntil: 'domcontentloaded' });
  const secretText = (await page.locator('code').first().innerText()).trim().replaceAll(/\s+/g, '');
  const totp = new TOTP({ secret: Secret.fromBase32(secretText) });
  await page.fill('input[name="code"]', totp.generate());
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button[type="submit"]')]);

  // 4. STEP-UP for the operate capability (may re-prompt password, then TOTP)
  await stepUpWithTotp(page, totp);

  // 5. ADMIN now reachable with fresh elevation
  expect(await status(page, OPERATE), 'admin reachable after step-up').toBe(200);

  // The Users surface gets its role list and grants from /me/role-catalog.
  const catalogResponse = await page.request.get(`${BASE_URL}/api/v1/me/role-catalog`);
  const catalog = await catalogResponse.json() as { roles: string[] };
  await filterManifestRoutes(page, new Set([
    'GET /api/v1/me/portfolio/elements',
    'GET /api/v1/me/sessions',
    'GET /api/v1/me/security/sessions',
    'GET /api/v1/me/logs',
    'GET /api/v1/me/integrations',
  ]));
  await page.goto(`${BASE_URL}/ui?tab=users`, { waitUntil: 'domcontentloaded' });
  await page.locator(CONSOLE_SHELL).waitFor({ state: 'visible' });
  await expect(page.locator('.console-tab[data-tab="users"]')).toBeVisible();
  await page.route(ADMIN_USER_SESSIONS_URL, route => route.fulfill({
    status: 403,
    contentType: 'application/problem+json',
    body: JSON.stringify({ status: 403, code: 'forbidden', detail: 'Not authorized.' }),
  }));
  await page.locator('[data-user-row]').first().click();
  await expect(page.locator('[data-role-toggle]')).toHaveCount(catalog.roles.length);
  await expect(page.locator('.ua-sessions')).toContainText('Couldn\'t load active sessions.');
  await page.unroute(ADMIN_USER_SESSIONS_URL);

  // 6. STEP-DOWN destroys an open privileged drawer and hides its panel even
  // when no non-admin tab exists.
  await expect(page.locator('.ua-drawer')).toBeVisible();
  await page.locator('#exit-btn').dispatchEvent('click');
  await expect(page.locator('#console-empty-state')).toBeVisible();
  await expect(page.locator('#tab-users')).toBeHidden();
  await expect(page.locator('.console-tab[data-tab="users"]')).toBeHidden();
  await expect(page.locator('.ua-drawer')).toHaveCount(0);
  expect(await status(page, OPERATE), 'admin gated again after step-down').toBe(401);

  // 7. TIMER EXPIRY takes the same fail-closed path without relying on Exit.
  await stepUpWithTotp(page, totp);
  expect(await status(page, OPERATE), 'admin reachable after second step-up').toBe(200);
  const clockNow = new Date();
  await page.clock.install({ time: clockNow });
  await page.route(AUTH_ME_URL, async route => {
    const response = await route.fetch();
    const principal = await response.json() as {
      elevation?: { active?: boolean; expires_at?: string };
    };
    await route.fulfill({
      response,
      json: {
        ...principal,
        elevation: {
          ...principal.elevation,
          active: true,
          expires_at: new Date(clockNow.getTime() + 2_000).toISOString(),
        },
      },
    });
  });
  await page.goto(`${BASE_URL}/ui?tab=users`, { waitUntil: 'domcontentloaded' });
  await page.locator(CONSOLE_SHELL).waitFor({ state: 'visible' });
  await page.locator('[data-user-row]').first().click();
  await expect(page.locator('.ua-drawer')).toBeVisible();
  await page.clock.fastForward(3_000);
  await expect(page.locator('#console-empty-state')).toBeVisible();
  await expect(page.locator('#tab-users')).toBeHidden();
  await expect(page.locator('.ua-drawer')).toHaveCount(0);
  await page.unroute(AUTH_ME_URL);
  expect(await status(page, OPERATE), 'server remains elevated until explicit cleanup').toBe(200);
  expect(await csrfPost(page, '/api/v1/auth/step-down')).toBe(204);

  // 8. LOGOUT ends the session
  const logout = await csrfPost(page, '/api/v1/auth/logout');
  expect(logout).toBe(204);
  expect(await status(page, '/api/v1/auth/me'), 'session ended after logout').toBe(401);
});
