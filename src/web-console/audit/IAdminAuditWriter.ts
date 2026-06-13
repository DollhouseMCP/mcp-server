import type { ConsoleCapability } from '../platform/ConsolePlatformTypes.js';

export type ConsoleAdminAuditResult =
  | 'approved'
  | 'failed'
  | 'replayed'
  | 'rejected'
  | 'conflict';

export type ConsoleAdminActorRole =
  | 'admin'
  | 'account_admin'
  | 'operator'
  | 'auditor'
  | 'security_admin';

export type ConsoleAdminAuditRedactedRecord = Readonly<Record<string, unknown>>;

export const CONSOLE_ADMIN_AUDIT_ROLES = [
  'admin',
  'account_admin',
  'operator',
  'auditor',
  'security_admin',
] as const satisfies readonly ConsoleAdminActorRole[];

export const CONSOLE_ADMIN_AUDIT_RESULTS = [
  'approved',
  'failed',
  'replayed',
  'rejected',
  'conflict',
] as const satisfies readonly ConsoleAdminAuditResult[];

export const MAX_ADMIN_AUDIT_REDACTED_JSON_BYTES = 4096;

export interface ConsoleAdminAuditEvent {
  readonly occurredAt: Date;
  readonly actorUserId: string;
  readonly actorSub: string;
  readonly actorRole: ConsoleAdminActorRole | null;
  readonly actorCapabilityRole: ConsoleAdminActorRole;
  readonly actorConsoleSessionHash: Buffer;
  readonly capability: ConsoleCapability;
  readonly elevationAcr: string | null;
  readonly elevationAmr: readonly string[];
  readonly elevationAuthTime: Date | null;
  readonly correlationId: string;
  readonly endpoint: string;
  readonly operation: string;
  readonly resourceKind: string | null;
  readonly resourceId: string | null;
  readonly targetUserId: string | null;
  readonly argsRedacted: ConsoleAdminAuditRedactedRecord;
  readonly result: ConsoleAdminAuditResult;
  readonly errorCode: string | null;
  readonly resultDetailRedacted: ConsoleAdminAuditRedactedRecord | null;
  readonly clientIp: string | null;
  readonly userAgent: string | null;
}

export interface IAdminAuditWriter {
  write(event: ConsoleAdminAuditEvent): Promise<void>;
}

export function validateConsoleAdminAuditEvent(event: ConsoleAdminAuditEvent): void {
  if (event.actorConsoleSessionHash.length !== 32) {
    throw new Error('admin audit actor session hash must be 32 bytes');
  }
  for (const [name, value] of [
    ['actorSub', event.actorSub],
    ['actorCapabilityRole', event.actorCapabilityRole],
    ['endpoint', event.endpoint],
    ['operation', event.operation],
    ['correlationId', event.correlationId],
  ] as const) {
    if (value.trim() === '') {
      throw new Error(`admin audit ${name} must not be empty`);
    }
  }
  if (event.actorRole !== null && !isConsoleAdminActorRole(event.actorRole)) {
    throw new Error(`admin audit actorRole contains unknown administrative role '${event.actorRole}'`);
  }
  if (!isConsoleAdminActorRole(event.actorCapabilityRole)) {
    throw new Error(`admin audit actorCapabilityRole contains unknown administrative role '${event.actorCapabilityRole}'`);
  }
  stringifyBoundedAdminAuditJson(event.argsRedacted, 'argsRedacted');
  if (event.resultDetailRedacted) {
    stringifyBoundedAdminAuditJson(event.resultDetailRedacted, 'resultDetailRedacted');
  }
}

export function stringifyBoundedAdminAuditJson(
  record: Readonly<Record<string, unknown>>,
  fieldName: string,
): string {
  const json = JSON.stringify(record);
  if (!json || Buffer.byteLength(json, 'utf8') > MAX_ADMIN_AUDIT_REDACTED_JSON_BYTES) {
    throw new Error(
      `admin audit ${fieldName} must serialize to at most ${MAX_ADMIN_AUDIT_REDACTED_JSON_BYTES} bytes`,
    );
  }
  return json;
}

function isConsoleAdminActorRole(value: string): value is ConsoleAdminActorRole {
  return (CONSOLE_ADMIN_AUDIT_ROLES as readonly string[]).includes(value);
}
