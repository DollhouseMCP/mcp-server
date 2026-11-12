import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  resolveWebConsoleHttpBootstrapOptions,
  type WebConsoleHttpBootstrapEnv,
} from '../../../src/web-console/WebConsoleHttpBootstrap.js';
import { logger } from '../../../src/utils/logger.js';

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
    GITHUB_TOKEN: undefined,
    DOLLHOUSE_WEB_CONSOLE_COLLECTION_ENABLED: false,
    DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_NAME: 'dollhouse_prod',
    DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_USER: 'dollhouse_admin',
    DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY: KEY_1,
    DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY: KEY_2,
    DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY_ID: 'console-key-v1',
    DOLLHOUSE_WEB_CONSOLE_PROTECTED_CORRELATION_HMAC_KEY: KEY_3,
    DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE: undefined,
    DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID: undefined,
    DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_SECRET: undefined,
    ...overrides,
  };
}

describe('WebConsoleHttpBootstrap', () => {
  it('fails closed on an explicit onboarding opt-in even when the console API is disabled', () => {
    expect(() => resolveWebConsoleHttpBootstrapOptions(env({
      DOLLHOUSE_BETA_ONBOARDING_ENABLED: true,
      DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED: false,
    }))).toThrow('Private beta onboarding requires');
  });

  it('passes validated private beta configuration only on explicit opt-in', () => {
    expect(resolveWebConsoleHttpBootstrapOptions(env())?.onboardingConfiguration).toBeNull();
    const options = resolveWebConsoleHttpBootstrapOptions(env({
      DOLLHOUSE_BETA_ONBOARDING_ENABLED: true,
      DOLLHOUSE_ONBOARDING_SUPPORT_EMAIL: 'support@example.test',
      DOLLHOUSE_TRANSPORT: 'streamable-http', DOLLHOUSE_AUTH_ENABLED: true,
      DOLLHOUSE_AUTH_PROVIDER: 'embedded', DOLLHOUSE_AUTH_METHODS: ['github'],
      DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED: true, DOLLHOUSE_STORAGE_BACKEND: 'database',
      DOLLHOUSE_AUTH_STORAGE_BACKEND: 'postgres', DOLLHOUSE_RATE_LIMIT_BACKEND: 'postgres',
      DOLLHOUSE_AUTH_GITHUB_CLIENT_ID: 'auth-client', DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET: 'auth-secret',
    }));
    expect(options?.onboardingConfiguration).toEqual({
      publicBaseUrl: 'https://console.example.test', supportEmail: 'support@example.test',
      github: { clientId: 'auth-client', clientSecret: 'auth-secret' }, smtp: { state: 'disabled' },
    });
  });

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

  describe('collection browse GITHUB_TOKEN warning', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('warns when collection browse is enabled on a non-loopback bind without GITHUB_TOKEN', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      resolveWebConsoleHttpBootstrapOptions(env({
        DOLLHOUSE_WEB_CONSOLE_COLLECTION_ENABLED: true,
      }));

      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0];
      expect(message).toContain('DOLLHOUSE_WEB_CONSOLE_COLLECTION_ENABLED=true');
      expect(message).toContain('GITHUB_TOKEN');
      expect(message).toContain('zero-scope');
    });

    it('stays silent when GITHUB_TOKEN is configured', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      resolveWebConsoleHttpBootstrapOptions(env({
        DOLLHOUSE_WEB_CONSOLE_COLLECTION_ENABLED: true,
        GITHUB_TOKEN: 'ghp_zero_scope_token',
      }));

      expect(warn).not.toHaveBeenCalled();
    });

    it('stays silent on a loopback bind', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      resolveWebConsoleHttpBootstrapOptions(env({
        DOLLHOUSE_WEB_CONSOLE_COLLECTION_ENABLED: true,
        DOLLHOUSE_HTTP_HOST: '127.0.0.1',
      }));

      expect(warn).not.toHaveBeenCalled();
    });

    it('stays silent when collection browse is disabled', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      resolveWebConsoleHttpBootstrapOptions(env({
        DOLLHOUSE_WEB_CONSOLE_COLLECTION_ENABLED: false,
      }));

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('retired readiness evidence file', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('starts on a fresh install with no evidence file configured', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      const options = resolveWebConsoleHttpBootstrapOptions(env());

      expect(options).toMatchObject({ activationProfile: 'shared-hosted', enableApiV1Mount: true });
      expect(warn).not.toHaveBeenCalled();
    });

    it('ignores a still-configured evidence path and says so once', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      // The path does not exist: the file is never opened, so nothing can fail on it.
      const options = resolveWebConsoleHttpBootstrapOptions(env({
        DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE: '/nonexistent/replacement-readiness.json',
      }));

      expect(options).toMatchObject({ activationProfile: 'shared-hosted', enableApiV1Mount: true });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0];
      expect(message).toContain('DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE is set but is no longer used');
      expect(message).toContain('Remove the variable');
      expect(message).not.toContain('/nonexistent/replacement-readiness.json');
    });

    it('does not warn about the evidence path while the console is disabled', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      expect(resolveWebConsoleHttpBootstrapOptions(env({
        DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED: false,
        DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE: '/deployment/replacement-readiness.json',
      }))).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
