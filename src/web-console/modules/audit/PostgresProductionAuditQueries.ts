import { sql } from 'drizzle-orm';

import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import { CONSOLE_CAPABILITIES, type ConsoleCapability } from '../../platform/ConsolePlatformTypes.js';
import type {
  ApprovalAuditEventDto,
  AuditPageDto,
  AuthenticationAuditEventDto,
} from './AuditDtos.js';
import type {
  AuditListQuery,
  IApprovalAuditQuery,
  IAuthenticationAuditQuery,
} from './AuditQueries.js';

interface ApprovalAuditDbRow {
  readonly id: string;
  readonly occurred_at: Date | string;
  readonly account_correlation_id: string;
  readonly session_id: string;
  readonly tool_name: string;
  readonly operation: string | null;
  readonly result: string;
  readonly decision_source: string | null;
  readonly correlation_id: string | null;
}

interface AuthenticationAuditDbRow {
  readonly id: string;
  readonly occurred_at: number | string;
  readonly event: string;
  readonly actor_user_id: string | null;
  readonly actor_sub: string | null;
  readonly details: unknown;
}

export class PostgresApprovalAuditQuery implements IApprovalAuditQuery {
  constructor(private readonly db: DatabaseInstance) {}

  async listApprovalAudit(query: AuditListQuery): Promise<AuditPageDto<ApprovalAuditEventDto>> {
    const offset = query.cursor ? decodeCursor(query.cursor) : 0;
    const rows = await withSystemContext(this.db, tx => tx.execute(sql`
      SELECT
        id,
        occurred_at,
        account_correlation_id,
        session_id,
        tool_name,
        operation,
        result,
        decision_source,
        correlation_id
      FROM approval_audit_events
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${query.limit + 1}
      OFFSET ${offset}
    `)) as unknown as ApprovalAuditDbRow[];
    return page(rows, query, offset, toApprovalAuditDto);
  }

  async getApprovalAudit(id: string): Promise<ApprovalAuditEventDto | null> {
    const rows = await withSystemContext(this.db, tx => tx.execute(sql`
      SELECT
        id,
        occurred_at,
        account_correlation_id,
        session_id,
        tool_name,
        operation,
        result,
        decision_source,
        correlation_id
      FROM approval_audit_events
      WHERE id = ${id}
      LIMIT 1
    `)) as unknown as ApprovalAuditDbRow[];
    const row = rows.at(0);
    return row ? toApprovalAuditDto(row) : null;
  }
}

export class PostgresAuthenticationAuditQuery implements IAuthenticationAuditQuery {
  constructor(private readonly db: DatabaseInstance) {}

  async listAuthenticationAudit(query: AuditListQuery): Promise<AuditPageDto<AuthenticationAuditEventDto>> {
    const offset = query.cursor ? decodeCursor(query.cursor) : 0;
    const rows = await withSystemContext(this.db, tx => tx.execute(sql`
      SELECT
        e.id,
        e.timestamp AS occurred_at,
        e.type AS event,
        a.user_id AS actor_user_id,
        e.sub AS actor_sub,
        e.details
      FROM auth_identity_events e
      LEFT JOIN auth_accounts a ON a.sub = e.sub
      ORDER BY e.timestamp DESC, e.id DESC
      LIMIT ${query.limit + 1}
      OFFSET ${offset}
    `)) as unknown as AuthenticationAuditDbRow[];
    return page(rows, query, offset, toAuthenticationAuditDto);
  }
}

function page<TSource, TItem>(
  rows: readonly TSource[],
  query: AuditListQuery,
  offset: number,
  project: (row: TSource) => TItem,
): AuditPageDto<TItem> {
  return {
    items: rows.slice(0, query.limit).map(project),
    page: {
      limit: query.limit,
      cursor: query.cursor,
      next_cursor: rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
    },
  };
}

function toApprovalAuditDto(row: ApprovalAuditDbRow): ApprovalAuditEventDto {
  return {
    id: row.id,
    occurred_at: toIso(row.occurred_at),
    account_correlation_id: row.account_correlation_id,
    session_id: row.session_id,
    tool_name: row.tool_name,
    operation: row.operation,
    result: row.result,
    decision_source: row.decision_source,
    correlation_id: row.correlation_id,
    integrity: {
      status: 'not_available',
      chain_key_id: null,
      chain_prev: null,
      chain_hmac: null,
    },
  };
}

function toAuthenticationAuditDto(row: AuthenticationAuditDbRow): AuthenticationAuditEventDto {
  const details = recordOrEmpty(row.details);
  return {
    id: row.id,
    occurred_at: new Date(Number(row.occurred_at)).toISOString(),
    event: row.event,
    actor_user_id: row.actor_user_id,
    actor_sub: row.actor_sub,
    capability: capabilityOrNull(details.capability),
    elevation_acr: stringOrNull(details.elevation_acr ?? details.acr),
    elevation_amr: stringArrayOrEmpty(details.elevation_amr ?? details.amr),
    result: stringOrNull(details.result) ?? 'recorded',
    error_code: stringOrNull(details.error_code),
    correlation_id: stringOrNull(details.correlation_id),
    client_ip: stringOrNull(details.client_ip),
    user_agent: stringOrNull(details.user_agent),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function recordOrEmpty(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function capabilityOrNull(value: unknown): ConsoleCapability | null {
  return typeof value === 'string' && (CONSOLE_CAPABILITIES as readonly string[]).includes(value)
    ? value as ConsoleCapability
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArrayOrEmpty(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
