import type { WebConsoleComposition } from './WebConsoleRegistrar.js';
import { WEB_CONSOLE_OMITTABLE_ROUTE_MODULE_IDS } from './WebConsoleRouteModuleIds.js';

export const WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS = [
  'auth',
  'health',
  ...WEB_CONSOLE_OMITTABLE_ROUTE_MODULE_IDS,
] as const;

export const WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS = [
  'production_database_migrations',
  'security_invalidation_multi_replica',
  'allowlist_authority_parity',
  'embedded_as_login_step_up',
  'account_invite_redemption',
  'oauth_grant_revocation',
  'github_integration_connect_callback',
  'portfolio_sync_live_repository',
  'signing_key_auth_policy_multi_replica',
  'approval_execution_projection',
  'audit_telemetry_projection',
] as const;

export type WebConsoleReplacementLiveCheckId = typeof WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS[number];
export type WebConsoleReplacementPhase = 'pre-replacement' | 'active-replacement';

export interface WebConsoleReplacementLiveCheck {
  readonly id: WebConsoleReplacementLiveCheckId;
  readonly ready: boolean;
  readonly detail?: string;
}

export interface WebConsoleReplacementReadinessItem {
  readonly id: string;
  readonly ready: boolean;
  readonly detail: string;
}

export interface WebConsoleReplacementReadinessResult {
  readonly ready: boolean;
  readonly failures: readonly WebConsoleReplacementReadinessItem[];
  readonly items: readonly WebConsoleReplacementReadinessItem[];
}

export interface WebConsoleReplacementReadinessOptions {
  readonly composition: Pick<WebConsoleComposition,
    'activationProfile' | 'apiV1Mount' | 'registry' | 'routesMounted' | 'storageBackend'
  >;
  readonly phase: WebConsoleReplacementPhase;
  readonly liveChecks: readonly WebConsoleReplacementLiveCheck[];
}

export function verifyWebConsoleReplacementReadiness(
  options: WebConsoleReplacementReadinessOptions,
): WebConsoleReplacementReadinessResult {
  const items = [
    ...localCompositionChecks(options.composition, options.phase),
    ...liveDeploymentChecks(options.liveChecks),
  ];
  const failures = items.filter(item => !item.ready);
  return {
    ready: failures.length === 0,
    failures,
    items,
  };
}

function localCompositionChecks(
  composition: WebConsoleReplacementReadinessOptions['composition'],
  phase: WebConsoleReplacementPhase,
): readonly WebConsoleReplacementReadinessItem[] {
  const apiV1MountCreated = composition.apiV1Mount !== null;
  return [
    check(
      'activation_profile_shared_hosted',
      composition.activationProfile === 'shared-hosted',
      'composition uses shared-hosted activation',
    ),
    check(
      'storage_backend_postgres',
      composition.storageBackend === 'postgres',
      'composition uses PostgreSQL storage',
    ),
    check(
      'api_v1_mount_created',
      apiV1MountCreated,
      'replacement descriptor API v1 mount was created by activation',
    ),
    check(
      phase === 'pre-replacement' ? 'api_v1_replacement_still_dormant' : 'api_v1_replacement_active',
      phase === 'pre-replacement' ? !composition.routesMounted : composition.routesMounted,
      phase === 'pre-replacement'
        ? 'pre-replacement verification requires the router to remain unmounted'
        : 'active replacement verification requires the HTTP runtime to mark the router mounted',
    ),
    check(
      'complete_v1_route_surface_registered',
      hasAllRegisteredModules(composition, WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS),
      'all v1 descriptor route modules required for M7 replacement are registered',
    ),
  ];
}

function liveDeploymentChecks(
  liveChecks: readonly WebConsoleReplacementLiveCheck[],
): readonly WebConsoleReplacementReadinessItem[] {
  const byId = new Map(liveChecks.map(liveCheck => [liveCheck.id, liveCheck]));
  return WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS.map(id => {
    const liveCheck = byId.get(id);
    if (!liveCheck) {
      return check(id, false, 'selected deployment verification result was not supplied');
    }
    return check(id, liveCheck.ready, liveCheck.detail ?? 'selected deployment verification passed');
  });
}

function hasAllRegisteredModules(
  composition: WebConsoleReplacementReadinessOptions['composition'],
  expected: readonly string[],
): boolean {
  const moduleIds = new Set(composition.registry.getModules().map(module => module.id));
  return expected.every(moduleId => moduleIds.has(moduleId));
}

function check(
  id: string,
  ready: boolean,
  detail: string,
): WebConsoleReplacementReadinessItem {
  return { id, ready, detail };
}
