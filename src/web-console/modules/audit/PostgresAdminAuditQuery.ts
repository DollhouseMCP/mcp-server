import { sql } from 'drizzle-orm';

import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import type { AuditHmacKeyMaterial } from '../../../security/auditHmacKey.js';
import type { AdminAuditHmacKeyResolver } from '../../audit/PostgresAdminAuditWriter.js';
import { verifyAdminAuditRow } from '../../audit/AdminAuditChain.js';
import type {
  AdminAuditEventDto,
  AuditPageDto,
} from './AuditDtos.js';
import type {
  AuditExportQuery,
  AuditListQuery,
  IAdminAuditQuery,
} from './AuditQueries.js';

interface AdminAuditDbRow {
  readonly id: string;
  readonly sequence_id: number | string;
  readonly occurred_at: Date | string;
  readonly actor_user_id: string;
  readonly actor_sub: string;
  readonly actor_role: string | null;
  readonly actor_capability_role: string;
  readonly actor_console_session_hash: Buffer;
  readonly capability: string;
  readonly elevation_acr: string | null;
  readonly elevation_amr: readonly string[];
  readonly elevation_auth_time: Date | string | null;
  readonly endpoint: string;
  readonly operation: string;
  readonly resource_kind: string | null;
  readonly resource_id: string | null;
  readonly target_user_id: string | null;
  readonly args_redacted: unknown;
  readonly result: string;
  readonly error_code: string | null;
  readonly result_detail_redacted: unknown;
  readonly correlation_id: string;
  readonly client_ip: string | null;
  readonly user_agent: string | null;
  readonly chain_key_id: string;
  readonly chain_prev: Buffer | null;
  readonly chain_hmac: Buffer;
}

export class PostgresAdminAuditQuery implements IAdminAuditQuery {
  constructor(
    private readonly db: DatabaseInstance,
    private readonly hmacKeyResolver: AdminAuditHmacKeyResolver,
  ) {}

  async listAdminAudit(query: AuditListQuery): Promise<AuditPageDto<AdminAuditEventDto>> {
    const offset = query.cursor ? decodeCursor(query.cursor) : 0;
    const rows = await withSystemContext(this.db, tx => tx.execute(sql`
        SELECT
          id,
          sequence_id,
          occurred_at,
          actor_user_id,
          actor_sub,
          actor_role,
          actor_capability_role,
          actor_console_session_hash,
          capability,
          elevation_acr,
          elevation_amr,
          elevation_auth_time,
          endpoint,
          operation,
          resource_kind,
          resource_id,
          target_user_id,
          args_redacted,
          result,
          error_code,
          result_detail_redacted,
          correlation_id,
          client_ip,
          user_agent,
          chain_key_id,
          chain_prev,
          chain_hmac
        FROM admin_audit_events
        ORDER BY sequence_id ASC
        LIMIT ${query.limit + 1}
        OFFSET ${offset}
      `)) as unknown as AdminAuditDbRow[];
    const items = (await verifyAndProjectRows(rows.slice(0, query.limit), this.hmacKeyResolver)).items;
    return {
      items,
      page: {
        limit: query.limit,
        cursor: query.cursor,
        next_cursor: rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
      },
    };
  }

  async getAdminAudit(id: string): Promise<AdminAuditEventDto | null> {
    const rows = await withSystemContext(this.db, tx => tx.execute(sql`
        SELECT
          id,
          sequence_id,
          occurred_at,
          actor_user_id,
          actor_sub,
          actor_role,
          actor_capability_role,
          actor_console_session_hash,
          capability,
          elevation_acr,
          elevation_amr,
          elevation_auth_time,
          endpoint,
          operation,
          resource_kind,
          resource_id,
          target_user_id,
          args_redacted,
          result,
          error_code,
          result_detail_redacted,
          correlation_id,
          client_ip,
          user_agent,
          chain_key_id,
          chain_prev,
          chain_hmac
        FROM admin_audit_events
        WHERE id = ${id}
        LIMIT 1
      `)) as unknown as AdminAuditDbRow[];
    const row = rows.at(0);
    if (!row) return null;
    const keyMaterial = await resolveAuditKey(this.hmacKeyResolver, row.chain_key_id);
    return toDto(row, verifyAdminAuditRow(toChainMaterial(row), keyMaterial));
  }

  async *streamAdminAudit(query: AuditExportQuery): AsyncIterable<AdminAuditEventDto> {
    let offset = query.cursor ? decodeCursor(query.cursor) : 0;
    let previous: Buffer | null = null;
    let previousSequenceId: number | null = null;
    if (offset > 0) {
      const previousRow = await fetchAdminAuditRows(this.db, 1, offset - 1);
      const row = previousRow.at(0);
      if (row) {
        previous = Buffer.from(row.chain_hmac);
        previousSequenceId = Number(row.sequence_id);
      }
    }
    for (;;) {
      const rows = await fetchAdminAuditRows(this.db, query.batchSize, offset);
      if (rows.length === 0) return;
      const result = await verifyAndProjectRows(rows, this.hmacKeyResolver, previous, previousSequenceId);
      previous = result.previous;
      previousSequenceId = result.previousSequenceId;
      for (const item of result.items) yield item;
      offset += rows.length;
    }
  }
}

async function verifyAndProjectRows(
  rows: readonly AdminAuditDbRow[],
  hmacKeyResolver: AdminAuditHmacKeyResolver,
  initialPrevious: Buffer | null = null,
  initialPreviousSequenceId: number | null = null,
): Promise<{
  readonly items: readonly AdminAuditEventDto[];
  readonly previous: Buffer | null;
  readonly previousSequenceId: number | null;
}> {
  let previous = initialPrevious;
  let previousSequenceId = initialPreviousSequenceId;
  const projected: AdminAuditEventDto[] = [];
  for (const row of rows) {
    const material = toChainMaterial(row);
    const keyMaterial = await resolveAuditKey(hmacKeyResolver, row.chain_key_id);
    const integrity = verifyAdminAuditRow(material, keyMaterial, previous, previousSequenceId);
    previous = Buffer.from(row.chain_hmac);
    previousSequenceId = Number(row.sequence_id);
    projected.push(toDto(row, integrity));
  }
  return { items: projected, previous, previousSequenceId };
}

async function fetchAdminAuditRows(
  db: DatabaseInstance,
  limit: number,
  offset: number,
): Promise<readonly AdminAuditDbRow[]> {
  return await withSystemContext(db, tx => tx.execute(sql`
      SELECT
        id,
        sequence_id,
        occurred_at,
        actor_user_id,
        actor_sub,
        actor_role,
        actor_capability_role,
        actor_console_session_hash,
        capability,
        elevation_acr,
        elevation_amr,
        elevation_auth_time,
        endpoint,
        operation,
        resource_kind,
        resource_id,
        target_user_id,
        args_redacted,
        result,
        error_code,
        result_detail_redacted,
        correlation_id,
        client_ip,
        user_agent,
        chain_key_id,
        chain_prev,
        chain_hmac
      FROM admin_audit_events
      ORDER BY sequence_id ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `)) as unknown as AdminAuditDbRow[];
}

async function resolveAuditKey(
  hmacKeyResolver: AdminAuditHmacKeyResolver,
  keyId: string,
): Promise<AuditHmacKeyMaterial | null> {
  if (hmacKeyResolver.resolveForKeyId) {
    return hmacKeyResolver.resolveForKeyId(keyId);
  }
  const current = await hmacKeyResolver.resolve();
  return current.keyId === keyId ? current : null;
}

function toDto(
  row: AdminAuditDbRow,
  integrity: AdminAuditEventDto['integrity'],
): AdminAuditEventDto {
  return {
    id: row.id,
    sequence_id: Number(row.sequence_id),
    occurred_at: dateString(row.occurred_at),
    actor_user_id: row.actor_user_id,
    actor_sub: row.actor_sub,
    actor_role: row.actor_role === null ? null : actorRole(row.actor_role),
    actor_capability_role: actorRole(row.actor_capability_role),
    actor_console_session_hash: Buffer.from(row.actor_console_session_hash).toString('hex'),
    capability: capability(row.capability),
    elevation_acr: row.elevation_acr,
    elevation_amr: [...row.elevation_amr],
    elevation_auth_time: row.elevation_auth_time
      ? Math.floor(new Date(row.elevation_auth_time).getTime() / 1000)
      : null,
    correlation_id: row.correlation_id,
    endpoint: row.endpoint,
    operation: row.operation,
    resource_kind: row.resource_kind,
    resource_id: row.resource_id,
    target_user_id: row.target_user_id,
    args_redacted: jsonRecord(row.args_redacted),
    result: auditResult(row.result),
    error_code: row.error_code,
    result_detail_redacted: row.result_detail_redacted ? jsonRecord(row.result_detail_redacted) : null,
    client_ip: row.client_ip,
    user_agent: row.user_agent,
    chain_key_id: row.chain_key_id,
    chain_prev: row.chain_prev ? Buffer.from(row.chain_prev).toString('hex') : null,
    chain_hmac: Buffer.from(row.chain_hmac).toString('hex'),
    integrity,
  };
}

function toChainMaterial(row: AdminAuditDbRow) {
  return {
    occurredAt: new Date(row.occurred_at),
    actorUserId: row.actor_user_id,
    actorSub: row.actor_sub,
    actorRole: row.actor_role === null ? null : actorRole(row.actor_role),
    actorCapabilityRole: actorRole(row.actor_capability_role),
    actorConsoleSessionHash: Buffer.from(row.actor_console_session_hash),
    capability: capability(row.capability),
    elevationAcr: row.elevation_acr,
    elevationAmr: [...row.elevation_amr],
    elevationAuthTime: row.elevation_auth_time ? new Date(row.elevation_auth_time) : null,
    correlationId: row.correlation_id,
    endpoint: row.endpoint,
    operation: row.operation,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    targetUserId: row.target_user_id,
    argsRedacted: jsonRecord(row.args_redacted),
    result: auditResult(row.result),
    errorCode: row.error_code,
    resultDetailRedacted: row.result_detail_redacted ? jsonRecord(row.result_detail_redacted) : null,
    clientIp: row.client_ip,
    userAgent: row.user_agent,
    chainKeyId: row.chain_key_id,
    chainPrev: row.chain_prev ? Buffer.from(row.chain_prev) : null,
    chainHmac: Buffer.from(row.chain_hmac),
    sequenceId: Number(row.sequence_id),
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === 'string') {
    return JSON.parse(value) as Readonly<Record<string, unknown>>;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value)) as Readonly<Record<string, unknown>>
    : {};
}

function actorRole(value: string): AdminAuditEventDto['actor_capability_role'] {
  if (
    value === 'admin' ||
    value === 'account_admin' ||
    value === 'operator' ||
    value === 'auditor' ||
    value === 'security_admin'
  ) {
    return value;
  }
  return 'auditor';
}

function capability(value: string): AdminAuditEventDto['capability'] {
  if (
    value === 'console:self' ||
    value === 'console:admin:accounts' ||
    value === 'console:admin:operate' ||
    value === 'console:admin:audit' ||
    value === 'console:admin:security'
  ) {
    return value;
  }
  return 'console:admin:audit';
}

function auditResult(value: string): AdminAuditEventDto['result'] {
  if (
    value === 'approved' ||
    value === 'failed' ||
    value === 'replayed' ||
    value === 'rejected' ||
    value === 'conflict'
  ) {
    return value;
  }
  return 'failed';
}
