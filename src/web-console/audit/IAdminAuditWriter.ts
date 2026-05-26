import type { ConsoleCapability } from '../platform/ConsolePlatformTypes.js';

export type ConsoleAdminAuditResult = 'approved' | 'failed';

/**
 * Phase 2 audit input contains only centrally selected security metadata.
 * Domain-specific redacted arguments and durable HMAC chain persistence are
 * introduced with the administrative workflow stores.
 */
export interface ConsoleAdminAuditEvent {
  readonly occurredAt: Date;
  readonly actorUserId: string;
  readonly actorSub: string;
  readonly actorConsoleSessionHash: Buffer;
  readonly capability: ConsoleCapability;
  readonly elevationAcr: string | null;
  readonly elevationAmr: readonly string[];
  readonly elevationAuthTime: Date | null;
  readonly correlationId: string;
  readonly endpoint: string;
  readonly operation: string;
  readonly argsRedacted: Readonly<Record<string, never>>;
  readonly result: ConsoleAdminAuditResult;
  readonly errorCode: string | null;
}

export interface IAdminAuditWriter {
  write(event: ConsoleAdminAuditEvent): Promise<void>;
}
