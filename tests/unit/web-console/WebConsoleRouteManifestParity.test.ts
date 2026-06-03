import { describe, expect, it } from '@jest/globals';

import type { DiContainerFacade } from '../../../src/di/DiContainerFacade.js';
import { WebConsoleRegistrar } from '../../../src/web-console/WebConsoleRegistrar.js';

const TEST_PUBLIC_BASE_URL = 'https://console.example.test';

class TestContainer implements DiContainerFacade {
  readonly factories = new Map<string, () => unknown>();
  readonly values = new Map<string, unknown>();

  register<T>(name: string, factory: () => T): void {
    this.factories.set(name, factory);
  }

  resolve<T>(name: string): T {
    if (this.values.has(name)) return this.values.get(name) as T;
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Service not registered: ${name}`);
    const value = factory();
    this.values.set(name, value);
    return value as T;
  }

  hasRegistration(name: string): boolean {
    return this.values.has(name) || this.factories.has(name);
  }
}

function fakeConsoleOAuthClient() {
  return {
    createAuthorizationUrl: () => 'https://as.example.test/authorize',
    exchangeAuthorizationCode: () => Promise.resolve({
      sub: 'auth-subject',
      displayName: 'Test User',
    }),
  };
}

const CONTRACT_ROUTES = [
  'GET /api/v1/auth/login',
  'GET /api/v1/auth/callback',
  'POST /api/v1/auth/logout',
  'GET /api/v1/auth/me',
  'GET /api/v1/auth/step-up',
  'GET /api/v1/auth/step-up/callback',
  'POST /api/v1/auth/step-down',
  'GET /api/v1/me/profile',
  'PATCH /api/v1/me/profile',
  'GET /api/v1/me/settings',
  'GET /api/v1/me/settings/:key',
  'PUT /api/v1/me/settings/:key',
  'DELETE /api/v1/me/settings/:key',
  'GET /api/v1/me/integrations',
  'GET /api/v1/me/integrations/github',
  'POST /api/v1/me/integrations/github/connect',
  'GET /api/v1/me/integrations/github/callback',
  'DELETE /api/v1/me/integrations/github',
  'GET /api/v1/me/logs',
  'GET /api/v1/me/portfolio',
  'GET /api/v1/me/portfolio/elements',
  'GET /api/v1/me/portfolio/elements/:type/:name',
  'POST /api/v1/me/portfolio/elements/:type',
  'PATCH /api/v1/me/portfolio/elements/:type/:name',
  'DELETE /api/v1/me/portfolio/elements/:type/:name',
  'POST /api/v1/me/portfolio/elements/:type/:name/validate',
  'POST /api/v1/me/portfolio/elements/:type/:name/render',
  'POST /api/v1/me/portfolio/sync',
  'GET /api/v1/me/portfolio/sync/:job_id',
  'GET /api/v1/me/sessions',
  'GET /api/v1/me/sessions/:session_id',
  'DELETE /api/v1/me/sessions/:session_id',
  'POST /api/v1/me/sessions/revoke-all',
  'GET /api/v1/me/sessions/:session_id/activations',
  'POST /api/v1/me/sessions/:session_id/activations',
  'DELETE /api/v1/me/sessions/:session_id/activations/:type/:name',
  'GET /api/v1/me/sessions/:session_id/approvals',
  'POST /api/v1/me/sessions/:session_id/approvals/:approval_id/approve',
  'POST /api/v1/me/sessions/:session_id/approvals/:approval_id/deny',
  'GET /api/v1/me/sessions/:session_id/executions',
  'GET /api/v1/me/sessions/:session_id/executions/:goal_id',
  'GET /api/v1/me/sessions/:session_id/executions/:goal_id/stream',
  'GET /api/v1/me/sessions/:session_id/gatekeeper',
  'GET /api/v1/me/sessions/:session_id/logs',
  'GET /api/v1/me/sessions/:session_id/logs/stream',
  'GET /api/v1/me/sessions/:session_id/metrics',
  'GET /api/v1/me/sessions/:session_id/metrics/stream',
  'GET /api/v1/me/security/factors',
  'GET /api/v1/me/security/factors/enroll/totp',
  'GET /api/v1/me/security/factors/disable/totp',
  'GET /api/v1/me/security/sessions',
  'DELETE /api/v1/me/security/sessions/:session_id',
  'POST /api/v1/me/security/sessions/revoke-all-others',
  'GET /api/v1/admin/accounts/users',
  'GET /api/v1/admin/accounts/users/:user_id',
  'GET /api/v1/admin/accounts/correlations/:account_correlation_id',
  'POST /api/v1/admin/accounts/users/invite',
  'POST /api/v1/admin/accounts/users/:user_id/disable',
  'POST /api/v1/admin/accounts/users/:user_id/enable',
  'GET /api/v1/admin/accounts/users/:user_id/sessions',
  'DELETE /api/v1/admin/accounts/users/:user_id/sessions/:session_id',
  'POST /api/v1/admin/accounts/users/:user_id/sessions/revoke-all',
  'POST /api/v1/admin/accounts/users/:user_id/credentials/revoke-all',
  'GET /api/v1/admin/accounts/users/:user_id/roles',
  'PUT /api/v1/admin/accounts/users/:user_id/roles',
  'POST /api/v1/admin/accounts/users/:user_id/roles/grant',
  'POST /api/v1/admin/accounts/users/:user_id/roles/revoke',
  'GET /api/v1/admin/accounts/allowlist',
  'GET /api/v1/admin/accounts/allowlist/:id',
  'POST /api/v1/admin/accounts/allowlist',
  'PATCH /api/v1/admin/accounts/allowlist/:id',
  'DELETE /api/v1/admin/accounts/allowlist/:id',
  'GET /api/v1/admin/accounts/bootstrap',
  'GET /api/v1/admin/operate/config',
  'GET /api/v1/admin/operate/config/:key',
  'PUT /api/v1/admin/operate/config/:key',
  'GET /api/v1/admin/operate/health',
  'GET /api/v1/admin/operate/health/database',
  'GET /api/v1/admin/operate/health/auth-server',
  'GET /api/v1/admin/operate/health/gatekeeper',
  'GET /api/v1/admin/operate/sessions',
  'GET /api/v1/admin/operate/sessions/:session_id',
  'DELETE /api/v1/admin/operate/sessions/:session_id',
  'GET /api/v1/admin/operate/logs',
  'GET /api/v1/admin/operate/logs/stream',
  'GET /api/v1/admin/operate/metrics',
  'GET /api/v1/admin/operate/metrics/stream',
  'GET /api/v1/admin/audit/admin',
  'GET /api/v1/admin/audit/admin/:id',
  'GET /api/v1/admin/audit/admin/export',
  'GET /api/v1/admin/audit/approvals',
  'GET /api/v1/admin/audit/approvals/:id',
  'GET /api/v1/admin/audit/authentication',
  'GET /api/v1/admin/security/signing-keys',
  'GET /api/v1/admin/security/signing-keys/:kind',
  'POST /api/v1/admin/security/signing-keys/:kind/rotate',
  'POST /api/v1/admin/security/signing-keys/:kind/:kid/retire',
  'DELETE /api/v1/admin/security/signing-keys/:kind/:kid',
  'GET /api/v1/admin/security/signing-keys/jobs/:id',
  'GET /api/v1/admin/security/auth-policy',
  'PUT /api/v1/admin/security/auth-policy',
  'POST /api/v1/admin/security/users/:user_id/factors/totp/reset',
  'GET /api/v1/health',
  'GET /api/v1/health/ready',
].sort();

describe('web-console route manifest parity', () => {
  it('matches the v1 API contract route list when all descriptor feature gates are enabled', async () => {
    const composition = await new WebConsoleRegistrar({
      opaqueValueHmacKey: Buffer.alloc(32, 32),
      secretEncryptionKey: {
        keyId: 'manifest-test',
        key: Buffer.alloc(32, 33),
      },
      consoleOAuthClient: fakeConsoleOAuthClient(),
      publicBaseUrl: TEST_PUBLIC_BASE_URL,
      enableAccountAllowlistRoutes: true,
      enablePortfolioWriteRoutes: true,
      registerCleanup: false,
    }).bootstrapAndRegister(new TestContainer());

    const manifestRoutes = composition.registry.createRouteManifest().routes
      .map(route => `${route.method} ${route.path}`)
      .sort();
    expect(manifestRoutes).toEqual(CONTRACT_ROUTES);
  });
});
