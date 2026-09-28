/** PostgreSQL storage for immutable, owner-bound memory archives. */
import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext, withUserRead } from '../database/rls.js';
import { memoryVolumes } from '../database/schema/memoryVolumes.js';
import type { UserIdResolver } from '../database/UserContext.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';

export const MAX_MEMORY_VOLUME_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_COLLISION_PROBES = 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Captured durable identity; callers must not re-resolve it during an operation. */
export interface DatabaseMemoryVolumeOwner {
  readonly userId: string;
  readonly memoryId: string;
}

export interface DatabaseMemoryVolumeInput {
  readonly minimumVolume: number;
  readonly rawContent: string;
  readonly entryCount: number;
  readonly firstEntryAt?: Date;
  readonly lastEntryAt?: Date;
  readonly sealedAt: Date;
}

export interface DatabaseMemoryVolumeRecord {
  readonly id: string;
  readonly userId: string;
  readonly memoryId: string;
  readonly volume: number;
  readonly file: string;
  readonly rawContent: string;
  readonly sha256: string;
  readonly entryCount: number;
  readonly firstEntryAt: Date | null;
  readonly lastEntryAt: Date | null;
  readonly sealedAt: Date;
}

/** Planning metadata; archive YAML is fetched only by read(). */
export type DatabaseMemoryVolumeInfo = Omit<DatabaseMemoryVolumeRecord, 'rawContent'>;

/** The row UUID makes rollback conditional on the exact create, even after a name is reused. */
export type DatabaseMemoryVolumeReceipt = Pick<
  DatabaseMemoryVolumeRecord, 'id' | 'userId' | 'memoryId' | 'volume' | 'sha256'
>;

function requireOwner(owner: DatabaseMemoryVolumeOwner): void {
  if (!UUID_PATTERN.test(owner.userId) || !UUID_PATTERN.test(owner.memoryId)) {
    throw new TypeError('Memory volume owner requires durable user and memory UUIDs');
  }
}

function requireVolume(volume: number): void {
  if (!Number.isSafeInteger(volume) || volume < 1 || volume > MAX_MEMORY_VOLUME_NUMBER) {
    throw new RangeError('Memory volume number must be a positive safe integer');
  }
}

function verifyContent(content: string, expectedEntries: number): void {
  const parsed = SecureYamlParser.parseRawYaml(content, {
    maxSize: MEMORY_CONSTANTS.MAX_YAML_SIZE,
    schema: 'core',
    contentPolicy: 'structure-only',
  });
  const count = Array.isArray(parsed.entries) ? parsed.entries.length : -1;
  if (count !== expectedEntries) {
    throw new Error(`Memory volume holds ${count} entries, expected ${expectedEntries}`);
  }
}

function locator(memoryId: string, volume: number): string {
  return `volumes/${memoryId}/v${String(volume).padStart(4, '0')}.yaml`;
}

type VolumeInfoRow = Pick<typeof memoryVolumes.$inferSelect,
  'id' | 'userId' | 'memoryId' | 'volume' | 'sha256' | 'entryCount' | 'firstEntryAt' | 'lastEntryAt' | 'sealedAt'>;

function toInfo(row: VolumeInfoRow): DatabaseMemoryVolumeInfo {
  requireVolume(row.volume);
  return {
    id: row.id,
    userId: row.userId,
    memoryId: row.memoryId,
    volume: row.volume,
    file: locator(row.memoryId, row.volume),
    sha256: row.sha256.trim(),
    entryCount: row.entryCount,
    firstEntryAt: row.firstEntryAt,
    lastEntryAt: row.lastEntryAt,
    sealedAt: row.sealedAt,
  };
}

function toRecord(row: typeof memoryVolumes.$inferSelect): DatabaseMemoryVolumeRecord {
  return { ...toInfo(row), rawContent: row.rawContent };
}

export class DatabaseMemoryVolumeStore {
  constructor(private readonly db: DatabaseInstance, private readonly getCurrentUserId: UserIdResolver) {}

  private captureOwner(owner: DatabaseMemoryVolumeOwner): DatabaseMemoryVolumeOwner {
    const captured = { userId: owner.userId, memoryId: owner.memoryId };
    requireOwner(captured);
    if (this.getCurrentUserId() !== captured.userId) {
      throw new Error('Memory volume owner does not match the active user');
    }
    return captured;
  }

  /** Insert only; a concurrent number collision advances to the next safe number. */
  async createExclusive(owner: DatabaseMemoryVolumeOwner, input: DatabaseMemoryVolumeInput): Promise<DatabaseMemoryVolumeRecord> {
    const captured = this.captureOwner(owner);
    const minimumVolume = input.minimumVolume;
    const entryCount = input.entryCount;
    const rawContent = input.rawContent;
    const sealedAt = new Date(input.sealedAt);
    const firstEntryAt = input.firstEntryAt ? new Date(input.firstEntryAt) : null;
    const lastEntryAt = input.lastEntryAt ? new Date(input.lastEntryAt) : null;
    requireVolume(minimumVolume);
    if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > 2_147_483_647) {
      throw new RangeError('Memory volume entry count is invalid');
    }
    if (!Number.isFinite(sealedAt.getTime()) ||
      (firstEntryAt && !Number.isFinite(firstEntryAt.getTime())) ||
      (lastEntryAt && !Number.isFinite(lastEntryAt.getTime()))) {
      throw new RangeError('Memory volume timestamp is invalid');
    }
    if (firstEntryAt && lastEntryAt && firstEntryAt > lastEntryAt) {
      throw new RangeError('Memory volume first entry timestamp is after its last entry');
    }
    verifyContent(rawContent, entryCount);
    const sha256 = createHash('sha256').update(rawContent, 'utf8').digest('hex');

    return withUserContext(this.db, captured.userId, async (tx) => {
      let volume = minimumVolume;
      for (let probe = 0; probe < MAX_COLLISION_PROBES; probe += 1) {
        const rows = await tx.insert(memoryVolumes).values({
          userId: captured.userId,
          memoryId: captured.memoryId,
          elementType: 'memories',
          volume,
          rawContent,
          sha256,
          entryCount,
          firstEntryAt,
          lastEntryAt,
          sealedAt,
        }).onConflictDoNothing({ target: [memoryVolumes.memoryId, memoryVolumes.volume] }).returning();
        if (rows[0]) return toRecord(rows[0]);
        if (volume === MAX_MEMORY_VOLUME_NUMBER) {
          throw new Error('Memory volume numbers are exhausted');
        }
        volume += 1;
      }
      throw new Error('Memory volume creation exceeded the collision limit');
    });
  }

  async read(owner: DatabaseMemoryVolumeOwner, volume: number): Promise<DatabaseMemoryVolumeRecord | null> {
    const captured = this.captureOwner(owner);
    requireVolume(volume);
    const rows = await withUserRead(this.db, captured.userId, (tx) => tx.select().from(memoryVolumes).where(and(
      eq(memoryVolumes.userId, captured.userId),
      eq(memoryVolumes.memoryId, captured.memoryId),
      eq(memoryVolumes.volume, volume),
    )).limit(1));
    if (!rows[0]) return null;
    const record = toRecord(rows[0]);
    if (createHash('sha256').update(record.rawContent, 'utf8').digest('hex') !== record.sha256) {
      throw new Error(`Memory volume ${volume} failed SHA-256 verification`);
    }
    verifyContent(record.rawContent, record.entryCount);
    return record;
  }

  /** Includes archives not yet indexed by the live head after an interrupted save. */
  async list(owner: DatabaseMemoryVolumeOwner): Promise<DatabaseMemoryVolumeInfo[]> {
    const captured = this.captureOwner(owner);
    const rows = await withUserRead(this.db, captured.userId, (tx) => tx.select({
      id: memoryVolumes.id,
      userId: memoryVolumes.userId,
      memoryId: memoryVolumes.memoryId,
      volume: memoryVolumes.volume,
      sha256: memoryVolumes.sha256,
      entryCount: memoryVolumes.entryCount,
      firstEntryAt: memoryVolumes.firstEntryAt,
      lastEntryAt: memoryVolumes.lastEntryAt,
      sealedAt: memoryVolumes.sealedAt,
    }).from(memoryVolumes).where(and(
      eq(memoryVolumes.userId, captured.userId),
      eq(memoryVolumes.memoryId, captured.memoryId),
    )).orderBy(asc(memoryVolumes.volume)));
    return rows.map(toInfo);
  }

  /** Roll back only the row created by this receipt; never delete by path or number alone. */
  async removeCreated(receipt: DatabaseMemoryVolumeReceipt): Promise<boolean> {
    const captured = this.captureOwner(receipt);
    const { id, volume, sha256 } = receipt;
    requireVolume(volume);
    const rows = await withUserContext(this.db, captured.userId, (tx) => tx.delete(memoryVolumes).where(and(
      eq(memoryVolumes.id, id),
      eq(memoryVolumes.userId, captured.userId),
      eq(memoryVolumes.memoryId, captured.memoryId),
      eq(memoryVolumes.volume, volume),
      eq(memoryVolumes.sha256, sha256),
    )).returning({ id: memoryVolumes.id }));
    return rows.length === 1;
  }

  /** Owner-wide erasure includes unindexed orphan archives. Caller coordinates head deletion. */
  async deleteAll(owner: DatabaseMemoryVolumeOwner): Promise<number> {
    const captured = this.captureOwner(owner);
    const rows = await withUserContext(this.db, captured.userId, (tx) => tx.delete(memoryVolumes).where(and(
      eq(memoryVolumes.userId, captured.userId),
      eq(memoryVolumes.memoryId, captured.memoryId),
    )).returning({ id: memoryVolumes.id }));
    return rows.length;
  }
}
