import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext, withUserRead } from '../database/rls.js';
import { dangerZoneBlocks, dangerZoneBlockEvidence } from '../database/schema/dangerZoneBlocks.js';
import { validateUserId } from './db-persistence-utils.js';
import type { IDangerZoneBlockStore, BlockMutation } from './IDangerZoneBlockStore.js';
import { isStateObject } from './persistence-utils.js';
import type { PersistedStateRead } from './persistence-utils.js';

type Transaction = Parameters<Parameters<DatabaseInstance['transaction']>[0]>[0];

/** User-scoped block rows with conditional releases and transactional reset evidence. */
export class DatabaseDangerZoneBlockStore implements IDangerZoneBlockStore {
  readonly location = 'PostgreSQL danger_zone_blocks';
  constructor(private readonly db: DatabaseInstance, private readonly userId: string) {
    validateUserId(userId);
  }

  async load(): Promise<PersistedStateRead<Record<string, unknown>>> {
    try {
      const rows = await withUserRead(this.db, this.userId, tx =>
        tx.select().from(dangerZoneBlocks).where(eq(dangerZoneBlocks.userId, this.userId)));
      if (rows.some(row => row.version !== 1)) return { status: 'unsupportedVersion' };
      return { status: 'loaded', value: Object.fromEntries(rows.map(row => [row.agentName, row.block])) };
    } catch (cause) {
      return { status: 'unreadable', cause };
    }
  }

  async apply(mutation: BlockMutation): Promise<boolean> {
    return withUserContext(this.db, this.userId, async tx => {
      await this.lock(tx);
      if (mutation.kind === 'clear') {
        await tx.delete(dangerZoneBlocks).where(eq(dangerZoneBlocks.userId, this.userId));
        return true;
      }
      if (mutation.kind === 'remove') {
        const rows = await tx.delete(dangerZoneBlocks).where(and(
          eq(dangerZoneBlocks.userId, this.userId), eq(dangerZoneBlocks.agentName, mutation.name),
          sql`coalesce(${dangerZoneBlocks.block}->>'eventId', ${dangerZoneBlocks.block}->>'verificationId') IS NOT DISTINCT FROM ${mutation.eventId ?? null}`,
        )).returning({ name: dangerZoneBlocks.agentName });
        return rows.length > 0;
      }
      const timestamp = isStateObject(mutation.block) && typeof mutation.block.blockedAt === 'string'
        ? new Date(mutation.block.blockedAt) : new Date(0);
      const blockedAt = Number.isNaN(timestamp.getTime()) ? new Date(0) : timestamp;
      const block = sql`${JSON.stringify(mutation.block)}::jsonb`;
      const rows = await tx.insert(dangerZoneBlocks).values({
        userId: this.userId, agentName: mutation.name, version: 1,
        block, blockedAt,
      }).onConflictDoUpdate({
        target: [dangerZoneBlocks.userId, dangerZoneBlocks.agentName],
        set: { version: 1, block, blockedAt },
        // Equal timestamps are last-writer-wins; the loser's later release is declined and reconciled.
        setWhere: sql`${dangerZoneBlocks.blockedAt} <= ${blockedAt.toISOString()}::timestamptz`,
      }).returning({ name: dangerZoneBlocks.agentName });
      return rows.length > 0;
    });
  }

  async reset(): Promise<string> {
    return withUserContext(this.db, this.userId, async tx => {
      await this.lock(tx);
      const snapshot = await tx.select().from(dangerZoneBlocks).where(eq(dangerZoneBlocks.userId, this.userId));
      const [evidence] = await tx.insert(dangerZoneBlockEvidence).values({ userId: this.userId, snapshot })
        .returning({ id: dangerZoneBlockEvidence.id });
      await tx.delete(dangerZoneBlocks).where(eq(dangerZoneBlocks.userId, this.userId));
      return `danger_zone_block_evidence:${evidence.id}`;
    });
  }

  private async lock(tx: Transaction): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'agent-block-state:' + this.userId}, 0))`);
  }
}
