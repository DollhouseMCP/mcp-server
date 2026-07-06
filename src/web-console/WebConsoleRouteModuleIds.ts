export const SECURITY_ADMIN_MODULE_ID = 'security-admin';

// Baseline feature modules: expected present for a complete console replacement
// (auth + health are added by the readiness required-list). Each can be omitted
// individually via `omittedRouteModuleIds`, but its absence means the console is
// not a full replacement.
export const WEB_CONSOLE_BASELINE_ROUTE_MODULE_IDS = [
  'accountAdmin',
  'activations',
  'approvals',
  'audit',
  'executions',
  'integrations',
  'me-logs',
  'operations',
  'portfolio',
  'runtimeSessions',
  SECURITY_ADMIN_MODULE_ID,
  'selfSecurity',
  'selfService',
  'session-telemetry',
] as const;

// Optional, default-off feature modules: registerable and omittable, but NOT
// part of the replacement baseline — a console without them is still a complete
// replacement, so they must never be required for readiness.
export const WEB_CONSOLE_OPTIONAL_ROUTE_MODULE_IDS = [
  'collection',
] as const;

export const WEB_CONSOLE_OMITTABLE_ROUTE_MODULE_IDS = [
  ...WEB_CONSOLE_BASELINE_ROUTE_MODULE_IDS,
  ...WEB_CONSOLE_OPTIONAL_ROUTE_MODULE_IDS,
] as const;

export type WebConsoleOmittableRouteModuleId = typeof WEB_CONSOLE_OMITTABLE_ROUTE_MODULE_IDS[number];
