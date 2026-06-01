import { describe, expect, it } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertWebConsoleReplacementEvidenceReady,
  resolveWebConsoleHttpBootstrapOptions,
  type WebConsoleHttpBootstrapEnv,
} from '../../../src/web-console/WebConsoleHttpBootstrap.js';
import { ConsoleModuleRegistry } from '../../../src/web-console/index.js';
import {
  WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS,
  WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS,
  type WebConsoleReplacementLiveCheckId,
} from '../../../src/web-console/WebConsoleReplacementReadiness.js';

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
    DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE: '/deployment/replacement-readiness.json',
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
      DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE: undefined,
    }))).toThrow('DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE');

    expect(() => resolveWebConsoleHttpBootstrapOptions(env({
      DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY: Buffer.alloc(31, 1).toString('base64'),
    }))).toThrow('DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY must decode to exactly 32 bytes');

    expect(() => resolveWebConsoleHttpBootstrapOptions(env({
      DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY: undefined,
    }))).toThrow('DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY must be set');
  });

  it('requires selected-deployment replacement evidence to pass before activation', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'web-console-replacement-'));
    try {
      const evidencePath = join(tempDir, 'replacement-readiness.json');
      await writeFile(evidencePath, JSON.stringify(evidence({
        liveChecks: liveChecks({ fail: 'security_invalidation_multi_replica' }),
      })));

      await expect(assertWebConsoleReplacementEvidenceReady(composition(), evidencePath))
        .rejects.toThrow('security_invalidation_multi_replica: selected deployment check failed');

      await writeFile(evidencePath, JSON.stringify(evidence()));

      await expect(assertWebConsoleReplacementEvidenceReady(composition(), evidencePath))
        .resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses the runtime pre-replacement phase and includes the evidence path in read errors', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'web-console-replacement-'));
    try {
      const evidencePath = join(tempDir, 'replacement-readiness.json');
      await writeFile(evidencePath, JSON.stringify(evidence({
        phase: 'active-replacement',
      })));

      await expect(assertWebConsoleReplacementEvidenceReady(composition(), evidencePath))
        .resolves.toBeUndefined();

      await expect(assertWebConsoleReplacementEvidenceReady(composition(), join(tempDir, 'missing.json')))
        .rejects.toThrow(`Failed to read web console replacement readiness evidence at ${join(tempDir, 'missing.json')}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function evidence(overrides: {
  readonly phase?: 'pre-replacement' | 'active-replacement';
  readonly liveChecks?: readonly Record<string, unknown>[];
} = {}): Record<string, unknown> {
  return {
    phase: overrides.phase ?? 'pre-replacement',
    composition: {
      activationProfile: 'shared-hosted',
      storageBackend: 'postgres',
      apiV1MountCreated: true,
      routesMounted: false,
      registeredRouteModuleIds: WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS,
    },
    liveChecks: overrides.liveChecks ?? liveChecks(),
  };
}

function liveChecks(options: {
  readonly fail?: WebConsoleReplacementLiveCheckId;
} = {}): readonly Record<string, unknown>[] {
  return WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS.map(id => ({
    id,
    ready: id !== options.fail,
    detail: id === options.fail
      ? 'selected deployment check failed'
      : 'selected deployment verification passed',
  }));
}

function composition(): Parameters<typeof assertWebConsoleReplacementEvidenceReady>[0] {
  const registry = new ConsoleModuleRegistry();
  for (const moduleId of WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS) {
    registry.register({
      id: moduleId,
      apiVersion: 'v1',
      capabilities: ['console:self'],
      routes: [],
    });
  }
  return {
    activationProfile: 'shared-hosted',
    storageBackend: 'postgres',
    apiV1Mount: {
      router: {} as never,
      mounted: () => false,
      markMounted: () => {},
    },
    routesMounted: false,
    registry,
  };
}
