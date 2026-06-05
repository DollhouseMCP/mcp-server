import type { ConsoleRouteDefinition, ConsoleRequest } from '../platform/ConsolePlatformTypes.js';
import { requireConsoleRequestContext } from '../platform/ConsoleRequestContext.js';
import type {
  ConsoleAdminActorRole,
  ConsoleAdminAuditEvent,
  ConsoleAdminAuditResult,
  IAdminAuditWriter,
} from '../audit/IAdminAuditWriter.js';
import { requireConsoleAuthentication } from './ConsoleAuthentication.js';

export async function writeConsoleAdminAudit(
  writer: IAdminAuditWriter,
  route: ConsoleRouteDefinition,
  req: ConsoleRequest,
  result: ConsoleAdminAuditResult,
  errorCode: string | null,
  occurredAt: Date,
): Promise<void> {
  if (route.audience !== 'admin') return;
  if (!route.auditOperation) {
    throw new Error('Validated administrative route is missing its audit operation');
  }
  await writer.write(buildConsoleAdminAuditEvent(route, route.auditOperation, req, result, errorCode, occurredAt));
}

export function buildConsoleAdminAuditEvent(
  route: ConsoleRouteDefinition,
  auditOperation: string,
  req: ConsoleRequest,
  result: ConsoleAdminAuditResult,
  errorCode: string | null,
  occurredAt: Date,
  overrides: Partial<Pick<
    ConsoleAdminAuditEvent,
    'resourceKind' | 'resourceId' | 'targetUserId' | 'argsRedacted' | 'resultDetailRedacted'
  >> = {},
): ConsoleAdminAuditEvent {
  const authentication = requireConsoleAuthentication(req);
  const elevation = authentication.elevation;
  if (route.requiredCapability === 'none') {
    throw new Error('Validated administrative route is missing its required capability');
  }
  return {
    occurredAt,
    actorUserId: authentication.userId,
    actorSub: authentication.authSub,
    actorRole: null,
    actorCapabilityRole: roleForCapability(route.requiredCapability),
    actorConsoleSessionHash: Buffer.from(authentication.sessionIdHash),
    capability: route.requiredCapability,
    elevationAcr: elevation?.acr ?? null,
    elevationAmr: elevation ? [...elevation.amr] : [],
    elevationAuthTime: elevation ? new Date(elevation.authTime) : null,
    correlationId: requireConsoleRequestContext(req).correlationId,
    endpoint: `${route.method} ${route.path}`,
    operation: auditOperation,
    resourceKind: overrides.resourceKind ?? null,
    resourceId: overrides.resourceId ?? null,
    targetUserId: overrides.targetUserId ?? null,
    argsRedacted: overrides.argsRedacted ?? {},
    result,
    errorCode,
    resultDetailRedacted: overrides.resultDetailRedacted ?? null,
    clientIp: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

function roleForCapability(capability: Exclude<ConsoleRouteDefinition['requiredCapability'], 'none'>): ConsoleAdminActorRole {
  switch (capability) {
    case 'console:admin:accounts':
      return 'account_admin';
    case 'console:admin:operate':
      return 'operator';
    case 'console:admin:audit':
      return 'auditor';
    case 'console:admin:security':
      return 'security_admin';
    case 'console:self':
      throw new Error('Administrative audit cannot use self-service capability');
  }
}
