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
import { installIntegrationsUiMock } from '../harness/integrationsUiMock.js';
import { installAuditUiMock } from '../harness/auditUiMock.js';
import { installSecurityAdminUiMock } from '../harness/securityAdminUiMock.js';
import { installAccountsAdminUiMock } from '../harness/accountsAdminUiMock.js';
import {
  installOperationsUiMock,
  OPERATIONS_PRIVATE_MARKER,
  SECOND_OPERATIONAL_SESSION_ID,
} from '../harness/operationsUiMock.js';
import { BASE_URL } from '../setup/provision.js';

const USER = 'e2e_admin';
const OPERATE = '/api/v1/admin/operate/health';
const MANIFEST_URL = '**/api/v1/me/manifest';
const CONSOLE_SHELL = '#console-shell';
const SESSIONS_TAB = '.console-tab[data-tab="sessions"]';
const SESSION_DETAIL_HEADER = '#session-detail-header';
const CONFIRM_ACTION = '[data-confirm="1"]';
const ACCOUNT_MENU = '#site-account';
const PORTFOLIO_CREATE = '#pf-create';
const EDITOR_FEEDBACK = '[data-editor-feedback]';
const EDITOR_CONTENT = '.portfolio-editor [name="content"]';
const EDITOR_INSTRUCTIONS = '.portfolio-editor [name="instructions"]';
const EDITOR_METADATA = '.portfolio-editor [name="metadata"]';
const EDITOR_SUBMIT = '.portfolio-editor button[type="submit"]';
const EDITOR_VALIDATE = '[data-editor-validate]';
const AUTHORING_WORKSPACE = '[data-portfolio-authoring]';
const THEME_SELECT = '#account-theme-form [name="theme"]';
const OPERATIONS_TAB = '.console-tab[data-tab="operations"]';
const SUBMIT_BUTTON = 'button[type="submit"]';
const OPERATIONS_HEALTH_NAV = '[data-operations-nav="health"]';
const OPERATIONS_CONFIG_NAV = '[data-operations-nav="config"]';
const OPERATIONS_SESSIONS_NAV = '[data-operations-nav="sessions"]';
const ENABLED_CONFIG_FORM = '[data-config-form="enhanced_index.enabled"]';
const OPERATIONAL_SESSION_CARD = '[data-operational-session-id]';
const BULK_SESSION_ACTION = '#sess-revoke-others';
const USER_DRAWER = '.ua-drawer';
const AUTH_ME_URL = '**/api/v1/auth/me';
const ADMIN_USER_SESSIONS_URL = '**/api/v1/admin/accounts/users/*/sessions';
const INTEGRATIONS_TAB = '.console-tab[data-tab="integrations"]';
const INTEGRATION_DESCRIPTOR_CARD = '.int-descriptor-card';
const INTEGRATION_OPERATION_ROW = '.int-operation';
const INTEGRATION_ROUTES = [
  { method: 'GET', path: '/api/v1/me/integrations/:provider' },
  { method: 'POST', path: '/api/v1/me/integrations/:provider/connect' },
  { method: 'DELETE', path: '/api/v1/me/integrations/:provider' },
  { method: 'GET', path: '/api/v1/me/integrations/descriptors' },
  { method: 'POST', path: '/api/v1/me/integrations/descriptors' },
  { method: 'PATCH', path: '/api/v1/me/integrations/descriptors/:id' },
  { method: 'DELETE', path: '/api/v1/me/integrations/descriptors/:id' },
  { method: 'PUT', path: '/api/v1/me/integrations/descriptors/:id/spec' },
  { method: 'GET', path: '/api/v1/me/integrations/descriptors/:id/spec' },
  { method: 'GET', path: '/api/v1/me/integrations/descriptors/:id/spec/operations' },
] as const;

interface TextFileFixture {
  readonly name: string;
  readonly mimeType: string;
  readonly content: string;
}

async function setTextInputFile(page: Page, selector: string, file: TextFileFixture): Promise<void> {
  await page.locator(selector).evaluate((element, fixture) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('File fixture target must be an input element.');
    const transfer = new DataTransfer();
    transfer.items.add(new File([fixture.content], fixture.name, { type: fixture.mimeType }));
    element.files = transfer.files;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, file);
}

async function filterManifestRoutes(page: Page, unavailableRoutes: ReadonlySet<string>): Promise<void> {
  await page.route(MANIFEST_URL, async route => {
    const response = await route.fetch();
    const manifest = await response.json() as { routes: Array<{ method: string; path: string }> };
    const routes = manifest.routes.filter(item => !unavailableRoutes.has(`${item.method} ${item.path}`));
    await route.fulfill({ response, json: { ...manifest, routes } });
  });
}

async function includeManifestRoutes(
  page: Page,
  additionalRoutes: ReadonlyArray<{ readonly method: string; readonly path: string }>,
): Promise<void> {
  await page.route(MANIFEST_URL, async route => {
    const response = await route.fetch();
    const manifest = await response.json() as { routes: Array<{ method: string; path: string }> };
    const routeKeys = new Set(manifest.routes.map(item => `${item.method} ${item.path}`));
    const routes = [
      ...manifest.routes,
      ...additionalRoutes.filter(item => !routeKeys.has(`${item.method} ${item.path}`)),
    ];
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

async function openMockOperations(page: Page): Promise<void> {
  await setElevation(page, ['console:admin:operate']);
  await expect(page.locator(OPERATIONS_TAB)).toBeVisible();
  await page.locator(OPERATIONS_TAB).click();
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

test('All combines every collection page with the portfolio and reports source totals', async ({ page }) => {
  await includeManifestRoutes(page, [
    { method: 'GET', path: '/api/v1/collection/elements' },
    { method: 'GET', path: '/api/v1/collection/elements/:type/:name' },
  ]);
  const mock = await installPortfolioUiMock(page, { includeCollection: true });
  await loginFromConsole(page);

  await expect(page.locator('#pf-source')).toBeVisible();
  await expect(page.locator('#pf-summary')).toHaveText('3 total elements');
  await expect(page.locator('#pf-count')).toHaveText('3 elements');
  await expect(page.locator('#pf-grid .element-card')).toHaveCount(3);
  await expect(page.locator('#pf-grid .source-badge-collection')).toHaveCount(2);
  await expect(page.locator('#pf-grid .source-badge', { hasText: 'LOCAL' })).toHaveCount(1);
  await expect(page.locator('#pf-type-filters [data-key="personas"] .filter-count')).toHaveText('1');
  await expect(page.locator('#pf-type-filters [data-key="skills"] .filter-count')).toHaveText('1');
  await expect(page.locator('#pf-type-filters [data-key="templates"] .filter-count')).toHaveText('1');
  expect(mock.collectionReads).toBe(2);

  await page.locator('#pf-source [data-source="portfolio"]').click();
  await expect(page.locator('#pf-summary')).toHaveText('1 portfolio element');
  await expect(page.locator('#pf-grid .element-card')).toHaveCount(1);

  await page.locator('#pf-source [data-source="collection"]').click();
  await expect(page.locator('#pf-summary')).toHaveText('2 collection elements');
  await expect(page.locator('#pf-grid .element-card')).toHaveCount(2);

  await page.locator('#pf-source [data-source="all"]').click();
  await page.locator('#pf-search').fill('Collection Skill');
  await expect(page.locator('#pf-count')).toHaveText('1 element');
  await expect(page.locator('#pf-grid .element-card')).toHaveCount(1);
  await expect(page.locator('#pf-grid .card-title')).toHaveText('Collection Skill');
});

test('portfolio authoring validates drafts, preserves conflicts, and confirms hard deletion', async ({ page }) => {
  const mock = await installPortfolioUiMock(page, { conflictOnFirstPatch: true });
  await loginFromConsole(page);

  await expect(page.locator('.portfolio-start-action')).toHaveCount(2);
  await expect(page.locator(PORTFOLIO_CREATE)).toContainText('Create new');
  await expect(page.locator('#pf-import')).toContainText('Import file');
  await page.locator(PORTFOLIO_CREATE).click();
  await expect(page.locator(AUTHORING_WORKSPACE)).toBeVisible();
  await expect(page.locator('.portfolio-type-choice')).toHaveCount(6);
  await expect(page.locator('[data-builder-overview]')).toContainText('Building a Persona');
  await expect(page.locator(EDITOR_METADATA)).toBeHidden();
  await page.locator('[data-custom-metadata] summary').click();
  await expect(page.locator('[data-custom-metadata-enable]')).toBeVisible();
  await page.locator('[data-custom-metadata-enable]').click();
  await page.locator(EDITOR_METADATA).fill('{');
  await expect(page.locator('[data-custom-metadata-status]')).toContainText('must be valid JSON');
  await page.locator(EDITOR_METADATA).fill('{"custom_note":"preserve me"}');
  await expect(page.locator('[data-custom-metadata-status]')).toContainText('Valid JSON object');
  await page.locator(EDITOR_VALIDATE).click();
  await expect(page.locator(EDITOR_FEEDBACK)).toContainText('Name is required');
  await expect(page.locator(EDITOR_FEEDBACK)).toBeInViewport();
  await page.locator('.portfolio-editor [name="name"]').fill('browser-created');
  await page.locator(EDITOR_VALIDATE).click();
  await expect(page.locator(EDITOR_FEEDBACK)).toContainText('Description is required');
  await page.locator('.portfolio-editor [name="description"]').fill('A guided browser-created persona.');
  await page.locator(EDITOR_VALIDATE).click();
  await expect(page.locator(EDITOR_FEEDBACK)).toContainText('Behavioral instructions are required');
  await page.locator(EDITOR_INSTRUCTIONS).fill('You are a careful browser-created persona.');
  await page.locator(EDITOR_VALIDATE).click();
  await expect(page.locator(EDITOR_FEEDBACK)).toContainText('Validation passed');
  await page.locator(EDITOR_SUBMIT).click();
  await expect(page.locator('[data-name="browser-created"]')).toBeVisible();
  expect(mock.elements.find(item => item.name === 'browser-created')?.metadata.custom_note).toBe('preserve me');

  await page.locator('[data-name="alpha-persona"] [data-action="edit"]').click();
  await page.locator(EDITOR_CONTENT).fill('Unsaved browser draft.');
  await page.locator(EDITOR_SUBMIT).click();
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

test('portfolio guided authoring serializes agent and ensemble settings', async ({ page }) => {
  const mock = await installPortfolioUiMock(page);
  await loginFromConsole(page);

  await page.locator(PORTFOLIO_CREATE).click();
  await page.locator('.portfolio-editor [name="type"][value="agents"]').check();
  await page.locator('.portfolio-editor [name="name"]').fill('guided-agent');
  await page.locator('.portfolio-editor [name="description"]').fill('An agent configured through guided fields.');
  await page.locator(EDITOR_INSTRUCTIONS).fill('Coordinate the selected elements and tools.');
  await page.locator('.portfolio-editor [name="agent_goal_template"]').fill('Research {topic} and recommend a path.');
  await page.locator('.portfolio-editor [name="agent_success_criteria"]').fill('Sources are cited\nTradeoffs are explicit');
  await page.locator('.portfolio-editor [name="agent_activates_personas"]').fill('technical-writer, reviewer');
  await page.locator('.portfolio-editor [name="agent_activates_skills"]').fill('web-research');
  await page.locator('.portfolio-editor [name="agent_tools_allowed"]').fill('search, fetch');
  await page.locator('.portfolio-editor [name="agent_tools_denied"]').fill('shell');
  await page.locator('.portfolio-editor [name="agent_risk_tolerance"]').selectOption('conservative');
  await page.locator('.portfolio-editor [name="agent_max_steps"]').fill('12');
  await page.locator(EDITOR_SUBMIT).click();
  await expect(page.locator('[data-name="guided-agent"]')).toBeVisible();

  expect(mock.elements.find(item => item.name === 'guided-agent')?.metadata).toMatchObject({
    goal: {
      template: 'Research {topic} and recommend a path.',
      parameters: [],
      successCriteria: ['Sources are cited', 'Tradeoffs are explicit'],
    },
    activates: {
      personas: ['technical-writer', 'reviewer'],
      skills: ['web-research'],
    },
    tools: {
      allowed: ['search', 'fetch'],
      denied: ['shell'],
    },
    autonomy: {
      riskTolerance: 'conservative',
      maxAutonomousSteps: 12,
    },
  });

  await page.locator(PORTFOLIO_CREATE).click();
  await page.locator('.portfolio-editor [name="type"][value="ensembles"]').check();
  await page.locator('.portfolio-editor [name="name"]').fill('guided-ensemble');
  await page.locator('.portfolio-editor [name="description"]').fill('An ensemble configured through guided fields.');
  await page.locator(EDITOR_INSTRUCTIONS).fill('Coordinate the ensemble members in priority order.');
  await page.locator('.portfolio-editor [name="ensemble_activation_strategy"]').selectOption('priority');
  await page.locator('.portfolio-editor [name="ensemble_conflict_resolution"]').selectOption('merge');
  await page.locator('.portfolio-editor [name="ensemble_context_sharing"]').selectOption('selective');
  await page.locator('.portfolio-editor [name="ensemble_allow_nested"]').check();
  const elementRow = page.locator('[data-repeat-row="ensemble-elements"]');
  await elementRow.locator('[data-row-field="name"]').fill('technical-writer');
  await elementRow.locator('[data-row-field="type"]').selectOption('persona');
  await elementRow.locator('[data-row-field="role"]').selectOption('primary');
  await elementRow.locator('[data-row-field="activation"]').selectOption('always');
  await elementRow.locator('[data-row-field="priority"]').fill('');
  await elementRow.locator('[data-row-field="purpose"]').fill('Draft the final response.');
  await page.locator(EDITOR_SUBMIT).click();
  await expect(page.locator('[data-name="guided-ensemble"]')).toBeVisible();

  expect(mock.elements.find(item => item.name === 'guided-ensemble')?.metadata).toMatchObject({
    activationStrategy: 'priority',
    conflictResolution: 'merge',
    contextSharing: 'selective',
    allowNested: true,
    elements: [{
      element_name: 'technical-writer',
      element_type: 'persona',
      role: 'primary',
      priority: 10,
      activation: 'always',
      purpose: 'Draft the final response.',
    }],
  });
});

test('integration catalog connects static credentials without rendering them back', async ({ page }) => {
  await includeManifestRoutes(page, INTEGRATION_ROUTES);
  const mock = await installIntegrationsUiMock(page);
  await loginFromConsole(page);

  await page.locator(INTEGRATIONS_TAB).click();
  await expect(page.locator('.int-card')).toHaveCount(4);
  const acmeCard = page.locator('.int-card', { hasText: 'Acme Tasks' });
  await expect(acmeCard).toContainText('Not connected');
  await acmeCard.locator('[data-connect]').click();

  const secretMarker = 'e2e-api-key-private-marker';
  await page.locator('#int-credential-modal [name="api_key"]').fill(secretMarker);
  await page.locator('#int-credential-modal [name="account_label"]').fill('Work account');
  await page.locator('#int-credential-modal button[type="submit"]').click();

  await expect(acmeCard).toContainText('Connected');
  await expect(page.locator('body')).not.toContainText(secretMarker);
  expect(mock.staticConnects).toBe(1);
  expect(mock.receivedApiKey).toBe(true);

  const basicCard = page.locator('.int-card', { hasText: 'Legacy Reports' });
  await basicCard.locator('[data-connect]').click();
  await page.locator('#int-credential-modal [name="username"]').fill('report-user');
  await page.locator('#int-credential-modal [name="password"]').fill('private-password-marker');
  await page.locator('#int-credential-modal button[type="submit"]').click();
  await expect(basicCard).toContainText('Connected');
  await expect(page.locator('body')).not.toContainText('private-password-marker');
  expect(mock.staticConnects).toBe(2);
  expect(mock.receivedBasicCredential).toBe(true);
});

test('integration descriptor management stays hidden when its route is unavailable', async ({ page }) => {
  await filterManifestRoutes(page, new Set(['GET /api/v1/me/integrations/descriptors']));
  await installIntegrationsUiMock(page);
  await loginFromConsole(page);

  await page.locator(INTEGRATIONS_TAB).click();
  await expect(page.locator('[data-int-view="descriptors"]')).toHaveCount(0);
  await expect(page.locator('.int-card', { hasText: 'GitHub' })).toBeVisible();
});

test('custom integration authoring keeps secrets write-only and imports OpenAPI files', async ({ page }) => {
  await includeManifestRoutes(page, INTEGRATION_ROUTES);
  const mock = await installIntegrationsUiMock(page);
  await loginFromConsole(page);

  await page.locator(INTEGRATIONS_TAB).click();
  await page.locator('[data-int-view="descriptors"]').click();
  await expect(page.locator(INTEGRATION_DESCRIPTOR_CARD, { hasText: 'Curated OAuth' }).locator('[data-descriptor-edit]')).toHaveCount(0);
  await page.locator('[data-descriptor-create]').click();

  const secretMarker = 'e2e-oauth-client-secret-marker';
  await page.locator('[name="display_name"]').fill('Browser Calendar');
  await page.locator('[name="provider"]').fill('browser-calendar');
  await page.locator('[name="category"]').fill('Calendar');
  await page.locator('[name="api_hosts"]').fill('api.calendar.test');
  await page.locator('[name="oauth_client_id"]').fill('browser-client');
  await page.locator('[name="oauth_client_secret"]').fill(secretMarker);
  await page.locator('[name="oauth_authorization_url"]').fill('https://auth.calendar.test/authorize');
  await page.locator('[name="oauth_token_url"]').fill('https://auth.calendar.test/token');
  await page.locator('#int-descriptor-form button[type="submit"]').click();

  await expect(page.locator(INTEGRATION_DESCRIPTOR_CARD, { hasText: 'Browser Calendar' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(secretMarker);
  expect(mock.receivedClientSecret).toBe(true);
  expect(mock.clientSecretWrites).toBe(1);

  let customCard = page.locator(INTEGRATION_DESCRIPTOR_CARD, { hasText: 'Browser Calendar' });
  await customCard.locator('[data-descriptor-edit]').click();
  await expect(page.locator('[name="oauth_client_secret"]')).toHaveValue('');
  await page.locator('[name="display_name"]').fill('Browser Calendar Updated');
  await page.locator('#int-descriptor-form button[type="submit"]').click();
  await expect(page.locator(INTEGRATION_DESCRIPTOR_CARD, { hasText: 'Browser Calendar Updated' })).toBeVisible();
  expect(mock.clientSecretWrites).toBe(1);

  customCard = page.locator(INTEGRATION_DESCRIPTOR_CARD, { hasText: 'Browser Calendar Updated' });
  await customCard.locator('[data-descriptor-spec]').click();
  await setTextInputFile(page, '[name="spec_file"]', {
    name: 'calendar.openapi.yaml',
    mimeType: 'application/yaml',
    content: [
      'openapi: 3.0.3',
      'info:',
      '  title: Calendar API',
      '  version: 1.0.0',
      'paths:',
      '  /tasks:',
      '    get:',
      '      operationId: listTasks',
      '      summary: List tasks',
      '      responses:',
      "        '200':",
      '          description: OK',
    ].join('\n'),
  });
  await expect(page.locator('[name="spec_text"]')).toHaveValue(/openapi: 3\.0\.3/u);
  await page.locator('#int-spec-form button[type="submit"]').click();

  await expect(page.locator('.int-spec-summary')).toContainText('1 operation discovered');
  await expect(page.locator(INTEGRATION_OPERATION_ROW)).toContainText('listTasks');
  expect(mock.specWrites).toBe(1);
  expect(mock.descriptorWrites).toBe(2);

  await page.locator('[data-descriptor-back]').first().click();
  customCard = page.locator(INTEGRATION_DESCRIPTOR_CARD, { hasText: 'Browser Calendar Updated' });
  await customCard.locator('[data-descriptor-delete]').click();
  await page.locator('#confirm-modal [data-confirm="1"]').click();
  await expect(customCard).toHaveCount(0);
});

const AUDIT_TAB = '.console-tab[data-tab="audit"]';
const AUDIT_ADMIN_PANEL = '[data-audit-panel="admin"]';
const AUDIT_ROW = '.audit-row';

async function setElevation(page: Page, capabilities: readonly string[], active = true): Promise<void> {
  await page.evaluate(({ caps, isActive }) => {
    globalThis.dispatchEvent(new CustomEvent('dh:elevation-changed', {
      detail: { active: isActive, capabilities: caps },
    }));
  }, { caps: capabilities, isActive: active });
}

async function openAuditTab(page: Page): Promise<void> {
  await setElevation(page, ['console:admin:audit']);
  await page.locator(AUDIT_TAB).click();
}

test('audit lists page through records and report integrity without inventing filters', async ({ page }) => {
  const mock = await installAuditUiMock(page);
  await loginFromConsole(page);
  await openAuditTab(page);

  const panel = page.locator(AUDIT_ADMIN_PANEL);
  await panel.locator(AUDIT_ROW).first().waitFor();
  await expect(page.locator('[data-audit-nav]')).toHaveText(['Admin actions', 'Approvals', 'Authentication']);

  // The backend exposes no filter parameters, so the surface must not offer any.
  await expect(panel.locator('input, select')).toHaveCount(0);

  // 75 seeded records at a 50 page size: one full page, then the remainder.
  await expect(panel.locator(AUDIT_ROW)).toHaveCount(51); // 50 rows + header
  await expect(panel.locator('[data-audit-previous]')).toBeDisabled();
  await panel.locator('[data-audit-next]').click();
  await expect.poll(() => panel.locator(AUDIT_ROW).count()).toBe(26);
  await expect(panel.locator('[data-audit-previous]')).toBeEnabled();
  await expect(panel.locator('[data-audit-next]')).toBeDisabled();

  // Integrity is reported as recorded, including records that failed verification.
  await panel.locator('[data-audit-previous]').click();
  await expect(panel.locator('.audit-chip--verified').first()).toBeVisible();
  await expect(panel.locator('.audit-chip--failed').first()).toBeVisible();

  // An unverifiable approval says so rather than implying it was verified.
  await page.locator('[data-audit-nav="approvals"]').click();
  const approvals = page.locator('[data-audit-panel="approvals"]');
  await expect(approvals.locator('.audit-chip--not_available')).toContainText('not recorded');
  expect(mock.listReads).toBeGreaterThan(0);
});

test('an audit record that needs fresher elevation says so instead of failing silently', async ({ page }) => {
  const mock = await installAuditUiMock(page);
  mock.detailStatus = 401; // list tier satisfied, detail tier is not
  await loginFromConsole(page);
  await openAuditTab(page);

  const panel = page.locator(AUDIT_ADMIN_PANEL);
  await panel.locator(AUDIT_ROW).first().waitFor();
  await panel.locator('[data-audit-open]').first().click();

  await expect(panel.locator('.audit-detail')).toContainText('more recent sign-in');
  expect(mock.detailReads).toBe(1);
  // The list is still usable: a stricter tier on one route must not break the page.
  await expect(panel.locator(AUDIT_ROW).first()).toBeVisible();
});

test('the audit export finishes as a bounded download rather than a live stream', async ({ page }) => {
  const mock = await installAuditUiMock(page);
  await loginFromConsole(page);
  await openAuditTab(page);

  const panel = page.locator(AUDIT_ADMIN_PANEL);
  await panel.locator(AUDIT_ROW).first().waitFor();
  await panel.locator('[data-audit-export]').click();

  await expect(panel.locator('a[download]')).toBeVisible();
  await expect(panel.locator('[data-audit-export-status]')).toContainText('3 records ready');
  // Terminal: the run ends on the server's `end` frame and is not reopened.
  await expect(panel.locator('[data-audit-export-cancel]')).toHaveCount(0);
  expect(mock.exportReads).toBe(1);
  await page.waitForTimeout(1000);
  expect(mock.exportReads, 'a finished export must not reconnect').toBe(1);
});

test('an audit export refused for elevation reports it and offers no partial download', async ({ page }) => {
  const mock = await installAuditUiMock(page);
  mock.exportStatus = 401;
  await loginFromConsole(page);
  await openAuditTab(page);

  const panel = page.locator(AUDIT_ADMIN_PANEL);
  await panel.locator(AUDIT_ROW).first().waitFor();
  await panel.locator('[data-audit-export]').click();

  await expect(panel.locator('.audit-export-status--error')).toContainText('more recent sign-in');
  await expect(panel.locator('a[download]')).toHaveCount(0);
});

test('the audit tab stays hidden without its capability', async ({ page }) => {
  await installAuditUiMock(page);
  await loginFromConsole(page);
  await setElevation(page, ['console:admin:accounts']);
  await expect(page.locator(AUDIT_TAB)).toBeHidden();
});

const SECURITY_TAB = '.console-tab[data-tab="security"]';
const SECURITY_KEYS_PANEL = '[data-secadmin-panel="keys"]';
const SECURITY_ERROR = '.secadmin-notice--error';
const SECURITY_RECEIPT = '.secadmin-receipt';

async function openSecurityTab(page: Page): Promise<void> {
  await setElevation(page, ['console:admin:security']);
  await page.locator(SECURITY_TAB).click();
  await page.locator(`${SECURITY_KEYS_PANEL} .secadmin-card`).first().waitFor();
}

async function confirmDialogAction(page: Page): Promise<void> {
  await page.locator('#confirm-modal [data-confirm="1"]').click();
}

test('a cancelled audit export leaves no download behind', async ({ page }) => {
  const mock = await installAuditUiMock(page);
  mock.exportTerminates = false; // still running, so there is something to cancel
  await loginFromConsole(page);
  await openAuditTab(page);

  const panel = page.locator(AUDIT_ADMIN_PANEL);
  await panel.locator(AUDIT_ROW).first().waitFor();
  await panel.locator('[data-audit-export]').click();
  await panel.locator('[data-audit-export-cancel]').click();

  await expect(panel.locator('[data-audit-export-status]')).toContainText('Cancelled');
  await expect(panel.locator('a[download]')).toHaveCount(0);
  // Cancelling returns the control to its resting state rather than stranding it.
  await expect(panel.locator('[data-audit-export]')).toBeVisible();
});

test('an audit list refused for elevation reports it without stranding the panel', async ({ page }) => {
  const mock = await installAuditUiMock(page);
  mock.listStatus = 401;
  await loginFromConsole(page);
  await openAuditTab(page);

  const panel = page.locator(AUDIT_ADMIN_PANEL);
  await expect(panel.locator('.audit-notice--error')).toContainText('more recent sign-in');
  await expect(panel.locator('.audit-loading')).toHaveCount(0);
});

test('opening an audit record while the list reloads leaves neither stuck', async ({ page }) => {
  await installAuditUiMock(page);
  await loginFromConsole(page);
  await openAuditTab(page);

  const panel = page.locator(AUDIT_ADMIN_PANEL);
  await panel.locator(AUDIT_ROW).first().waitFor();
  // Interleaved list and detail requests must not cancel one another.
  await panel.locator('[data-audit-refresh]').click();
  await panel.locator('[data-audit-open]').first().click();

  await expect(panel.locator('.audit-detail-grid')).toBeVisible();
  await expect(panel.locator('.audit-loading')).toHaveCount(0);
  await expect(panel.locator(AUDIT_ROW).first()).toBeVisible();
});

test('rotating a signing key confirms first and shows the returned receipt', async ({ page }) => {
  const mock = await installSecurityAdminUiMock(page);
  await loginFromConsole(page);
  await openSecurityTab(page);

  const keys = page.locator(SECURITY_KEYS_PANEL);
  await keys.locator('[data-key-action="rotate"][data-key-kind="jwks"]').click();
  // The confirmation states the consequence rather than asking a bare "are you sure".
  await expect(page.locator('#confirm-modal')).toContainText('tokens already issued keep working');
  await confirmDialogAction(page);

  await expect(keys.locator(SECURITY_RECEIPT)).toContainText('rotate completed');
  await expect(keys.locator(SECURITY_RECEIPT)).toContainText('jwks-key-new');
  expect(mock.rotateCalls).toBe(1);
});

test('a signing key operation refused for fresh elevation keeps its reason on screen', async ({ page }) => {
  const mock = await installSecurityAdminUiMock(page);
  mock.mutationStatus = 401; // reads pass, mutations need a fresher sign-in
  await loginFromConsole(page);
  await openSecurityTab(page);

  const keys = page.locator(SECURITY_KEYS_PANEL);
  await keys.locator('[data-key-action="rotate"][data-key-kind="jwks"]').click();
  await confirmDialogAction(page);

  // Not a toast: the explanation has to survive long enough to act on.
  await expect(keys.locator(SECURITY_ERROR)).toContainText('more recent sign-in');
  await page.waitForTimeout(6000);
  await expect(keys.locator(SECURITY_ERROR)).toBeVisible();
  await expect(keys.locator(SECURITY_RECEIPT)).toHaveCount(0);
  expect(mock.rotateCalls).toBe(0);
});

test('deleting a key inside its grace requires a second, explicit override', async ({ page }) => {
  const mock = await installSecurityAdminUiMock(page);
  await loginFromConsole(page);
  await openSecurityTab(page);

  const keys = page.locator(SECURITY_KEYS_PANEL);
  await keys.locator('[data-key-action="retire"][data-key-kid="jwks-key-old"]').click();
  await confirmDialogAction(page);
  await expect(keys.locator(SECURITY_RECEIPT)).toContainText('retire completed');

  await keys.locator('[data-key-action="delete"][data-key-kid="jwks-key-old"]').click();
  await confirmDialogAction(page);

  // The server refuses the plain delete; the override names the actual consequence.
  await expect(page.locator('#confirm-modal')).toContainText('can break verification');
  await confirmDialogAction(page);

  await expect(keys.locator(SECURITY_RECEIPT)).toContainText('delete completed');
  expect(mock.deleteCalls.map(call => call.forced)).toEqual([false, true]);
});

test('declining the grace override leaves the key in place', async ({ page }) => {
  const mock = await installSecurityAdminUiMock(page);
  await loginFromConsole(page);
  await openSecurityTab(page);

  const keys = page.locator(SECURITY_KEYS_PANEL);
  await keys.locator('[data-key-action="retire"][data-key-kid="jwks-key-old"]').click();
  await confirmDialogAction(page);
  await keys.locator('[data-key-action="delete"][data-key-kid="jwks-key-old"]').click();
  await confirmDialogAction(page);
  await page.locator('#confirm-modal [data-confirm="0"]').click();

  expect(mock.deleteCalls.map(call => call.forced)).toEqual([false]);
});

test('the auth policy edits only its one mutable field and guards it with the ETag', async ({ page }) => {
  const mock = await installSecurityAdminUiMock(page);
  await loginFromConsole(page);
  await openSecurityTab(page);
  await page.locator('[data-secadmin-nav="policy"]').click();

  const policy = page.locator('[data-secadmin-panel="policy"]');
  await expect(policy.locator('.secadmin-invariants li')).toHaveCount(5);
  // The invariants are stated, not offered as controls.
  await expect(policy.locator('.secadmin-invariants input')).toHaveCount(0);
  await expect(policy.locator('input')).toHaveCount(1);

  await policy.locator('[name="max_admin_elevation_seconds"]').fill('900');
  await policy.locator('button[type="submit"]').click();
  await expect.poll(() => mock.policyPuts.length).toBe(1);
  expect(mock.policyPuts[0].ifMatch).toBe('W/"security-auth-policy:1:1800"');
  expect(mock.policyPuts[0].seconds).toBe(900);
});

test('a policy that changed elsewhere is reported without overwriting it', async ({ page }) => {
  const mock = await installSecurityAdminUiMock(page);
  mock.policyPutStatus = 412;
  await loginFromConsole(page);
  await openSecurityTab(page);
  await page.locator('[data-secadmin-nav="policy"]').click();

  const policy = page.locator('[data-secadmin-panel="policy"]');
  await policy.locator('[name="max_admin_elevation_seconds"]').fill('900');
  await policy.locator('button[type="submit"]').click();

  await expect(policy.locator(SECURITY_ERROR)).toContainText('changed elsewhere');
  expect(mock.policy.max_admin_elevation_seconds, 'the stored policy is untouched').toBe(1800);
});

test('the security tab stays hidden without its capability', async ({ page }) => {
  await installSecurityAdminUiMock(page);
  await loginFromConsole(page);
  await setElevation(page, ['console:admin:accounts']);
  await expect(page.locator(SECURITY_TAB)).toBeHidden();
});

const ALLOWLIST_VALUE = '[name="value"]';

async function openAccountsSection(page: Page, section: string) {
  await setElevation(page, ['console:admin:accounts']);
  await page.locator('.console-tab[data-tab="users"]').click();
  await page.locator('#ua-list').waitFor();
  await page.locator(`[data-ua-nav="${section}"]`).click();
  return page.locator(`[data-ua-panel="${section}"]`);
}

test('the allowlist adds and removes an entry without disturbing the account list', async ({ page }) => {
  const mock = await installAccountsAdminUiMock(page);
  await loginFromConsole(page);
  const panel = await openAccountsSection(page, 'allowlist');

  // An empty allowlist is a locked door, not an absence — say so.
  await expect(panel.locator('.acct-empty')).toContainText('Every sign-in will be refused');

  await panel.locator(ALLOWLIST_VALUE).fill('someone@example.test');
  await panel.locator('[name="note"]').fill('vendor access');
  await panel.locator('#acct-allow-form button[type="submit"]').click();

  await expect(panel.locator('.acct-row')).toHaveCount(2); // header + entry
  expect(mock.posts).toEqual([{ kind: 'email', value: 'someone@example.test', note: 'vendor access' }]);

  await panel.locator('[data-allow-action="remove"]').first().click();
  await expect(page.locator('#confirm-modal')).toContainText('no longer be able to sign in');
  await page.locator('#confirm-modal [data-confirm="1"]').click();
  await expect(panel.locator('.acct-empty')).toBeVisible();
  expect(mock.deletes).toEqual(['allow-1']);

  // The account list this tab already had must be untouched by any of that.
  await page.locator('[data-ua-nav="accounts"]').click();
  await expect(page.locator('#ua-list')).toBeVisible();
});

test('a refresh does not discard a part-typed allowlist entry', async ({ page }) => {
  await installAccountsAdminUiMock(page);
  await loginFromConsole(page);
  const panel = await openAccountsSection(page, 'allowlist');

  await panel.locator(ALLOWLIST_VALUE).fill('half-typed@example.test');
  await panel.locator('[data-allow-action="refresh"]').click();
  await expect(panel.locator(ALLOWLIST_VALUE)).toHaveValue('half-typed@example.test');
});

test('editing an allowlist entry sends only its note', async ({ page }) => {
  const mock = await installAccountsAdminUiMock(page);
  await loginFromConsole(page);
  const panel = await openAccountsSection(page, 'allowlist');

  await panel.locator(ALLOWLIST_VALUE).fill('someone@example.test');
  await panel.locator('#acct-allow-form button[type="submit"]').click();
  await expect(panel.locator('.acct-row')).toHaveCount(2);

  await panel.locator('[data-allow-action="edit"]').first().click();
  await panel.locator('[data-allow-note-input]').fill('revised note');
  await panel.locator('[data-allow-action="save-edit"]').click();
  await expect.poll(() => mock.patches.length).toBe(1);
  // Kind and value are immutable server-side, so the request must carry neither.
  expect(mock.patches[0].body).toEqual({ note: 'revised note' });
});

test('identity triage lists unlinked logins and resolves a correlation ID', async ({ page }) => {
  await installAccountsAdminUiMock(page);
  await loginFromConsole(page);
  const panel = await openAccountsSection(page, 'triage');

  await expect(panel.locator('.acct-row')).toHaveCount(2); // header + one unlinked identity
  await expect(panel.locator('.acct-row').nth(1)).toContainText('octocat');

  await panel.locator('[name="correlation_id"]').fill('corr-1');
  await panel.locator('#acct-correlation-form button[type="submit"]').click();
  await expect(panel.locator('.acct-detail')).toContainText('e2e_admin');
});

test('bootstrap status reports that the first-administrator path is closed', async ({ page }) => {
  await installAccountsAdminUiMock(page);
  await loginFromConsole(page);
  const panel = await openAccountsSection(page, 'bootstrap');
  await expect(panel.locator('.acct-card')).toContainText('one-time first-administrator path is closed');
});

test('a malformed authorization parameter is rejected before anything is saved', async ({ page }) => {
  await includeManifestRoutes(page, INTEGRATION_ROUTES);
  const mock = await installIntegrationsUiMock(page);
  await loginFromConsole(page);

  await page.locator(INTEGRATIONS_TAB).click();
  await page.locator('[data-int-view="descriptors"]').click();
  await page.locator('[data-descriptor-create]').click();

  await page.locator('[name="display_name"]').fill('Param Check');
  await page.locator('[name="provider"]').fill('param-check');
  await page.locator('[name="category"]').fill('Testing');
  await page.locator('[name="api_hosts"]').fill('api.param-check.test');
  await page.locator('[name="oauth_client_id"]').fill('param-client');
  await page.locator('[name="oauth_authorization_url"]').fill('https://auth.param-check.test/authorize');
  await page.locator('[name="oauth_token_url"]').fill('https://auth.param-check.test/token');

  await page.locator('.int-auth-advanced > summary').click();
  const params = page.locator('[name="oauth_authorization_params"]');
  await params.fill('audience=https://api.param-check.test\nprompt');
  await page.locator('#int-descriptor-form button[type="submit"]').click();

  // Rejected in the browser: the operator is told which line is wrong and nothing reaches the API.
  await expect(page.locator('#int-descriptor-form [data-form-error]')).toContainText('name=value');
  expect(mock.descriptorWrites).toBe(0);

  // The same form saves once the line is well-formed, so the guard isn't rejecting valid input.
  await params.fill('audience=https://api.param-check.test\nprompt=consent');
  await page.locator('#int-descriptor-form button[type="submit"]').click();
  await expect(page.locator(INTEGRATION_DESCRIPTOR_CARD, { hasText: 'Param Check' })).toBeVisible();
  expect(mock.descriptorWrites).toBe(1);
});

test('selecting discovered operations promotes them without disturbing the remote MCP settings', async ({ page }) => {
  await includeManifestRoutes(page, INTEGRATION_ROUTES);
  const mock = await installIntegrationsUiMock(page);
  // Pre-existing remote MCP config on the same descriptor: promoting operations sends the whole
  // operation_promotion object, so this is what a partial write would silently drop.
  const remoteMcp = { serverUrl: 'https://api.acme.test/mcp', tools: ['search'] };
  const seeded = mock.descriptors.find(item => item.provider === 'acme-tasks');
  if (!seeded) throw new Error('The acme-tasks descriptor is missing from the mock seed.');
  seeded.operation_promotion = { remoteMcp };
  // Two operations, so selecting one proves only that one is promoted.
  mock.operations = [
    { operation_id: 'listTasks', method: 'GET', path: '/tasks', read_write_class: 'read', summary: 'List tasks', description: null, required_scopes: [] },
    { operation_id: 'createTask', method: 'POST', path: '/tasks', read_write_class: 'write', summary: 'Create a task', description: null, required_scopes: [] },
  ];
  await loginFromConsole(page);

  await page.locator(INTEGRATIONS_TAB).click();
  await page.locator('[data-int-view="descriptors"]').click();
  await page.locator(INTEGRATION_DESCRIPTOR_CARD, { hasText: 'Acme Tasks' })
    .locator('[data-descriptor-spec]').click();

  await setTextInputFile(page, '[name="spec_file"]', {
    name: 'acme.openapi.yaml',
    mimeType: 'application/yaml',
    content: [
      'openapi: 3.0.3',
      'info:',
      '  title: Acme API',
      '  version: 1.0.0',
      'paths:',
      '  /tasks:',
      '    get:',
      '      operationId: listTasks',
      '      responses:',
      "        '200':",
      '          description: OK',
    ].join('\n'),
  });
  await page.locator('#int-spec-form button[type="submit"]').click();
  await expect(page.locator(INTEGRATION_OPERATION_ROW)).toHaveCount(2);

  // Nothing is promoted until the operator chooses, so both start unticked.
  const listTasks = page.locator(INTEGRATION_OPERATION_ROW, { hasText: 'listTasks' }).locator('input[type="checkbox"]');
  await expect(listTasks).not.toBeChecked();
  await listTasks.check();
  await page.locator('#int-promotion-form button[type="submit"]').click();

  await expect.poll(() => mock.descriptors.find(item => item.provider === 'acme-tasks')?.operation_promotion)
    .toEqual({ remoteMcp, operations: ['listTasks'] });

  // Re-opening reflects the stored selection rather than resetting it.
  await page.locator('[data-descriptor-back]').first().click();
  await page.locator(INTEGRATION_DESCRIPTOR_CARD, { hasText: 'Acme Tasks' })
    .locator('[data-descriptor-spec]').click();
  await expect(page.locator(INTEGRATION_OPERATION_ROW, { hasText: 'listTasks' }).locator('input[type="checkbox"]')).toBeChecked();
  await expect(page.locator(INTEGRATION_OPERATION_ROW, { hasText: 'createTask' }).locator('input[type="checkbox"]')).not.toBeChecked();
});

test('portfolio imports a reviewed file without silently overwriting a duplicate', async ({ page }) => {
  const mock = await installPortfolioUiMock(page);
  await loginFromConsole(page);
  const file = {
    name: 'imported-skill.md',
    mimeType: 'text/markdown',
    content: `---
name: Imported Skill
type: skill
description: Imported from a local Dollhouse file.
tags:
  - imported
  - browser
custom_policy: reviewed
---

Follow the reviewed skill instructions.`,
  };

  await page.locator('#pf-import').click();
  await expect(page.locator('[data-import-drop]')).toBeVisible();
  await setTextInputFile(page, '[data-import-file]', file);
  await expect(page.locator('[data-import-source]')).toContainText('Skill detected');
  await expect(page.locator('[name="type"][value="skills"]')).toBeChecked();
  await expect(page.locator('.portfolio-editor [name="name"]')).toHaveValue('Imported Skill');
  await expect(page.locator('.portfolio-editor [name="description"]')).toHaveValue('Imported from a local Dollhouse file.');
  await expect.poll(async () => (await page.locator(EDITOR_INSTRUCTIONS).inputValue()).trim())
    .toBe('Follow the reviewed skill instructions.');
  await expect(page.locator(EDITOR_CONTENT)).toHaveValue('');
  await expect(page.locator('[data-custom-metadata-notice]')).toContainText('1 additional metadata field');
  await expect(page.locator('[data-custom-metadata-notice]')).toContainText('will be preserved');
  await expect(page.locator(EDITOR_METADATA)).toHaveValue(/"custom_policy": "reviewed"/u);
  await page.locator(EDITOR_VALIDATE).click();
  await expect(page.locator(EDITOR_FEEDBACK)).toContainText('ready to save');
  await page.locator(EDITOR_SUBMIT).click();
  await expect(page.locator('[data-name="Imported Skill"]')).toBeVisible();
  expect(mock.elements.filter(item => item.type === 'skills' && item.name === 'Imported Skill')).toHaveLength(1);
  expect(mock.elements.find(item => item.type === 'skills' && item.name === 'Imported Skill')?.metadata.custom_policy)
    .toBe('reviewed');

  await page.locator('#pf-import').click();
  await setTextInputFile(page, '[data-import-file]', file);
  await page.locator(EDITOR_SUBMIT).click();
  await expect(page.locator(EDITOR_FEEDBACK)).toContainText('Nothing was overwritten');
  expect(mock.elements.filter(item => item.type === 'skills' && item.name === 'Imported Skill')).toHaveLength(1);

  await page.locator('.portfolio-editor [data-editor-close]').last().click();
  await page.locator('#portfolio-confirm [data-confirm="1"]').click();
  await expect(page.locator(AUTHORING_WORKSPACE)).toBeHidden();
  await expect(page.locator('#pf-grid')).toBeVisible();
});

test('portfolio import keeps legacy instructions but strips internal extensions', async ({ page }) => {
  const mock = await installPortfolioUiMock(page);
  await loginFromConsole(page);
  const file = {
    name: 'legacy-agent.json',
    mimeType: 'application/json',
    content: JSON.stringify({
      type: 'agent',
      name: 'legacy-extension-agent',
      content: '',
      metadata: {
        description: 'An agent imported from a legacy JSON export.',
        custom_policy: 'preserve this',
        goal: {
          template: 'Review {topic} and report findings.',
          parameters: [],
        },
      },
      extensions: {
        instructions: 'Use the imported legacy operating instructions.',
        runtime_state: 'do not import',
      },
    }),
  };

  await page.locator('#pf-import').click();
  await setTextInputFile(page, '[data-import-file]', file);
  await expect(page.locator('[name="type"][value="agents"]')).toBeChecked();
  await expect(page.locator(EDITOR_INSTRUCTIONS)).toHaveValue('Use the imported legacy operating instructions.');
  await expect(page.locator(EDITOR_METADATA)).toHaveValue(/"custom_policy": "preserve this"/u);
  await expect(page.locator(EDITOR_METADATA)).not.toHaveValue(/extensions|runtime_state/u);
  await expect(page.locator('[data-custom-metadata-notice]')).toContainText('1 additional metadata field');
  await page.locator(EDITOR_SUBMIT).click();
  await expect(page.locator('[data-name="legacy-extension-agent"]')).toBeVisible();

  const imported = mock.elements.find(item => item.name === 'legacy-extension-agent');
  expect(imported?.metadata.custom_policy).toBe('preserve this');
  expect(imported?.metadata.instructions).toBe('Use the imported legacy operating instructions.');
  expect(imported?.metadata).not.toHaveProperty('extensions');
});

test('portfolio create cancel leaves the workspace without saving', async ({ page }) => {
  await installPortfolioUiMock(page);
  await loginFromConsole(page);

  await page.locator(PORTFOLIO_CREATE).click();
  await page.locator('.portfolio-editor [data-editor-close]').last().click();
  await expect(page.locator(AUTHORING_WORKSPACE)).toBeHidden();
  await expect(page.locator('#pf-grid')).toBeVisible();
});

test('portfolio editor stays blocked when conflict reload omits its ETag', async ({ page }) => {
  await installPortfolioUiMock(page, { conflictOnFirstPatch: true, omitEtagAfterConflict: true });
  await loginFromConsole(page);

  await page.locator('[data-name="alpha-persona"] [data-action="edit"]').click();
  await page.locator(EDITOR_CONTENT).fill('Draft that must not overwrite newer content.');
  await page.locator(EDITOR_SUBMIT).click();
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
  await expect(page.locator('#pf-create, #pf-import, #pf-sync, [data-action="edit"]')).toHaveCount(0);
  await page.locator('[data-name="alpha-persona"]').click();
  await expect(page.locator('.modal-edit-btn')).toBeHidden();
  await expect(page.locator('.modal-delete-btn')).toBeHidden();
});

test('operations remains usable when a partial deployment omits health', async ({ page }) => {
  await installOperationsUiMock(page);
  await filterManifestRoutes(page, new Set([
    'GET /api/v1/admin/operate/health',
    'PUT /api/v1/admin/operate/config/:key',
  ]));
  await loginFromConsole(page);

  await setElevation(page, ['console:admin:operate']);
  await expect(page.locator(OPERATIONS_TAB)).toBeVisible();
  await page.locator(OPERATIONS_TAB).click();
  await expect(page.locator(OPERATIONS_HEALTH_NAV)).toHaveCount(0);
  await expect(page.locator(OPERATIONS_CONFIG_NAV)).toBeVisible();
  await page.locator(OPERATIONS_CONFIG_NAV).click();
  await expect(page.locator(ENABLED_CONFIG_FORM)).toBeVisible();
  await expect(page.locator(ENABLED_CONFIG_FORM)).toContainText('Not writable in this deployment');
  await expect(page.locator(`${ENABLED_CONFIG_FORM} select`)).toBeDisabled();
});

test('operations requires its capability and stops polling when privilege or visibility is lost', async ({ page }) => {
  const mock = await installOperationsUiMock(page);
  await loginFromConsole(page);

  await setElevation(page, ['console:admin:accounts']);
  await expect(page.locator(OPERATIONS_TAB)).toBeHidden();

  await page.clock.install();
  await openMockOperations(page);
  await expect.poll(() => mock.healthReads).toBeGreaterThan(0);
  const beforeStepDown = mock.healthReads;
  await setElevation(page, [], false);
  await page.clock.fastForward(11_000);
  expect(mock.healthReads, 'step-down aborts and stops operator polling').toBe(beforeStepDown);

  await openMockOperations(page);
  await expect.poll(() => mock.healthReads).toBeGreaterThan(beforeStepDown);
  const beforeHidden = mock.healthReads;
  await page.evaluate(() => {
    Object.defineProperty(globalThis.document, 'hidden', { configurable: true, value: true });
    globalThis.document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(11_000);
  expect(mock.healthReads, 'background tabs do not poll operator routes').toBe(beforeHidden);
});

test('operator configuration preserves sibling drafts, per-setting concurrency, badges, and secret privacy', async ({ page }) => {
  const mock = await installOperationsUiMock(page, { conflictOnFirstConfigWrite: false });
  await loginFromConsole(page);
  await openMockOperations(page);
  await page.locator(OPERATIONS_CONFIG_NAV).click();

  const enabled = page.locator(ENABLED_CONFIG_FORM);
  const sibling = page.locator('[data-config-form="enhanced_index.max_cache_entries"]');
  const license = page.locator('[data-config-form="license.key"]');
  await expect(enabled).toContainText('Dynamic');
  await expect(enabled).toContainText('effective');
  await expect(license).toContainText('Restart pending');
  await expect(license).toContainText('not effective until restart');
  await expect(page.locator('[data-config-form="private.feature_enabled"] select')).toHaveValue('');
  await expect(page.locator('[data-config-form="private.provider_options"] textarea')).toHaveValue('');
  await expect(page.locator('#tab-operations')).not.toContainText(OPERATIONS_PRIVATE_MARKER);

  await sibling.locator('input[name="value"]').fill('2048');
  await enabled.locator('select[name="value"]').selectOption('false');
  await enabled.locator(SUBMIT_BUTTON).click();
  await expect.poll(() => mock.configWrites).toBe(1);
  await expect(sibling.locator('input[name="value"]')).toHaveValue('2048');
  await sibling.locator(SUBMIT_BUTTON).click();
  await expect.poll(() => mock.configWrites).toBe(2);
  expect(mock.maxCacheEntries).toBe(2048);
  await expect(sibling.locator('[data-config-feedback]')).not.toContainText('changed elsewhere');
});

test('operator configuration restarts loading after rapid section navigation', async ({ page }) => {
  const mock = await installOperationsUiMock(page, { configListDelayMs: 500 });
  await loginFromConsole(page);
  await openMockOperations(page);
  await page.locator(OPERATIONS_CONFIG_NAV).click();
  await expect.poll(() => mock.configReads).toBe(1);

  await page.locator(OPERATIONS_HEALTH_NAV).click();
  await page.locator(OPERATIONS_CONFIG_NAV).click();

  await expect.poll(() => mock.configReads).toBe(2);
  await expect(page.locator(ENABLED_CONFIG_FORM)).toBeVisible();
});

test('operations refresh includes embedded metrics and section changes stop its auto-refresh', async ({ page }) => {
  const mock = await installOperationsUiMock(page);
  await loginFromConsole(page);
  await openMockOperations(page);
  await page.clock.install();
  await page.locator('[data-operations-nav="metrics"]').click();
  await expect.poll(() => mock.metricsReads).toBeGreaterThan(0);
  await expect.poll(() => mock.systemMetricsReads).toBeGreaterThan(0);

  const operationalBeforeRefresh = mock.metricsReads;
  const systemBeforeRefresh = mock.systemMetricsReads;
  await page.locator('#operations-refresh').click();
  await expect.poll(() => mock.metricsReads).toBeGreaterThan(operationalBeforeRefresh);
  await expect.poll(() => mock.systemMetricsReads).toBeGreaterThan(systemBeforeRefresh);

  await page.locator('#am-auto').check();
  await page.locator(OPERATIONS_HEALTH_NAV).click();
  const systemBeforeSectionChange = mock.systemMetricsReads;
  await page.clock.fastForward(11_000);
  expect(mock.systemMetricsReads, 'embedded metrics stop when their Operations section is hidden').toBe(systemBeforeSectionChange);
});

test('embedded system metrics refresh once when returning to Operations', async ({ page }) => {
  const mock = await installOperationsUiMock(page);
  await loginFromConsole(page);
  await openMockOperations(page);
  await page.locator('[data-operations-nav="metrics"]').click();
  await expect.poll(() => mock.systemMetricsReads).toBeGreaterThan(0);

  await page.locator('.console-tab[data-tab="portfolio"]').click();
  const readsBeforeReturn = mock.systemMetricsReads;
  await page.locator(OPERATIONS_TAB).click();
  await expect.poll(() => mock.systemMetricsReads).toBe(readsBeforeReturn + 1);
  await page.waitForTimeout(100);
  expect(mock.systemMetricsReads, 'the parent lifecycle performs only one refresh').toBe(readsBeforeReturn + 1);
});

test('operations retains the last session snapshot through a transient refresh failure', async ({ page }) => {
  const mock = await installOperationsUiMock(page);
  await loginFromConsole(page);
  await openMockOperations(page);
  await page.locator(OPERATIONS_SESSIONS_NAV).click();
  await expect(page.locator(OPERATIONAL_SESSION_CARD)).toBeVisible();

  mock.failNextSessionRead = true;
  await page.locator('#operations-refresh').click();
  await expect(page.locator('[data-session-list-warning]')).toContainText('last successful snapshot');
  await expect(page.locator(OPERATIONAL_SESSION_CARD)).toBeVisible();
});

test('session termination acknowledgements stay bound to their originating session', async ({ page }) => {
  const mock = await installOperationsUiMock(page, { includeSecondSession: true });
  await loginFromConsole(page);
  await openMockOperations(page);
  await page.locator(OPERATIONS_SESSIONS_NAV).click();
  await page.locator(OPERATIONAL_SESSION_CARD).first().click();
  await page.locator('[data-operational-session-terminate]').click();
  await page.locator(CONFIRM_ACTION).click();
  await expect.poll(() => mock.commandReads).toBe(1);

  await page.locator(`[data-operational-session-id="${SECOND_OPERATIONAL_SESSION_ID}"]`).click();
  await expect(page.locator('[data-operational-session-detail]')).toContainText('Second Browser Client');
  await page.waitForTimeout(700);
  await expect(page.locator('[data-operational-command-status]')).toBeEmpty();
  await expect(page.locator(`[data-operational-session-id="${SECOND_OPERATIONAL_SESSION_ID}"]`)).toBeVisible();
});

for (const outcome of ['already_absent', 'failed'] as const) {
  test(`session termination renders the ${outcome} terminal outcome`, async ({ page }) => {
    await installOperationsUiMock(page, { commandOutcome: outcome });
    await loginFromConsole(page);
    await openMockOperations(page);
    await page.locator(OPERATIONS_SESSIONS_NAV).click();
    await page.locator(OPERATIONAL_SESSION_CARD).click();
    await page.locator('[data-operational-session-terminate]').click();
    await page.locator(CONFIRM_ACTION).click();

    const expected = outcome === 'already_absent' ? 'already absent' : 'Termination failed';
    await expect(page.locator('[data-operational-command-status]')).toContainText(expected);
  });
}

test('unavailable operator session detail uses a cross-user-neutral message', async ({ page }) => {
  await installOperationsUiMock(page, { detailUnavailable: true });
  await loginFromConsole(page);
  await openMockOperations(page);
  await page.locator(OPERATIONS_SESSIONS_NAV).click();
  await page.locator(OPERATIONAL_SESSION_CARD).click();

  await expect(page.locator('[data-operational-session-detail]')).toContainText('ended, expired, or is not available');
  await expect(page.locator('[data-operational-session-detail]')).not.toContainText('another account');
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
  await Promise.all([page.waitForLoadState('networkidle'), page.click(SUBMIT_BUTTON)]);

  // 4. STEP-UP for the operate capability (may re-prompt password, then TOTP)
  await stepUpWithTotp(page, totp);

  // 5. ADMIN now reachable with fresh elevation
  expect(await status(page, OPERATE), 'admin reachable after step-up').toBe(200);

  // The Users surface gets its role list and grants from /me/role-catalog.
  const catalogResponse = await page.request.get(`${BASE_URL}/api/v1/me/role-catalog`);
  const catalog = await catalogResponse.json() as { roles: string[] };
  const operationsMock = await installOperationsUiMock(page);
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
  await page.locator('#ua-drawer-close').click();
  await expect(page.locator(USER_DRAWER)).toHaveCount(0);

  // The Operations workspace keeps configuration concurrency-safe, renders
  // only allowlisted telemetry, and follows async runtime termination to ack.
  await page.locator(OPERATIONS_TAB).click();
  await expect(page.locator('[data-operations-panel="health"]')).toContainText('Degraded');
  await expect(page.locator('[data-operations-panel="health"]')).toContainText('runtime_ack_delayed');

  await page.locator(OPERATIONS_CONFIG_NAV).click();
  const configForm = page.locator(ENABLED_CONFIG_FORM);
  await expect(page.locator('[data-config-form="license.key"] input')).toHaveValue('');
  await configForm.locator('select[name="value"]').selectOption('false');
  await configForm.locator(SUBMIT_BUTTON).click();
  await expect(configForm.locator('[data-config-feedback]')).toContainText('changed elsewhere');
  expect(operationsMock.configWrites).toBe(0);
  await configForm.locator('[data-config-reload]').click();
  await page.locator(`${ENABLED_CONFIG_FORM} select[name="value"]`).selectOption('false');
  await page.locator(`${ENABLED_CONFIG_FORM} button[type="submit"]`).click();
  await expect.poll(() => operationsMock.configWrites).toBe(1);
  expect(operationsMock.configValue).toBe(false);

  await page.locator('[data-operations-nav="logs"]').click();
  await expect(page.locator('[data-operational-log-body]')).toContainText('runtime.command.delayed');
  await expect(page.locator('#tab-operations')).not.toContainText(OPERATIONS_PRIVATE_MARKER);

  await page.locator('[data-operations-nav="metrics"]').click();
  await expect(page.locator('[data-operational-metrics-body]')).toContainText('runtime.commands.pending');
  await expect(page.locator('[data-system-metrics]')).toContainText('cache.hits');

  await page.locator(OPERATIONS_SESSIONS_NAV).click();
  await page.locator(OPERATIONAL_SESSION_CARD).click();
  await expect(page.locator('[data-operational-session-detail]')).toContainText('replica-browser');
  await expect(page.locator('#tab-operations')).not.toContainText(OPERATIONS_PRIVATE_MARKER);
  await page.locator('[data-operational-session-terminate]').click();
  await page.locator(CONFIRM_ACTION).click();
  await expect(page.locator('[data-operational-command-status]')).toContainText('acknowledged termination');
  expect(operationsMock.commandReads).toBeGreaterThanOrEqual(2);
  expect(operationsMock.terminated).toBe(true);

  // Reopen the Users drawer so step-down proves that both privileged
  // workspaces are torn down, not merely hidden.
  await page.locator('.console-tab[data-tab="users"]').click();
  await page.locator('[data-user-row]').first().click();
  await expect(page.locator(USER_DRAWER)).toBeVisible();

  // 6. STEP-DOWN destroys the open privileged drawer and hides both admin
  // panels even when no non-admin tab exists.
  await page.locator('#exit-btn').dispatchEvent('click');
  await expect(page.locator('#console-empty-state')).toBeVisible();
  await expect(page.locator('#tab-users')).toBeHidden();
  await expect(page.locator('.console-tab[data-tab="users"]')).toBeHidden();
  await expect(page.locator(USER_DRAWER)).toHaveCount(0);
  await expect(page.locator('#tab-operations')).toBeHidden();
  await expect(page.locator(OPERATIONS_TAB)).toBeHidden();
  await page.unroute('**/api/v1/admin/operate/**');
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
  await expect(page.locator(USER_DRAWER)).toBeVisible();
  await page.clock.fastForward(3_000);
  await expect(page.locator('#console-empty-state')).toBeVisible();
  await expect(page.locator('#tab-users')).toBeHidden();
  await expect(page.locator(USER_DRAWER)).toHaveCount(0);
  await page.unroute(AUTH_ME_URL);
  expect(await status(page, OPERATE), 'server remains elevated until explicit cleanup').toBe(200);
  expect(await csrfPost(page, '/api/v1/auth/step-down')).toBe(204);

  // 8. LOGOUT ends the session
  const logout = await csrfPost(page, '/api/v1/auth/logout');
  expect(logout).toBe(204);
  expect(await status(page, '/api/v1/auth/me'), 'session ended after logout').toBe(401);
});
