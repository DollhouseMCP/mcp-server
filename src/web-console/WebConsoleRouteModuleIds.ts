export const SECURITY_ADMIN_MODULE_ID = 'security-admin';

export const WEB_CONSOLE_OMITTABLE_ROUTE_MODULE_IDS = [
  'accountAdmin',
  'activations',
  'approvals',
  'audit',
  'executions',
  'integrations',
  'operations',
  'portfolio',
  'runtimeSessions',
  SECURITY_ADMIN_MODULE_ID,
  'selfSecurity',
  'selfService',
  'session-telemetry',
] as const;

export type WebConsoleOmittableRouteModuleId = typeof WEB_CONSOLE_OMITTABLE_ROUTE_MODULE_IDS[number];
