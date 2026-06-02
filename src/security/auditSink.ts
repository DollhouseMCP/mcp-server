import fs from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';

import type { DatabaseInstance } from '../database/connection.js';
import { withSystemContext } from '../database/admin.js';
import { ensureDirectory } from '../paths/ensureDirectory.js';
import { resolveDataDirectory } from '../paths/resolveDataDirectory.js';

export interface DurableAuditEvent {
  eventType: string;
  actorId?: string;
  targetId?: string;
  metadata: Record<string, unknown>;
  occurredAt?: number;
}

export interface AuditSink {
  write(event: DurableAuditEvent): Promise<void>;
}

export class DatabaseAuditSink implements AuditSink {
  constructor(private readonly db: DatabaseInstance) {}

  async write(event: DurableAuditEvent): Promise<void> {
    // Raw `tx.execute(sql`...`)` over postgres-js does not serialize a JS Date
    // param — pass an ISO string cast to timestamptz instead.
    await withSystemContext(this.db, (tx) =>
      tx.execute(sql`
        INSERT INTO security_audit_events (event_type, actor_id, target_id, metadata, occurred_at)
        VALUES (
          ${event.eventType},
          ${event.actorId ?? null},
          ${event.targetId ?? null},
          ${JSON.stringify(event.metadata)}::jsonb,
          ${(event.occurredAt ? new Date(event.occurredAt) : new Date()).toISOString()}::timestamptz
        )
      `),
    );
  }
}

export class FileAuditSink implements AuditSink {
  // Default falls through to resolveDataDirectory so tests and ad-hoc
  // construction land on the platform-correct state dir. Production callers
  // pass the path explicitly from PathService.
  constructor(private readonly filePath = path.join(resolveDataDirectory('state'), 'audit', 'security_events.jsonl')) {}

  async write(event: DurableAuditEvent): Promise<void> {
    await ensureDirectory(path.dirname(this.filePath), 0o700);
    const handle = await fs.open(this.filePath, 'a', 0o600);
    try {
      // `fs.open(..., 'a', mode)` only applies the mode on CREATE; an existing
      // file keeps its previous permissions. Force 0600 every write so an
      // accidentally permissive pre-existing file gets tightened.
      await handle.chmod(0o600);
      await handle.appendFile(`${JSON.stringify({ ...event, occurredAt: event.occurredAt ?? Date.now() })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

