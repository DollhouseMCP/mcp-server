import { describe, expect, it } from '@jest/globals';

import {
  resolveWebConsoleHttpBootstrapOptions,
  type WebConsoleHttpBootstrapEnv,
} from '../../../src/web-console/WebConsoleHttpBootstrap.js';

const KEY_1 = Buffer.alloc(32, 1).toString('base64');
const KEY_2 = Buffer.alloc(32, 2).toString('base64');
const KEY_3 = Buffer.alloc(32, 3).toString('base64');

function env(overrides: Partial<WebConsoleHttpBootstrapEnv> = {}): WebConsoleHttpBootstrapEnv {
  return {
    DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED: true,
    DOLLHOUSE_HTTP_WEB_CONSOLE: false,
    DOLLHOUSE_PUBLIC_BASE_URL: 'https://console.example.test',
    DOLLHOUSE_HTTP_HOST: '0.0.0.0',
    DOLLHOUSE_AUTH_METHODS: ['local-password'],
    GITHUB_REPOSITORY: 'custom-portfolio',
    DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_NAME: 'dollhouse_prod',
    DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_USER: 'dollhouse_admin',
    DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY: KEY_1,
    DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY: KEY_2,
    DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY_ID: 'console-key-v1',
    DOLLHOUSE_WEB_CONSOLE_PROTECTED_CORRELATION_HMAC_KEY: KEY_3,
    DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID: undefined,
    DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_SECRET: undefined,
    ...overrides,
  };
}

describe('WebConsoleHttpBootstrap', () => {
  it('stays dormant unless the api v1 env gate is enabled', () => {
    expect(resolveWebConsoleHttpBootstrapOptions(env({
      DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED: false,
    }))).toBeNull();
  });

  it('resolves strict hosted mount options from deployment env', () => {
    const options = resolveWebConsoleHttpBootstrapOptions(env({
      DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID: 'github-client-id',
      DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_SECRET: 'github-client-secret',
    }));

    expect(options).toMatchObject({
      activationProfile: 'shared-hosted',
      enableApiV1Mount: true,
      requireExplicitProductionAdapterMetadata: true,
      publicBaseUrl: 'https://console.example.test',
      deploymentSignal: {
        sharedHosted: true,
        httpHost: '0.0.0.0',
        publicBaseUrl: 'https://console.example.test',
        authMethods: ['local-password'],
      },
      githubIntegrationProviderConfig: {
        clientId: 'github-client-id',
        clientSecret: 'github-client-secret',
      },
      productionDatabaseVerification: {
        expectedDatabaseName: 'dollhouse_prod',
        expectedCurrentUser: 'dollhouse_admin',
      },
      portfolioSyncRepositoryName: 'custom-portfolio',
    });
    expect(options?.opaqueValueHmacKey).toEqual(Buffer.alloc(32, 1));
    expect(options?.secretEncryptionKey).toEqual({
      keyId: 'console-key-v1',
      key: Buffer.alloc(32, 2),
    });
    expect(options?.protectedCorrelationSelectorHmacKey).toEqual(Buffer.alloc(32, 3));
  });

  it('fails clearly when required hosted mount keys are missing or malformed', () => {
    expect(() => resolveWebConsoleHttpBootstrapOptions(env({
      DOLLHOUSE_HTTP_WEB_CONSOLE: true,
    }))).toThrow('replaces the legacy web console API');

    expect(() => resolveWebConsoleHttpBootstrapOptions(env({
      DOLLHOUSE_PUBLIC_BASE_URL: undefined,
    }))).toThrow('DOLLHOUSE_PUBLIC_BASE_URL');

    expect(() => resolveWebConsoleHttpBootstrapOptions(env({
      DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY: Buffer.alloc(31, 1).toString('base64'),
    }))).toThrow('DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY must decode to exactly 32 bytes');

    expect(() => resolveWebConsoleHttpBootstrapOptions(env({
      DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY: undefined,
    }))).toThrow('DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY must be set');
  });
});
