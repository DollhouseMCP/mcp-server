import type { Request } from 'express';

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
] as const;

export const CONSOLE_HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const;

export type ConsoleCapability = typeof CONSOLE_CAPABILITIES[number];
export type ConsolePrivacyClass = typeof CONSOLE_PRIVACY_CLASSES[number];
export type ConsoleElevationPolicy = typeof CONSOLE_ELEVATION_POLICIES[number];
export type ConsoleHttpMethod = typeof CONSOLE_HTTP_METHODS[number];
export type ConsoleAudience = 'self' | 'admin';
export type ConsoleOwnershipPolicy = 'none' | 'authenticated_user' | 'owned_session';
export type ConsoleIdempotencyPolicy = 'not_applicable' | 'required';

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
   * Models ordinary JSON or bodyless module responses. BFF authentication
   * cookie issuance/clearing requires a later platform-owned response type;
   * modules must not receive unrestricted Set-Cookie control.
   */
  readonly status: number;
  readonly body?: unknown;
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

export interface ConsoleRouteDefinition {
  readonly method: ConsoleHttpMethod;
  readonly path: string;
  readonly audience: ConsoleAudience;
  readonly requiredCapability: ConsoleCapability;
  readonly ownership?: ConsoleOwnershipPolicy;
  readonly elevation?: ConsoleElevationPolicy;
  readonly privacyClass?: ConsolePrivacyClass;
  readonly idempotency?: ConsoleIdempotencyPolicy;
  readonly auditOperation?: string;
  readonly privacyProjector?: ConsolePrivacyProjector;
  readonly handler: ConsoleHandler;
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
  readonly requiredCapability: ConsoleCapability;
  readonly ownership: ConsoleOwnershipPolicy;
  readonly elevation: ConsoleElevationPolicy;
  readonly privacyClass: ConsolePrivacyClass;
  readonly idempotency: ConsoleIdempotencyPolicy;
  readonly auditOperation?: string;
}

export interface ConsoleRouteManifest {
  readonly apiVersion: 'v1';
  readonly routes: readonly ConsoleRouteManifestEntry[];
}
