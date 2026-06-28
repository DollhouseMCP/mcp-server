/**
 * Proves the curated-integration wiring end-to-end through a real WebConsoleRegistrar:
 * a descriptor seed file is loaded at bootstrap, a provider is built from it, and the
 * generic /api/v1/me/integrations/{provider} routes are registered as a result. This is
 * the Part A counterpart to the static route-manifest parity test.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
    exchangeAuthorizationCode: () => Promise.resolve({ sub: 'auth-subject', displayName: 'Test User' }),
  };
}

const tempDirs: string[] = [];
const envKeys: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
  while (envKeys.length > 0) {
    const key = envKeys.pop();
    if (key) delete process.env[key];
  }
});

async function seedDirWith(name: string, descriptor: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'curated-routes-'));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, name), JSON.stringify(descriptor), 'utf8');
  return dir;
}

async function manifestFor(seedDir: string): Promise<string[]> {
  const composition = await new WebConsoleRegistrar({
    opaqueValueHmacKey: Buffer.alloc(32, 32),
    secretEncryptionKey: { keyId: 'curated-routes-test', key: Buffer.alloc(32, 33) },
    consoleOAuthClient: fakeConsoleOAuthClient(),
    publicBaseUrl: TEST_PUBLIC_BASE_URL,
    integrationDescriptorSeedDir: seedDir,
    registerCleanup: false,
  }).bootstrapAndRegister(new TestContainer());
  return composition.registry.createRouteManifest().routes.map(route => `${route.method} ${route.path}`);
}

describe('curated integration route registration', () => {
  it('registers status/connect/disconnect (no callback) for a seeded static-API-key provider', async () => {
    const dir = await seedDirWith('staticprovider.json', {
      provider: 'staticprovider',
      displayName: 'Static Provider',
      category: 'Data',
      authStrategy: 'static_api_key',
      apiHosts: ['api.staticprovider.test'],
      staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null } },
    });

    const routes = await manifestFor(dir);
    expect(routes).toContain('GET /api/v1/me/integrations/staticprovider');
    expect(routes).toContain('POST /api/v1/me/integrations/staticprovider/connect');
    expect(routes).toContain('DELETE /api/v1/me/integrations/staticprovider');
    // A static API key strategy has no OAuth callback.
    expect(routes).not.toContain('GET /api/v1/me/integrations/staticprovider/callback');
  });

  it('registers the full route set including callback for a seeded OAuth provider with deployment credentials', async () => {
    process.env.DOLLHOUSE_INTEGRATION_OAUTHPROVIDER_CLIENT_ID = 'deployment-client-id';
    process.env.DOLLHOUSE_INTEGRATION_OAUTHPROVIDER_CLIENT_SECRET = 'deployment-secret';
    envKeys.push('DOLLHOUSE_INTEGRATION_OAUTHPROVIDER_CLIENT_ID', 'DOLLHOUSE_INTEGRATION_OAUTHPROVIDER_CLIENT_SECRET');

    const dir = await seedDirWith('oauthprovider.json', {
      provider: 'oauthprovider',
      displayName: 'OAuth Provider',
      category: 'Productivity',
      authStrategy: 'oauth2_authorization_code',
      apiHosts: ['api.oauthprovider.test'],
      oauth: {
        authorizationUrl: 'https://auth.oauthprovider.test/authorize',
        tokenUrl: 'https://auth.oauthprovider.test/token',
        scopes: ['read'],
        pkce: 'required',
        refresh: 'rotating',
        tokenExchange: {},
        accountLabel: {},
      },
    });

    const routes = await manifestFor(dir);
    expect(routes).toContain('GET /api/v1/me/integrations/oauthprovider');
    expect(routes).toContain('POST /api/v1/me/integrations/oauthprovider/connect');
    expect(routes).toContain('GET /api/v1/me/integrations/oauthprovider/callback');
    expect(routes).toContain('DELETE /api/v1/me/integrations/oauthprovider');
  });

  it('skips a seeded OAuth provider whose deployment credentials are absent', async () => {
    const dir = await seedDirWith('uncredentialed.json', {
      provider: 'uncredentialed',
      displayName: 'Uncredentialed',
      category: 'Productivity',
      authStrategy: 'oauth2_authorization_code',
      apiHosts: ['api.uncredentialed.test'],
      oauth: {
        authorizationUrl: 'https://auth.uncredentialed.test/authorize',
        tokenUrl: 'https://auth.uncredentialed.test/token',
        scopes: ['read'],
        pkce: 'required',
        refresh: 'rotating',
        tokenExchange: {},
        accountLabel: {},
      },
    });

    const routes = await manifestFor(dir);
    expect(routes.some(route => route.includes('/me/integrations/uncredentialed'))).toBe(false);
  });
});
