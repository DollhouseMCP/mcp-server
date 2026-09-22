import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import express from 'express';
import { expect, test } from '@playwright/test';
import { createOnboardingClaimPageRouter } from '../../../../dist/invitations/onboarding/OnboardingClaimPage.js';

// No page.route/fetch mock: only the browser may construct Origin and Referer.
// This isolates the browser policy from PostgreSQL and external providers.
test('bootstraps with its real Origin and no Referer under the claim page privacy policy', async ({ page }) => {
  const observed: Array<{ origin: string | undefined; referrer: string | undefined }> = [];
  const app = express();
  let origin = '';
  app.use(createOnboardingClaimPageRouter('support@example.test'));
  app.post('/auth/onboarding/bootstrap', express.json({ limit: '1kb' }), (req, res) => {
    observed.push({ origin: req.headers.origin, referrer: req.headers.referer });
    if (req.headers.origin !== origin) { res.status(403).json({ error: 'onboarding_request_rejected' }); return; }
    res.set('Cache-Control', 'no-store').json({ state: 'ready', csrfToken: 'synthetic-csrf' });
  });
  const server = createServer({
    key: readFileSync('tests/fixtures/tls/pinned-outbound/address-key.pem'),
    cert: readFileSync('tests/fixtures/tls/pinned-outbound/address-cert.pem'),
  }, app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    origin = `https://127.0.0.1:${address.port}`;
    const response = await page.goto(`${origin}/auth/onboarding/invitation#token=synthetic-invitation`);
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    expect(response?.headers()['content-security-policy']).toContain("connect-src 'self'");
    await expect(page.locator('#claim-status')).toContainText('Continue to verify');
    expect(observed).toEqual([{ origin, referrer: undefined }]);
    expect(page.url()).toBe(`${origin}/auth/onboarding/invitation`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
