import { describe, expect, it } from '@jest/globals';

import {
  ConsoleModuleRegistry,
  WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS,
  WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS,
  verifyWebConsoleReplacementReadiness,
  type WebConsoleComposition,
  type WebConsoleReplacementLiveCheck,
} from '../../../src/web-console/index.js';

describe('WebConsoleReplacementReadiness', () => {
  it('passes only when local composition and every selected-deployment check are ready', () => {
    const result = verifyWebConsoleReplacementReadiness({
      composition: composition(),
      phase: 'pre-replacement',
      liveChecks: readyLiveChecks(),
    });

    expect(result.ready).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.items.map(item => item.id)).toEqual(expect.arrayContaining([
      'activation_profile_shared_hosted',
      'storage_backend_postgres',
      'api_v1_mount_created',
      'api_v1_replacement_still_dormant',
      'complete_v1_route_surface_registered',
      ...WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS,
    ]));
  });

  it('fails closed for missing or failed selected-deployment checks', () => {
    const result = verifyWebConsoleReplacementReadiness({
      composition: composition(),
      phase: 'pre-replacement',
      liveChecks: readyLiveChecks({
        omit: 'portfolio_sync_live_repository',
        fail: 'security_invalidation_multi_replica',
      }),
    });

    expect(result.ready).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'portfolio_sync_live_repository',
        detail: 'selected deployment verification result was not supplied',
      }),
      expect.objectContaining({
        id: 'security_invalidation_multi_replica',
        detail: 'multi-replica invalidation did not drain',
      }),
    ]));
  });

  it('distinguishes pre-replacement and active replacement route state', () => {
    const preReplacement = verifyWebConsoleReplacementReadiness({
      composition: composition({ routesMounted: true }),
      phase: 'pre-replacement',
      liveChecks: readyLiveChecks(),
    });
    const activeReplacement = verifyWebConsoleReplacementReadiness({
      composition: composition({ routesMounted: true }),
      phase: 'active-replacement',
      liveChecks: readyLiveChecks(),
    });

    expect(preReplacement.ready).toBe(false);
    expect(preReplacement.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'api_v1_replacement_still_dormant' }),
    ]));
    expect(activeReplacement.ready).toBe(true);
  });

  it('requires the complete v1 route surface registered for M7 replacement', () => {
    const result = verifyWebConsoleReplacementReadiness({
      composition: composition({ registeredModules: WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS.slice(1) }),
      phase: 'pre-replacement',
      liveChecks: readyLiveChecks(),
    });

    expect(result.ready).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'complete_v1_route_surface_registered' }),
    ]));
  });
});

function readyLiveChecks(options: {
  readonly omit?: string;
  readonly fail?: string;
} = {}): readonly WebConsoleReplacementLiveCheck[] {
  return WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS
    .filter(id => id !== options.omit)
    .map(id => ({
      id,
      ready: id !== options.fail,
      detail: id === options.fail
        ? 'multi-replica invalidation did not drain'
        : 'selected deployment verification passed',
    }));
}

function composition(overrides: {
  readonly activationProfile?: 'development' | 'shared-hosted';
  readonly storageBackend?: 'memory' | 'postgres';
  readonly routesMounted?: boolean;
  readonly registeredModules?: readonly string[];
} = {}): Pick<WebConsoleComposition, 'activationProfile' | 'apiV1Mount' | 'registry' | 'routesMounted' | 'storageBackend'> {
  const registry = new ConsoleModuleRegistry();
  for (const moduleId of overrides.registeredModules ?? WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS) {
    registry.register({
      id: moduleId,
      apiVersion: 'v1',
      capabilities: ['console:self'],
      routes: [{
        method: 'GET',
        path: `/api/v1/me/${moduleId}`,
        audience: 'self',
        requiredCapability: 'console:self',
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        handler: () => Promise.resolve({ status: 200, body: { ok: true } }),
      }],
    });
  }
  return {
    activationProfile: overrides.activationProfile ?? 'shared-hosted',
    storageBackend: overrides.storageBackend ?? 'postgres',
    apiV1Mount: {
      router: {} as never,
      mounted: () => overrides.routesMounted ?? false,
      markMounted: () => {},
    },
    get routesMounted() {
      return overrides.routesMounted ?? false;
    },
    registry,
  };
}
