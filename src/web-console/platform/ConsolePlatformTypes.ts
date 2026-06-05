import type { Request } from 'express';
import type { ConsoleCookieDirective } from '../middleware/ConsoleCookies.js';

export const CONSOLE_API_PREFIX = '/api/v1' as const;

export const CONSOLE_CAPABILITIES = [
  'console:self',
  'console:admin:accounts',
  'console:admin:operate',
  'console:admin:audit',
  'console:admin:security',
] as const;

export const CONSOLE_PRIVACY_CLASSES = [
  'self_private',
  'self_security',
  'account_metadata',
  'operational_allowlist',
  'approval_metadata',
  'admin_audit',
  'security_metadata',
] as const;

export const CONSOLE_ELEVATION_POLICIES = [
  'none',
  'admin_30m',
  'admin_5m',
  'admin_fresh',
] as const;

export const CONSOLE_HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const;

export const CONSOLE_RATE_LIMIT_POLICIES = [
  'none',
  'protected_correlation_resolution',
] as const;

export type ConsoleCapability = typeof CONSOLE_CAPABILITIES[number];
export type ConsoleRouteCapability = ConsoleCapability | 'none';
export type ConsolePrivacyClass = typeof CONSOLE_PRIVACY_CLASSES[number];
export type ConsoleElevationPolicy = typeof CONSOLE_ELEVATION_POLICIES[number];
export type ConsoleHttpMethod = typeof CONSOLE_HTTP_METHODS[number];
export type ConsoleRateLimitPolicy = typeof CONSOLE_RATE_LIMIT_POLICIES[number];
export type ConsoleAudience = 'public' | 'self' | 'admin';
export type ConsoleOwnershipPolicy = 'none' | 'flow_transaction' | 'authenticated_user' | 'owned_session';
export type ConsoleIdempotencyPolicy = 'not_applicable' | 'required';
export type ConsoleAuditExecutionPolicy = 'kernel' | 'handler_transaction';
export type ConsoleResponseKind = 'json' | 'sse';

export interface ConsoleRequestContext {
  readonly correlationId: string;
  readonly receivedAt: Date;
}

export interface ConsoleAuthenticatedContext {
  readonly sessionIdHash: Buffer;
  readonly userId: string;
  readonly authSub: string;
  readonly authzVersion: number;
  readonly grantedCapabilities: readonly ConsoleCapability[];
  readonly elevation: {
    readonly capabilities: readonly ConsoleCapability[];
    readonly expiresAt: Date;
    readonly acr: string;
    readonly amr: readonly string[];
    readonly authTime: Date;
  } | null;
}

export interface ConsoleRequest extends Request {
  consoleContext?: ConsoleRequestContext;
  consoleAuthentication?: ConsoleAuthenticatedContext;
}

export interface ConsoleHandlerResult {
  /**
   * Models ordinary JSON or bodyless module responses. The cookie directive
   * surface is deliberately closed to the BFF cookie names and attributes
   * defined by the platform; modules do not receive unrestricted Set-Cookie
   * control.
   */
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: ConsoleResponseHeaders;
  readonly cookies?: readonly ConsoleCookieDirective[];
  readonly redirectTo?: string;
  readonly stream?: ConsoleSseStream;
}

export interface ConsoleSseEvent {
  readonly id?: string;
  readonly event: string;
  readonly data?: unknown;
}

export interface ConsoleSseStream {
  readonly events: AsyncIterable<ConsoleSseEvent>;
  readonly init?: unknown;
  readonly policy?: ConsoleStreamPolicy;
  readonly projectEvent?: (event: ConsoleSseEvent) => ConsoleSseEvent;
  readonly revalidate?: () => Promise<boolean>;
  readonly reportStreamError?: (error: unknown) => void;
}

export interface ConsoleStreamPolicy {
  readonly lastEventId: 'unsupported' | 'bounded';
  readonly heartbeatMs: number;
  readonly revalidateMs: number;
  readonly maxEventBytes: number;
  readonly maxLastEventIdBytes: number;
}

export interface ConsoleResponseHeaders {
  readonly ETag?: string;
  readonly 'Cache-Control'?: string;
  readonly Vary?: string;
  readonly 'Last-Modified'?: string;
}

/**
 * Console handlers return application results. The kernel owns serialization
 * so route privacy projections cannot be bypassed by writing to Express.
 */
export type ConsoleHandler = (
  req: ConsoleRequest,
) => ConsoleHandlerResult | Promise<ConsoleHandlerResult>;

/**
 * A projection is required for administrative routes so raw domain values are
 * never their response contract. Feature modules implement its allowlist.
 */
export type ConsolePrivacyProjector = (value: unknown) => unknown;
export type ConsoleStreamEventProjectors = Readonly<Record<string, ConsolePrivacyProjector>>;

export interface ConsoleRouteDefinition {
  readonly method: ConsoleHttpMethod;
  readonly path: string;
  readonly audience: ConsoleAudience;
  readonly requiredCapability: ConsoleRouteCapability;
  readonly ownership?: ConsoleOwnershipPolicy;
  readonly elevation?: ConsoleElevationPolicy;
  readonly privacyClass?: ConsolePrivacyClass;
  readonly idempotency?: ConsoleIdempotencyPolicy;
  /**
   * Declarative route policy only. Enforcement is wired by the secured router
   * when the matching rate-limit middleware is installed.
   */
  readonly rateLimit?: ConsoleRateLimitPolicy;
  readonly auditOperation?: string;
  readonly auditExecution?: ConsoleAuditExecutionPolicy;
  readonly responseKind?: ConsoleResponseKind;
  readonly streamPolicy?: ConsoleStreamPolicy;
  readonly streamEventProjectors?: ConsoleStreamEventProjectors;
  readonly privacyProjector?: ConsolePrivacyProjector;
  readonly handler: ConsoleHandler;
}

/** ACR value the embedded authorization server stamps on an admin step-up proof. */
export const CONSOLE_ADMIN_STEPUP_ACR = 'urn:dollhouse:acr:admin-stepup';

const ELEVATION_FRESH_SECONDS = 60;
const ELEVATION_30M_SECONDS = 1800;
const ELEVATION_5M_CEILING_SECONDS = 300;

/**
 * Required OTP freshness (in seconds) for a route's elevation policy.
 * Re-authentication is graduated by blast radius rather than by read-vs-write:
 *  - `admin_30m` (30 min): reads + routine, reversible mutations.
 *  - `admin_5m`  (≤5 min, operator-tightenable down to 60s but never loosenable
 *    past 5 min): per-user destructive-but-recoverable ops + sensitive reads.
 *  - `admin_fresh` (60s): near-per-action proof for irreversible/global ops
 *    (signing-key rotate/retire/delete, auth-policy changes).
 * The single source of truth for both the request-time authorization gate and
 * SSE stream revalidation, so the two can never diverge.
 */
export function elevationPolicySeconds(
  policy: ConsoleElevationPolicy | undefined,
  maxAdminElevationSeconds = ELEVATION_5M_CEILING_SECONDS,
): number {
  const boundedMax = Math.max(
    ELEVATION_FRESH_SECONDS,
    Math.min(ELEVATION_5M_CEILING_SECONDS, Math.trunc(maxAdminElevationSeconds)),
  );
  switch (policy) {
    case 'admin_fresh':
      return ELEVATION_FRESH_SECONDS;
    case 'admin_5m':
      return boundedMax;
    case 'none':
    case 'admin_30m':
    case undefined:
      return ELEVATION_30M_SECONDS;
  }
}

/**
 * Whether a session's current elevation satisfies an admin route: the required
 * capability is held, the elevation has not expired, it carries an admin-ACR OTP
 * proof, and that proof is within the route's freshness window. Shared by the
 * request-time gate (`ConsoleAuthorization`) and SSE stream revalidation
 * (`ConsoleSecuredRouterAssembler`).
 */
export function isElevationValidForRoute(
  authentication: ConsoleAuthenticatedContext,
  route: ConsoleRouteDefinition,
  now: Date,
  maxAdminElevationSeconds?: number,
): boolean {
  if (route.requiredCapability === 'none') return false;
  const elevation = authentication.elevation;
  if (!elevation) return false;
  const freshnessSeconds = elevationPolicySeconds(route.elevation, maxAdminElevationSeconds);
  return (
    elevation.capabilities.includes(route.requiredCapability) &&
    elevation.expiresAt > now &&
    elevation.acr === CONSOLE_ADMIN_STEPUP_ACR &&
    elevation.amr.includes('otp') &&
    elevation.authTime.getTime() + freshnessSeconds * 1000 > now.getTime()
  );
}

export interface ConsoleAuditOperationDefinition {
  readonly id: string;
}

export interface ConsoleEventDefinition {
  readonly type: string;
  readonly schemaId: string;
}

export interface ConsoleSchemaDefinition {
  readonly id: string;
}

/**
 * Migration execution belongs to the later persistence slice; the descriptor
 * reserves module-owned schema registration without coupling the kernel to it.
 */
export interface ConsoleModuleMigrationRegistration {
  readonly schemaVersion: string;
}

export interface ConsoleModuleDescriptor {
  readonly id: string;
  readonly apiVersion: 'v1';
  readonly capabilities: readonly ConsoleCapability[];
  readonly routes: readonly ConsoleRouteDefinition[];
  readonly auditOperations?: readonly ConsoleAuditOperationDefinition[];
  readonly events?: readonly ConsoleEventDefinition[];
  readonly schemas?: readonly ConsoleSchemaDefinition[];
  readonly migrations?: ConsoleModuleMigrationRegistration;
}

export interface ConsoleRouteManifestEntry {
  readonly moduleId: string;
  readonly method: ConsoleHttpMethod;
  readonly path: string;
  readonly audience: ConsoleAudience;
  readonly requiredCapability: ConsoleRouteCapability;
  readonly ownership: ConsoleOwnershipPolicy;
  readonly elevation: ConsoleElevationPolicy;
  readonly privacyClass: ConsolePrivacyClass;
  readonly idempotency: ConsoleIdempotencyPolicy;
  readonly rateLimit?: ConsoleRateLimitPolicy;
  readonly auditOperation?: string;
  readonly responseKind?: ConsoleResponseKind;
}

export interface ConsoleRouteManifest {
  readonly apiVersion: 'v1';
  readonly routes: readonly ConsoleRouteManifestEntry[];
}
