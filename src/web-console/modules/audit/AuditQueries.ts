import type { ConsoleAdminAuditEvent } from '../../audit/IAdminAuditWriter.js';
import {
  verifyAdminAuditRow,
  type AdminAuditChainVerification,
} from '../../audit/AdminAuditChain.js';
import type { AuditHmacKeyMaterial } from '../../../security/auditHmacKey.js';
import type {
  AdminAuditEventDto,
  ApprovalAuditEventDto,
  AuditPageDto,
  AuthenticationAuditEventDto,
} from './AuditDtos.js';

export interface AuditListQuery {
  readonly limit: number;
  readonly cursor: string | null;
}

export interface AuditExportQuery {
  readonly cursor: string | null;
  readonly batchSize: number;
}

export interface AdminAuditRow extends ConsoleAdminAuditEvent {
  readonly id: string;
  readonly sequenceId: number;
  readonly chainKeyId: string;
  readonly chainPrev: Buffer | null;
  readonly chainHmac: Buffer;
}

export interface IAdminAuditQuery {
  listAdminAudit(query: AuditListQuery): Promise<AuditPageDto<AdminAuditEventDto>>;
  getAdminAudit(id: string): Promise<AdminAuditEventDto | null>;
  streamAdminAudit(query: AuditExportQuery): AsyncIterable<AdminAuditEventDto>;
}

export interface IApprovalAuditQuery {
  listApprovalAudit(query: AuditListQuery): Promise<AuditPageDto<ApprovalAuditEventDto>>;
  getApprovalAudit(id: string): Promise<ApprovalAuditEventDto | null>;
}

export interface IAuthenticationAuditQuery {
  listAuthenticationAudit(query: AuditListQuery): Promise<AuditPageDto<AuthenticationAuditEventDto>>;
}

export class InMemoryAdminAuditQuery implements IAdminAuditQuery {
  private readonly rows: readonly AdminAuditEventDto[];

  constructor(rows: readonly AdminAuditRow[] = [], keyMaterial: AuditHmacKeyMaterial | null = null) {
    this.rows = verifyAndProjectAdminRows(rows, keyMaterial);
  }

  listAdminAudit(query: AuditListQuery): Promise<AuditPageDto<AdminAuditEventDto>> {
    return Promise.resolve(page(this.rows, query));
  }

  getAdminAudit(id: string): Promise<AdminAuditEventDto | null> {
    return Promise.resolve(this.rows.find(row => row.id === id) ?? null);
  }

  async *streamAdminAudit(query: AuditExportQuery): AsyncIterable<AdminAuditEventDto> {
    await Promise.resolve();
    const start = query.cursor ? decodeCursor(query.cursor) : 0;
    for (const row of this.rows.slice(start)) yield row;
  }
}

export class InMemoryApprovalAuditQuery implements IApprovalAuditQuery {
  constructor(private readonly rows: readonly ApprovalAuditEventDto[] = []) {}

  listApprovalAudit(query: AuditListQuery): Promise<AuditPageDto<ApprovalAuditEventDto>> {
    return Promise.resolve(page(this.rows.map(projectApprovalAuditDto), query));
  }

  getApprovalAudit(id: string): Promise<ApprovalAuditEventDto | null> {
    const row = this.rows.find(candidate => candidate.id === id);
    return Promise.resolve(row ? projectApprovalAuditDto(row) : null);
  }
}

export class InMemoryAuthenticationAuditQuery implements IAuthenticationAuditQuery {
  constructor(private readonly rows: readonly AuthenticationAuditEventDto[] = []) {}

  listAuthenticationAudit(query: AuditListQuery): Promise<AuditPageDto<AuthenticationAuditEventDto>> {
    return Promise.resolve(page(this.rows.map(projectAuthenticationAuditDto), query));
  }
}

export function toAdminAuditDto(
  row: AdminAuditRow,
  integrity: AdminAuditChainVerification = { status: 'not_available', reason: 'verification_key_unavailable' },
): AdminAuditEventDto {
  return {
    id: row.id,
    sequence_id: row.sequenceId,
    occurred_at: row.occurredAt.toISOString(),
    actor_user_id: row.actorUserId,
    actor_sub: row.actorSub,
    actor_role: row.actorRole,
    actor_capability_role: row.actorCapabilityRole,
    actor_console_session_hash: row.actorConsoleSessionHash.toString('hex'),
    capability: row.capability,
    elevation_acr: row.elevationAcr,
    elevation_amr: [...row.elevationAmr],
    elevation_auth_time: row.elevationAuthTime ? Math.floor(row.elevationAuthTime.getTime() / 1000) : null,
    correlation_id: row.correlationId,
    endpoint: row.endpoint,
    operation: row.operation,
    resource_kind: row.resourceKind,
    resource_id: row.resourceId,
    target_user_id: row.targetUserId,
    args_redacted: cloneRecord(row.argsRedacted),
    result: row.result,
    error_code: row.errorCode,
    result_detail_redacted: row.resultDetailRedacted ? cloneRecord(row.resultDetailRedacted) : null,
    client_ip: row.clientIp,
    user_agent: row.userAgent,
    chain_key_id: row.chainKeyId,
    chain_prev: row.chainPrev ? row.chainPrev.toString('hex') : null,
    chain_hmac: row.chainHmac.toString('hex'),
    integrity,
  };
}

function verifyAndProjectAdminRows(
  rows: readonly AdminAuditRow[],
  keyMaterial: AuditHmacKeyMaterial | null,
): readonly AdminAuditEventDto[] {
  const ordered = [...rows].sort((left, right) => left.sequenceId - right.sequenceId);
  let previous: Buffer | null = null;
  let previousSequenceId: number | null = null;
  const projected: AdminAuditEventDto[] = [];
  for (const row of ordered) {
    const integrity = verifyAdminAuditRow(row, keyMaterial, previous, previousSequenceId);
    projected.push(toAdminAuditDto(row, integrity));
    previous = Buffer.from(row.chainHmac);
    previousSequenceId = row.sequenceId;
  }
  return projected;
}

function page<T>(rows: readonly T[], query: AuditListQuery): AuditPageDto<T> {
  const start = query.cursor ? decodeCursor(query.cursor) : 0;
  const items = rows.slice(start, start + query.limit);
  return {
    items,
    page: {
      limit: query.limit,
      cursor: query.cursor,
      next_cursor: start + items.length < rows.length ? encodeCursor(start + items.length) : null,
    },
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function cloneRecord(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return structuredClone(record) as Readonly<Record<string, unknown>>;
}

function projectApprovalAuditDto(row: ApprovalAuditEventDto): ApprovalAuditEventDto {
  return {
    id: row.id,
    occurred_at: row.occurred_at,
    account_correlation_id: row.account_correlation_id,
    session_id: row.session_id,
    tool_name: row.tool_name,
    operation: row.operation,
    result: row.result,
    decision_source: row.decision_source,
    correlation_id: row.correlation_id,
    integrity: {
      status: row.integrity.status,
      chain_key_id: row.integrity.chain_key_id,
      chain_prev: row.integrity.chain_prev,
      chain_hmac: row.integrity.chain_hmac,
    },
  };
}

function projectAuthenticationAuditDto(row: AuthenticationAuditEventDto): AuthenticationAuditEventDto {
  return {
    id: row.id,
    occurred_at: row.occurred_at,
    event: row.event,
    actor_user_id: row.actor_user_id,
    actor_sub: row.actor_sub,
    capability: row.capability,
    elevation_acr: row.elevation_acr,
    elevation_amr: [...row.elevation_amr],
    result: row.result,
    error_code: row.error_code,
    correlation_id: row.correlation_id,
    client_ip: row.client_ip,
    user_agent: row.user_agent,
  };
}
