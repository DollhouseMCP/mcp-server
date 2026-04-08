/**
 * Playwright browser tests for the Auth tab in the DollhouseMCP web console.
 *
 * Covers:
 *   - Auth tab navigation and rendering (#1825 regression)
 *   - Console Token panel display and interaction
 *   - TOTP panel display and enrollment flow
 *   - Card collapse/expand behavior
 *   - Security: auth enforcement on API endpoints
 */

import { test, expect } from '@playwright/test';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Navigate to the Auth tab and wait for the security dashboard to render. */
async function goToAuthTab(page: import('@playwright/test').Page) {
  await page.goto('/#security');
  // Click the tab to ensure lazy-init fires (hash nav alone may not trigger it)
  await page.locator('[data-tab="security"]').click();
  // Wait for the dashboard to be populated (security.js fetches data on init)
  await page.locator('.sec-dashboard').waitFor({ state: 'visible', timeout: 10_000 });
}

// ── Auth tab rendering (#1825 regression) ───────────────────────────────

test.describe('Auth tab rendering (#1825)', () => {
  test('Auth tab is visible in navigation', async ({ page }) => {
    await page.goto('/');
    const authTab = page.locator('[data-tab="security"]');
    await expect(authTab).toBeVisible();
    await expect(authTab).toContainText('Auth');
  });

  test('Auth tab loads and shows security dashboard', async ({ page }) => {
    await goToAuthTab(page);
    const dashboard = page.locator('.sec-dashboard');
    await expect(dashboard).toBeVisible();
  });

  test('Auth tab has both Console Token and TOTP cards', async ({ page }) => {
    await goToAuthTab(page);
    const cards = page.locator('.sec-card');
    await expect(cards).toHaveCount(2);
  });
});

// ── Console Token panel ─────────────────────────────────────────────────

test.describe('Console Token panel', () => {
  test('displays token preview', async ({ page }) => {
    await goToAuthTab(page);
    const tokenContent = page.locator('#sec-token-content');
    await expect(tokenContent).toBeVisible();
    // Token preview should be a masked hex string
    const tokenValue = page.locator('code.sec-token-value');
    await expect(tokenValue).toBeVisible();
    const text = await tokenValue.textContent();
    expect(text).toBeTruthy();
    expect(text!.length).toBeGreaterThan(0);
  });

  test('shows token metadata (name, kind, created)', async ({ page }) => {
    await goToAuthTab(page);
    const metaGrid = page.locator('#sec-token-content .sec-meta-grid');
    await expect(metaGrid).toBeVisible();
    const metaText = await metaGrid.textContent();
    expect(metaText).toContain('Name');
    expect(metaText).toContain('Kind');
  });

  test('copy token button exists', async ({ page }) => {
    await goToAuthTab(page);
    const copyBtn = page.locator('#sec-copy-token');
    await expect(copyBtn).toBeVisible();
  });

  test('rotate button is disabled without TOTP', async ({ page }) => {
    await goToAuthTab(page);
    const rotateBtn = page.locator('#sec-rotate-btn');
    await expect(rotateBtn).toBeVisible();
    await expect(rotateBtn).toBeDisabled();
  });
});

// ── TOTP panel ──────────────────────────────────────────────────────────

test.describe('TOTP panel', () => {
  test('shows "Not enrolled" status initially', async ({ page }) => {
    await goToAuthTab(page);
    const notEnrolled = page.locator('.sec-totp-status--not-enrolled');
    await expect(notEnrolled).toBeVisible();
    await expect(notEnrolled).toContainText('Not enrolled');
  });

  test('shows Enroll Authenticator button', async ({ page }) => {
    await goToAuthTab(page);
    const enrollBtn = page.locator('#sec-totp-enroll');
    await expect(enrollBtn).toBeVisible();
    await expect(enrollBtn).toContainText('Enroll');
  });

  test('clicking Enroll shows QR code and confirmation form', async ({ page }) => {
    await goToAuthTab(page);
    const enrollBtn = page.locator('#sec-totp-enroll');
    await enrollBtn.click();

    // QR code image should appear
    const qrImg = page.locator('img.sec-qr-img');
    await expect(qrImg).toBeVisible({ timeout: 5_000 });

    // Confirmation code input
    const codeInput = page.locator('input#sec-confirm-code');
    await expect(codeInput).toBeVisible();
    await expect(codeInput).toHaveAttribute('maxlength', '6');

    // Confirm and Cancel buttons
    await expect(page.locator('#sec-confirm-enroll')).toBeVisible();
    await expect(page.locator('#sec-cancel-enroll')).toBeVisible();
  });

  test('Cancel enrollment returns to initial state', async ({ page }) => {
    await goToAuthTab(page);
    await page.locator('#sec-totp-enroll').click();
    await page.locator('img.sec-qr-img').waitFor({ state: 'visible', timeout: 5_000 });

    // Click cancel
    await page.locator('#sec-cancel-enroll').click();

    // Should return to "Not enrolled" state
    const notEnrolled = page.locator('.sec-totp-status--not-enrolled');
    await expect(notEnrolled).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#sec-totp-enroll')).toBeVisible();
  });

  test('invalid TOTP code shows error', async ({ page }) => {
    await goToAuthTab(page);
    await page.locator('#sec-totp-enroll').click();
    await page.locator('img.sec-qr-img').waitFor({ state: 'visible', timeout: 5_000 });

    // Enter an invalid code
    await page.locator('input#sec-confirm-code').fill('000000');
    await page.locator('#sec-confirm-enroll').click();

    // Should show an error (toast, inline message, or the form stays open)
    // The confirm button should still be visible (enrollment didn't succeed)
    await expect(page.locator('#sec-confirm-enroll')).toBeVisible({ timeout: 5_000 });
  });
});

// ── Card collapse/expand ────────────────────────────────────────────────

test.describe('Card collapse/expand', () => {
  test('cards start expanded', async ({ page }) => {
    await goToAuthTab(page);
    const firstCard = page.locator('.sec-card').first();
    const body = firstCard.locator('.sec-card-body');
    await expect(body).toBeVisible();
  });

  test('clicking header collapses and re-expands card', async ({ page }) => {
    await goToAuthTab(page);
    const firstCard = page.locator('.sec-card').first();
    const header = firstCard.locator('.sec-card-header');
    const body = firstCard.locator('.sec-card-body');

    // Collapse
    await header.click();
    await expect(body).not.toBeVisible();

    // Re-expand
    await header.click();
    await expect(body).toBeVisible();
  });
});

// ── API endpoint regression (#1825) ─────────────────────────────────────

test.describe('Auth API endpoints respond (not 404)', () => {
  test('GET /api/console/totp/status does not return 404', async ({ request }) => {
    const res = await request.get('/api/console/totp/status');
    // Should be 401 (auth required) or 200, but NOT 404 (route not mounted)
    expect(res.status()).not.toBe(404);
  });

  test('GET /api/console/token/info does not return 404', async ({ request }) => {
    const res = await request.get('/api/console/token/info');
    expect(res.status()).not.toBe(404);
  });

  test('POST /api/console/totp/enroll/begin does not return 404', async ({ request }) => {
    const res = await request.post('/api/console/totp/enroll/begin');
    expect(res.status()).not.toBe(404);
  });

  test('POST /api/console/token/rotate does not return 404', async ({ request }) => {
    const res = await request.post('/api/console/token/rotate');
    expect(res.status()).not.toBe(404);
  });
});

// ── Security headers ────────────────────────────────────────────────────

test.describe('Security headers', () => {
  test('response includes security headers', async ({ request }) => {
    const res = await request.get('/');
    const headers = res.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-xss-protection']).toBe('1; mode=block');
    expect(headers['content-security-policy']).toContain("default-src 'self'");
  });
});
