import { sql } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import type { DrizzleTx } from '../../database/db-utils.js';
import type { AuditHmacKeyMaterial } from '../../security/auditHmacKey.js';
import { computeAdminAuditChainHmac } from './AdminAuditChain.js';
import {
  stringifyBoundedAdminAuditJson,
  validateConsoleAdminAuditEvent,
  type ConsoleAdminAuditEvent,
  type IAdminAuditWriter,
} from './IAdminAuditWriter.js';

export interface AdminAuditHmacKeyResolver {
  resolve(): Promise<AuditHmacKeyMaterial>;
  resolveForKeyId?(keyId: string): Promise<AuditHmacKeyMaterial | null>;
}

interface ChainHeadRow {
  readonly last_sequence_id: number | string | null;
  readonly last_chain_hmac: Buffer | null;
}

interface InsertedAuditRow {
  readonly sequence_id: number | string;
  readonly chain_hmac: Buffer;
}

const ADMIN_AUDIT_STREAM_ID = 'admin';

export class PostgresAdminAuditWriter implements IAdminAuditWriter {
  constructor(
    private readonly db: DatabaseInstance,
    private readonly hmacKeyResolver: AdminAuditHmacKeyResolver,
  ) {}

  async write(event: ConsoleAdminAuditEvent): Promise<void> {
    await withSystemContext(this.db, tx => appendConsoleAdminAuditEventWithTx(tx, event, this.hmacKeyResolver));
  }
}

export async function appendConsoleAdminAuditEventWithTx(
  tx: DrizzleTx,
  event: ConsoleAdminAuditEvent,
  hmacKeyResolver: AdminAuditHmacKeyResolver,
): Promise<void> {
  validateConsoleAdminAuditEvent(event);
  const keyMaterial = await hmacKeyResolver.resolve();
  const argsRedactedJson = stringifyBoundedAdminAuditJson(event.argsRedacted, 'argsRedacted');
  const resultDetailRedactedJson = event.resultDetailRedacted
    ? stringifyBoundedAdminAuditJson(event.resultDetailRedacted, 'resultDetailRedacted')
    : null;

  await tx.execute(sql`
        INSERT INTO admin_audit_chain_heads (stream_id)
        VALUES (${ADMIN_AUDIT_STREAM_ID})
        ON CONFLICT (stream_id) DO NOTHING
      `);
  const headRows = await tx.execute(sql`
        SELECT last_sequence_id, last_chain_hmac
        FROM admin_audit_chain_heads
        WHERE stream_id = ${ADMIN_AUDIT_STREAM_ID}
        FOR UPDATE
      `) as unknown as ChainHeadRow[];
  const head = headRows.at(0);
  if (!head) {
    throw new Error('admin audit chain head is unavailable');
  }
  const chainPrev = head.last_chain_hmac ? Buffer.from(head.last_chain_hmac) : null;
  const chainHmac = computeAdminAuditChainHmac(event, keyMaterial.key, chainPrev);
  const rows = await tx.execute(sql`
        INSERT INTO admin_audit_events (
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
        )
        VALUES (
          ${event.occurredAt},
          ${event.actorUserId},
          ${event.actorSub},
          ${event.actorRole},
          ${event.actorCapabilityRole},
          ${event.actorConsoleSessionHash},
          ${event.capability},
          ${event.elevationAcr},
          ${event.elevationAmr},
          ${event.elevationAuthTime},
          ${event.endpoint},
          ${event.operation},
          ${event.resourceKind},
          ${event.resourceId},
          ${event.targetUserId},
          ${argsRedactedJson}::jsonb,
          ${event.result},
          ${event.errorCode},
          ${resultDetailRedactedJson}::jsonb,
          ${event.correlationId},
          ${event.clientIp}::inet,
          ${event.userAgent},
          ${keyMaterial.keyId},
          ${chainPrev},
          ${chainHmac}
        )
        RETURNING sequence_id, chain_hmac
      `) as unknown as InsertedAuditRow[];
  const inserted = rows.at(0);
  if (!inserted) {
    throw new Error('admin audit append did not return a row');
  }
  await tx.execute(sql`
        UPDATE admin_audit_chain_heads
        SET last_sequence_id = ${Number(inserted.sequence_id)},
            last_chain_hmac = ${inserted.chain_hmac},
            updated_at = NOW()
        WHERE stream_id = ${ADMIN_AUDIT_STREAM_ID}
      `);
}
