import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { withSystemContext } from '../database/admin.js';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext, withUserRead } from '../database/rls.js';
import { dangerZoneBlocks, dangerZoneBlockEvidence } from '../database/schema/dangerZoneBlocks.js';
import { validateAgentName } from '../security/validateAgentName.js';
import { validateUserId } from './db-persistence-utils.js';
import type { IDangerZoneBlockStore, BlockMutation } from './IDangerZoneBlockStore.js';
import { isStateObject } from './persistence-utils.js';
import type { PersistedStateRead } from './persistence-utils.js';

type Transaction = Parameters<Parameters<DatabaseInstance['transaction']>[0]>[0];
type BlockRow = typeof dangerZoneBlocks.$inferSelect;
type RecoveryRow = BlockRow & { revision: string };
type BlockRowIdentity = Pick<BlockRow, 'agentName' | 'version'>;

function rejectRows(rows: readonly BlockRowIdentity[]): Extract<PersistedStateRead<never>, { status: 'unsupportedVersion' | 'invalid' }> | undefined {
  if (rows.some(row => row.version !== 1)) return { status: 'unsupportedVersion' };
  const names = new Set<string>();
  try {
    for (const row of rows) {
      validateAgentName(row.agentName, 'restore');
      const name = row.agentName.trim();
      if (names.has(name)) throw new Error('Duplicate persisted agent name');
      names.add(name);
    }
  } catch (cause) {
    return { status: 'invalid', cause };
  }
  return undefined;
}

function recoveryDigest(rows: RecoveryRow[]): string | null {
  if (!rejectRows(rows)) return null;
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** User-scoped block rows with conditional releases and transactional reset evidence. */
export class DatabaseDangerZoneBlockStore implements IDangerZoneBlockStore {
  readonly location = 'PostgreSQL danger_zone_blocks';
  readonly retryRejectedSnapshots = true;
  constructor(private readonly db: DatabaseInstance, private readonly userId: string) {
    validateUserId(userId);
  }

  /** Deployment-wide setup status. Callers get only a boolean, without account or block details. */
  static async hasRejectedSnapshots(systemDb: DatabaseInstance): Promise<boolean> {
    return withSystemContext(systemDb, async tx => {
      const rows = await tx.select({
        userId: dangerZoneBlocks.userId, agentName: dangerZoneBlocks.agentName, version: dangerZoneBlocks.version,
      }).from(dangerZoneBlocks);
      const byUser = new Map<string, BlockRowIdentity[]>();
      for (const row of rows) {
        const group = byUser.get(row.userId);
        if (group) group.push(row);
        else byUser.set(row.userId, [row]);
      }
      return Array.from(byUser.values()).some(group => rejectRows(group) !== undefined);
    });
  }

  async load(): Promise<PersistedStateRead<Record<string, unknown>>> {
    try {
      const rows = await withUserRead(this.db, this.userId, tx =>
        tx.select().from(dangerZoneBlocks).where(eq(dangerZoneBlocks.userId, this.userId)));
      return rejectRows(rows) ?? { status: 'loaded', value: Object.fromEntries(rows.map(row => [row.agentName, row.block])) };
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
      return this.preserveAndClear(tx, snapshot);
    });
  }

  /** A failed query throws; it never proves there is a resettable snapshot. */
  async rejectedSnapshotDigest(): Promise<string | null> {
    return withUserRead(this.db, this.userId, async tx => recoveryDigest(await this.readRecoveryRows(tx)));
  }

  /** Called only by the secured console with its system database and mandatory audit writer. */
  async resetRejected(expectedDigest: string, audit: (tx: Transaction, evidence: string) => Promise<void>): Promise<boolean> {
    return withSystemContext(this.db, async tx => {
      await this.lock(tx);
      const rows = await this.readRecoveryRows(tx);
      if (recoveryDigest(rows) !== expectedDigest) return false;
      const evidence = await this.preserveAndClear(tx, rows.map(({ revision: _revision, ...row }) => row));
      await audit(tx, evidence);
      return true;
    });
  }

  private readRecoveryRows(tx: Transaction) {
    return tx.select({
      userId: dangerZoneBlocks.userId, agentName: dangerZoneBlocks.agentName, version: dangerZoneBlocks.version,
      block: dangerZoneBlocks.block, blockedAt: dangerZoneBlocks.blockedAt, revision: sql<string>`xmin::text`,
    }).from(dangerZoneBlocks).where(eq(dangerZoneBlocks.userId, this.userId))
      .orderBy(sql`${dangerZoneBlocks.agentName} COLLATE "C"`);
  }

  private async preserveAndClear(tx: Transaction, snapshot: readonly BlockRow[]): Promise<string> {
    const [evidence] = await tx.insert(dangerZoneBlockEvidence).values({ userId: this.userId, snapshot })
      .returning({ id: dangerZoneBlockEvidence.id });
    await tx.delete(dangerZoneBlocks).where(eq(dangerZoneBlocks.userId, this.userId));
    return `danger_zone_block_evidence:${evidence.id}`;
  }

  private async lock(tx: Transaction): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'agent-block-state:' + this.userId}, 0))`);
  }
}
