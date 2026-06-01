import { WEB_CONSOLE_OMITTABLE_ROUTE_MODULE_IDS, type WebConsoleComposition } from './WebConsoleRegistrar.js';

export const WEB_CONSOLE_CUTOVER_REQUIRED_ROUTE_MODULE_IDS = [
  'auth',
  'health',
  ...WEB_CONSOLE_OMITTABLE_ROUTE_MODULE_IDS,
] as const;

export const WEB_CONSOLE_CUTOVER_LIVE_CHECK_IDS = [
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

export type WebConsoleCutoverLiveCheckId = typeof WEB_CONSOLE_CUTOVER_LIVE_CHECK_IDS[number];
export type WebConsoleCutoverPhase = 'pre-mount' | 'post-mount';

export interface WebConsoleCutoverLiveCheck {
  readonly id: WebConsoleCutoverLiveCheckId;
  readonly ready: boolean;
  readonly detail?: string;
}

export interface WebConsoleCutoverVerificationItem {
  readonly id: string;
  readonly ready: boolean;
  readonly detail: string;
}

export interface WebConsoleCutoverVerificationResult {
  readonly ready: boolean;
  readonly failures: readonly WebConsoleCutoverVerificationItem[];
  readonly items: readonly WebConsoleCutoverVerificationItem[];
}

export interface WebConsoleCutoverVerificationOptions {
  readonly composition: Pick<WebConsoleComposition,
    'activationProfile' | 'apiV1Mount' | 'registry' | 'routesMounted' | 'storageBackend'
  >;
  readonly phase: WebConsoleCutoverPhase;
  readonly liveChecks: readonly WebConsoleCutoverLiveCheck[];
}

export function verifyWebConsoleCutoverReadiness(
  options: WebConsoleCutoverVerificationOptions,
): WebConsoleCutoverVerificationResult {
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
  composition: WebConsoleCutoverVerificationOptions['composition'],
  phase: WebConsoleCutoverPhase,
): readonly WebConsoleCutoverVerificationItem[] {
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
      'descriptor API v1 mount was created by activation',
    ),
    check(
      phase === 'pre-mount' ? 'api_v1_mount_still_dormant' : 'api_v1_mount_marked_mounted',
      phase === 'pre-mount' ? !composition.routesMounted : composition.routesMounted,
      phase === 'pre-mount'
        ? 'pre-mount verification requires the router to remain unmounted'
        : 'post-mount verification requires the HTTP runtime to mark the router mounted',
    ),
    check(
      'complete_v1_route_surface_registered',
      hasAllRegisteredModules(composition, WEB_CONSOLE_CUTOVER_REQUIRED_ROUTE_MODULE_IDS),
      'all v1 descriptor route modules required for M7 merge are registered',
    ),
  ];
}

function liveDeploymentChecks(
  liveChecks: readonly WebConsoleCutoverLiveCheck[],
): readonly WebConsoleCutoverVerificationItem[] {
  const byId = new Map(liveChecks.map(liveCheck => [liveCheck.id, liveCheck]));
  return WEB_CONSOLE_CUTOVER_LIVE_CHECK_IDS.map(id => {
    const liveCheck = byId.get(id);
    if (!liveCheck) {
      return check(id, false, 'selected deployment verification result was not supplied');
    }
    return check(id, liveCheck.ready, liveCheck.detail ?? 'selected deployment verification passed');
  });
}

function hasAllRegisteredModules(
  composition: WebConsoleCutoverVerificationOptions['composition'],
  expected: readonly string[],
): boolean {
  const moduleIds = new Set(composition.registry.createRouteManifest().routes.map(route => route.moduleId));
  return expected.every(moduleId => moduleIds.has(moduleId));
}

function check(
  id: string,
  ready: boolean,
  detail: string,
): WebConsoleCutoverVerificationItem {
  return { id, ready, detail };
}
