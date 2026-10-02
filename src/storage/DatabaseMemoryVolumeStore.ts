/** PostgreSQL storage for immutable, owner-bound memory archives. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { MemoryHeadToken } from './IMemoryHeadStore.js';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext, withUserRead } from '../database/rls.js';
import { elements } from '../database/schema/elements.js';
import { captureMemoryVolumeEntryLimit, MAX_MEMORY_VOLUME_LIST_DIAGNOSTICS, type MemoryVolumeListOptions, type MemoryVolumeObservation, type MemoryVolumeListDiagnostic } from './MemoryVolumeObservation.js';
import { memoryVolumes } from '../database/schema/memoryVolumes.js';
import type { UserIdResolver } from '../database/UserContext.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';

export const MAX_MEMORY_VOLUME_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_COLLISION_PROBES = 1000;
export const MAX_MEMORY_VOLUME_RAW_BYTES = 3 * MEMORY_CONSTANTS.MAX_YAML_SIZE;
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
  if (typeof owner.userId !== 'string' || typeof owner.memoryId !== 'string' ||
    !UUID_PATTERN.test(owner.userId) || !UUID_PATTERN.test(owner.memoryId)) {
    throw new TypeError('Memory volume owner requires durable user and memory UUIDs');
  }
}

function requireVolume(volume: number): void {
  if (!Number.isSafeInteger(volume) || volume < 1 || volume > MAX_MEMORY_VOLUME_NUMBER) {
    throw new RangeError('Memory volume number must be a positive safe integer');
  }
}

function volumeError(code: 'EVOLUMEUNSAFE' | 'EVOLUMEOWNER', message: string): Error {
  return Object.assign(new Error(message), { code });
}

function requireSource(content: string): void {
  if (typeof content !== 'string' || content.length > MEMORY_CONSTANTS.MAX_YAML_SIZE || Buffer.byteLength(content, 'utf8') > MAX_MEMORY_VOLUME_RAW_BYTES ||
    Buffer.from(content, 'utf8').toString('utf8') !== content) {
    throw volumeError('EVOLUMEUNSAFE', 'Memory volume source exceeds content bounds or is not exact UTF-8');
  }
}

function verifyContent(content: string, expectedEntries: number): void {
  requireSource(content);
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
  'id' | 'userId' | 'memoryId' | 'volume' | 'sha256' | 'entryCount' | 'firstEntryAt' | 'lastEntryAt' | 'sealedAt'> & {
    readonly sealedUnrepresentable: boolean;
    readonly firstUnrepresentable: boolean;
    readonly lastUnrepresentable: boolean;
  };

function toInfo(row: VolumeInfoRow): DatabaseMemoryVolumeInfo {
  requireVolume(row.volume);
  // Flags are mandatory evidence from PostgreSQL, before Date truncates microseconds.
  if (row.sealedUnrepresentable !== false || row.firstUnrepresentable !== false || row.lastUnrepresentable !== false) {
    throw volumeError('EVOLUMEUNSAFE', 'Memory volume timestamps cannot be represented exactly');
  }
  if (!UUID_PATTERN.test(row.id) || !UUID_PATTERN.test(row.userId) || !UUID_PATTERN.test(row.memoryId) ||
    typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256.trim()) ||
    !Number.isInteger(row.entryCount) || row.entryCount < 0 || row.entryCount > 2_147_483_647 ||
    !(row.sealedAt instanceof Date) || !Number.isFinite(row.sealedAt.getTime()) ||
    [row.firstEntryAt, row.lastEntryAt].some(date => date !== null &&
      (!(date instanceof Date) || !Number.isFinite(date.getTime()))) ||
    (row.firstEntryAt && row.lastEntryAt && row.firstEntryAt > row.lastEntryAt)) {
    throw volumeError('EVOLUMEUNSAFE', 'Memory volume metadata is invalid');
  }
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

function toRecord(row: VolumeInfoRow & { rawContent: string }): DatabaseMemoryVolumeRecord {
  return { ...toInfo(row), rawContent: row.rawContent };
}

export type DatabaseArchiveCleanupResult = Readonly<{
  status: 'removed' | 'absent' | 'refused' | 'unknown';
  /** Exact failure object, non-enumerable on returned results; never routine diagnostic output. */
  cause?: unknown;
  reason: 'removed' | 'absent' | 'mismatch' | 'referenced' | 'head' | 'unsafe' | 'resource' | 'query';
}>;
class CleanupRefusal extends Error {
  constructor(readonly reason: DatabaseArchiveCleanupResult['reason']) { super(`Archive cleanup refused: ${reason}`); }
}
const CLEANUP_ROWS = 10_000;
const CLEANUP_RAW_BYTES = 8 * 1024 * 1024;
const CLEANUP_METADATA_BYTES = 2 * 1024 * 1024;
const CLEANUP_PROJECTED_BYTES = 16 * 1024 * 1024;
function cleanupObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CleanupRefusal('unsafe');
  return value as Record<string, unknown>;
}
function cleanupDate(value: unknown, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (!(value instanceof Date) && typeof value !== 'string') throw new CleanupRefusal('unsafe');
  // Submillisecond source strings cannot be rounded into cleanup evidence.
  if (typeof value === 'string' && /\.\d{3}[1-9]|\.\d{3}0*[1-9]/u.test(value)) throw new CleanupRefusal('unsafe');
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new CleanupRefusal('unsafe');
  return date.toISOString();
}
function cleanupReferences(content: string, indexed: unknown, owner: string): Record<string, unknown>[] {
  const raw = cleanupObject(SecureYamlParser.parseRawYaml(content, {
    maxSize: MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE, contentPolicy: 'structure-only',
  }));
  const nested = raw.metadata === undefined ? undefined : cleanupObject(raw.metadata);
  if (nested && Object.keys(raw).some(key => !['metadata', 'entries', 'stats', 'instructions', 'extensions'].includes(key))) {
    throw new CleanupRefusal('unsafe');
  }
  const source = nested ?? raw;
  const projection = cleanupObject(indexed);
  if (source.volumes === undefined) {
    if (Object.hasOwn(source, 'volumes') || Object.hasOwn(projection, 'volumes')) throw new CleanupRefusal('unsafe');
    return [];
  }
  if (!Array.isArray(source.volumes)) throw new CleanupRefusal('unsafe');
  if (source.volumes.length > CLEANUP_ROWS) throw new CleanupRefusal('resource');
  const keys = ['volume', 'file', 'sha256', 'entryCount', 'sealedAt', 'firstEntryAt', 'lastEntryAt'];
  const seen = new Set<number>();
  const parse = (values: unknown): Record<string, unknown>[] => {
    if (!Array.isArray(values) || values.length > CLEANUP_ROWS) throw new CleanupRefusal('unsafe');
    seen.clear();
    return values.map(value => {
    const item = cleanupObject(value);
    if (Reflect.ownKeys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key)) ||
      !Number.isSafeInteger(item.volume) || Number(item.volume) < 1 || seen.has(Number(item.volume)) ||
      item.file !== locator(owner, Number(item.volume)) || typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(item.sha256) || !Number.isInteger(item.entryCount) ||
      Number(item.entryCount) < 0 || Number(item.entryCount) > 2_147_483_647) throw new CleanupRefusal('unsafe');
    seen.add(Number(item.volume));
    return { ...item, sealedAt: cleanupDate(item.sealedAt, false),
      firstEntryAt: cleanupDate(item.firstEntryAt, true), lastEntryAt: cleanupDate(item.lastEntryAt, true) };
    });
  };
  const references = parse(source.volumes);
  if (!isDeepStrictEqual(references, parse(projection.volumes))) throw new CleanupRefusal('unsafe');
  return references;
}

/** Validate the materialized head after its locked size admission. */
function cleanupHeadContent(parent: { raw: string; bytes: number; hash: string } | undefined): asserts parent is { raw: string; bytes: number; hash: string } {
  if (!parent || Buffer.from(parent.raw, 'utf8').toString('utf8') !== parent.raw ||
    Buffer.byteLength(parent.raw, 'utf8') !== parent.bytes ||
    createHash('sha256').update(parent.raw, 'utf8').digest('hex') !== parent.hash.trim()) throw new CleanupRefusal('unsafe');
}

export class DatabaseMemoryVolumeStore {
  constructor(private readonly db: DatabaseInstance, private readonly getCurrentUserId: UserIdResolver) {}

  private captureOwner(owner: DatabaseMemoryVolumeOwner): DatabaseMemoryVolumeOwner {
    const captured = { userId: owner.userId, memoryId: owner.memoryId };
    requireOwner(captured);
    const activeUserId = this.getCurrentUserId();
    // PostgreSQL UUID identity is case-insensitive, including returned receipts.
    if (typeof activeUserId !== 'string' || !UUID_PATTERN.test(activeUserId) ||
      activeUserId.toLowerCase() !== captured.userId.toLowerCase()) {
      throw new Error('Memory volume owner does not match the active user');
    }
    return { userId: captured.userId.toLowerCase(), memoryId: captured.memoryId.toLowerCase() };
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
        }).onConflictDoNothing({ target: [memoryVolumes.memoryId, memoryVolumes.volume] }).returning({
          ...this.metadataProjection(), rawContent: memoryVolumes.rawContent,
        });
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
    const rows = await withUserRead(this.db, captured.userId, (tx) => tx.select({
      ...this.metadataProjection(),
      byteLength: sql<number>`octet_length(${memoryVolumes.rawContent})`,
      rawContent: sql<string | null>`CASE WHEN octet_length(${memoryVolumes.rawContent}) <= ${MAX_MEMORY_VOLUME_RAW_BYTES} THEN ${memoryVolumes.rawContent} ELSE NULL END`,
    }).from(memoryVolumes).where(and(
      eq(memoryVolumes.userId, captured.userId),
      eq(memoryVolumes.memoryId, captured.memoryId),
      eq(memoryVolumes.volume, volume),
    )).limit(1));
    if (!rows[0]) return null;
    const row = rows[0];
    if (row.rawContent === null || !Number.isSafeInteger(row.byteLength) || row.byteLength < 0 ||
      row.byteLength > MAX_MEMORY_VOLUME_RAW_BYTES) {
      throw volumeError('EVOLUMEUNSAFE', 'Existing memory volume exceeds the raw-byte limit');
    }
    const record = { ...toInfo(row), rawContent: row.rawContent };
    if (record.userId !== captured.userId || record.memoryId !== captured.memoryId || record.volume !== volume) {
      throw volumeError('EVOLUMEUNSAFE', 'Memory volume attribution changed');
    }
    if (createHash('sha256').update(record.rawContent, 'utf8').digest('hex') !== record.sha256) {
      throw new Error(`Memory volume ${volume} failed SHA-256 verification`);
    }
    verifyContent(record.rawContent, record.entryCount);
    return record;
  }

  private metadataProjection() {
    return {
      id: memoryVolumes.id, userId: memoryVolumes.userId, memoryId: memoryVolumes.memoryId,
      volume: memoryVolumes.volume, sha256: memoryVolumes.sha256, entryCount: memoryVolumes.entryCount,
      firstEntryAt: memoryVolumes.firstEntryAt, lastEntryAt: memoryVolumes.lastEntryAt,
      sealedAt: memoryVolumes.sealedAt,
      sealedUnrepresentable: sql<boolean>`NOT isfinite(${memoryVolumes.sealedAt}) OR mod(extract(microseconds from ${memoryVolumes.sealedAt})::numeric, 1000) <> 0`,
      firstUnrepresentable: sql<boolean>`${memoryVolumes.firstEntryAt} IS NOT NULL AND (NOT isfinite(${memoryVolumes.firstEntryAt}) OR mod(extract(microseconds from ${memoryVolumes.firstEntryAt})::numeric, 1000) <> 0)`,
      lastUnrepresentable: sql<boolean>`${memoryVolumes.lastEntryAt} IS NOT NULL AND (NOT isfinite(${memoryVolumes.lastEntryAt}) OR mod(extract(microseconds from ${memoryVolumes.lastEntryAt})::numeric, 1000) <> 0)`,
    };
  }

  /** Metadata declarations, ordered by volume; overflow never claims a complete list. */
  async list(owner: DatabaseMemoryVolumeOwner, options: MemoryVolumeListOptions = {}): Promise<MemoryVolumeObservation<DatabaseMemoryVolumeInfo>> {
    const captured = this.captureOwner(owner);
    const entryLimit = captureMemoryVolumeEntryLimit(options);
    // The parent and bounded metadata are observed in one SQL statement. Missing
    // owner authority is distinct from an existing owner's empty archive set.
    const rows = await withUserRead(this.db, captured.userId, tx => tx.select({
      ownerId: elements.id, archive: this.metadataProjection(),
    }).from(elements).leftJoin(memoryVolumes, and(
      eq(memoryVolumes.memoryId, elements.id), eq(memoryVolumes.userId, captured.userId),
    )).where(and(eq(elements.id, captured.memoryId), eq(elements.userId, captured.userId),
      eq(elements.elementType, 'memories'))).orderBy(asc(memoryVolumes.volume)).limit(entryLimit + 1));
    if (!rows.length) throw volumeError('EVOLUMEOWNER', 'Memory volume owner is unavailable');
    const candidates = rows.flatMap(row => row.archive === null ? [] : [row.archive]);
    const entries: DatabaseMemoryVolumeInfo[] = [];
    const diagnostics: MemoryVolumeListDiagnostic[] = [];
    let diagnosticCount = 0;
    let acceptedCount = 0;
    const diagnose = (reason: MemoryVolumeListDiagnostic['reason'], message: string) => {
      diagnosticCount += 1;
      if (diagnostics.length < MAX_MEMORY_VOLUME_LIST_DIAGNOSTICS) diagnostics.push({ reason, message });
    };
    for (const row of candidates) {
      try {
        const info = toInfo(row);
        if (info.userId !== captured.userId || info.memoryId !== captured.memoryId) {
          throw volumeError('EVOLUMEUNSAFE', 'Memory volume attribution changed');
        }
        acceptedCount += 1;
        if (entries.length < entryLimit) entries.push(info);
      } catch {
        diagnose('corrupt', 'Observed archive metadata is invalid; content was not read');
      }
    }
    const overflow = candidates.length > entryLimit;
    if (overflow) diagnose('entry-limit', 'Archive enumeration exceeded the requested entry limit');
    const complete = !overflow && diagnosticCount === 0;
    return { entries, complete, returnedCount: entries.length, observedCount: candidates.length,
      acceptedCount, scannedCount: candidates.length, totalCount: complete ? candidates.length : null,
      diagnostics, diagnosticsTruncated: diagnosticCount > diagnostics.length };
  }

  /** @internal Test-only interleaving barrier; conveys no cleanup authority. */
  protected cleanupBarrier(_phase: 'parent-locked' | 'before-delete' | 'after-delete'): Promise<void> { return Promise.resolve(); }

  /** Dormant exact cleanup. Snapshot archive metadata is not held-stable inventory authority. */
  async removeUnreferenced(expected: MemoryHeadToken, receipt: DatabaseMemoryVolumeReceipt): Promise<DatabaseArchiveCleanupResult> {
    const head = { backend: expected.backend, userId: expected.userId, ownerId: expected.ownerId,
      locator: expected.locator, name: expected.name, revision: expected.revision };
    const owner = this.captureOwner(receipt);
    const target = { ...owner, id: receipt.id, volume: receipt.volume, sha256: receipt.sha256 };
    requireVolume(target.volume);
    if (head.backend !== 'database' || typeof head.userId !== 'string' || !UUID_PATTERN.test(head.userId) ||
      typeof head.ownerId !== 'string' || !UUID_PATTERN.test(head.ownerId) ||
      typeof head.locator !== 'string' || !UUID_PATTERN.test(head.locator) || head.userId.toLowerCase() !== owner.userId ||
      head.ownerId.toLowerCase() !== owner.memoryId || head.locator.toLowerCase() !== owner.memoryId ||
      typeof head.name !== 'string' || typeof head.revision !== 'string' || !/^[1-9]\d{0,18}$/u.test(head.revision) || BigInt(head.revision) > 9_223_372_036_854_775_807n ||
      typeof target.id !== 'string' || !UUID_PATTERN.test(target.id) || typeof target.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(target.sha256)) throw new TypeError('Archive cleanup requires matching head and receipt');
    target.id = target.id.toLowerCase();
    const abort = Object.freeze({});
    let failure: unknown;
    let abandoned = false;
    const result = (status: DatabaseArchiveCleanupResult['status'], reason: DatabaseArchiveCleanupResult['reason'], primary?: { cause: unknown }) => {
      const value = { status, reason };
      if (primary) Object.defineProperty(value, 'cause', { value: primary.cause, enumerable: false });
      return Object.freeze(value);
    };
    try {
      return await this.db.transaction(async tx => {
        try {
          await tx.execute(sql`SELECT set_config('app.current_user_id', ${owner.userId}, true)`);
          await tx.execute(sql`SET LOCAL lock_timeout = '1000ms'`);
          await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
          const condition = and(eq(elements.id, owner.memoryId), eq(elements.userId, owner.userId), eq(elements.elementType, 'memories'));
          const [bounds] = await tx.select({ name: elements.name, revision: elements.storageRevision,
            dirty: elements.memoryEntriesOutOfSync, rawBytes: sql<number>`octet_length(${elements.rawContent})`,
            metadataBytes: sql<number>`octet_length(${elements.metadata}::text)`
          }).from(elements).where(condition).for('update').limit(1);
          if (bounds?.name !== head.name || bounds.revision.toString() !== head.revision || bounds.dirty !== false) {
            throw new CleanupRefusal('head');
          }
          if (![bounds.rawBytes, bounds.metadataBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw new CleanupRefusal('unsafe');
          await this.cleanupBarrier('parent-locked');
          if (bounds.rawBytes > CLEANUP_RAW_BYTES || bounds.metadataBytes > CLEANUP_METADATA_BYTES) throw new CleanupRefusal('resource');
          const [parent] = await tx.select({ raw: elements.rawContent, metadata: elements.metadata,
            hash: elements.contentHash, bytes: elements.byteSize }).from(elements).where(condition).limit(1);
          cleanupHeadContent(parent);
          const references = cleanupReferences(parent.raw, parent.metadata, owner.memoryId);
          if (references.some(item => item.volume === target.volume)) throw new CleanupRefusal('referenced');
          const archiveCondition = and(eq(memoryVolumes.userId, owner.userId), eq(memoryVolumes.memoryId, owner.memoryId));
          const metadataBytes = sql<number>`octet_length(json_build_object('id', ${memoryVolumes.id}, 'volume', ${memoryVolumes.volume},
            'sha256', ${memoryVolumes.sha256}, 'entryCount', ${memoryVolumes.entryCount}, 'sealedAt', ${memoryVolumes.sealedAt},
            'firstEntryAt', ${memoryVolumes.firstEntryAt}, 'lastEntryAt', ${memoryVolumes.lastEntryAt})::text)`;
          const [archiveBounds] = await tx.select({ count: sql<number>`count(*)::int`,
            bytes: sql<string>`coalesce(sum(${metadataBytes}), 0)::text` }).from(memoryVolumes).where(archiveCondition);
          if (!archiveBounds || !Number.isSafeInteger(archiveBounds.count) || archiveBounds.count < 0 ||
            typeof archiveBounds.bytes !== 'string' || !/^(0|[1-9]\d*)$/u.test(archiveBounds.bytes)) throw new CleanupRefusal('unsafe');
          if (archiveBounds.count > CLEANUP_ROWS || BigInt(archiveBounds.bytes) > BigInt(CLEANUP_PROJECTED_BYTES)) throw new CleanupRefusal('resource');
          // READ COMMITTED may drift after the aggregate. This fetch independently caps
          // rows, excludes raw payload, and projects only fixed-width UUID/CHAR/numeric/
          // timestamp columns; at most10001 small records are materialized, never TEXT/JSON.
          const projection = this.metadataProjection();
          const rows = await tx.select({ ...projection,
            projectedBytes: metadataBytes,
          }).from(memoryVolumes).where(archiveCondition).orderBy(asc(memoryVolumes.volume)).limit(CLEANUP_ROWS + 1);
          if (rows.length > CLEANUP_ROWS || rows.reduce((sum, row) => sum + row.projectedBytes, 0) > CLEANUP_PROJECTED_BYTES) throw new CleanupRefusal('resource');
          if (rows.some(row => !Number.isSafeInteger(row.projectedBytes) || row.projectedBytes < 0)) throw new CleanupRefusal('unsafe');
          const infos = new Map(rows.map(row => { const info = toInfo(row); return [info.volume, info]; }));
          for (const reference of references) {
            const info = infos.get(Number(reference.volume));
            if (!info || info.sha256 !== reference.sha256 || info.entryCount !== reference.entryCount ||
              cleanupDate(info.sealedAt, false) !== reference.sealedAt || cleanupDate(info.firstEntryAt, true) !== reference.firstEntryAt ||
              cleanupDate(info.lastEntryAt, true) !== reference.lastEntryAt) throw new CleanupRefusal('unsafe');
          }
          const slotCondition = and(archiveCondition, eq(memoryVolumes.volume, target.volume));
          const [slot] = await tx.select({ id: memoryVolumes.id, sha256: memoryVolumes.sha256 }).from(memoryVolumes).where(slotCondition).limit(1);
          if (!slot) return result('absent', 'absent');
          if (slot.id !== target.id || slot.sha256.trim() !== target.sha256) return result('refused', 'mismatch');
          await this.cleanupBarrier('before-delete');
          if (abandoned) throw new CleanupRefusal('query');
          const removed = await tx.delete(memoryVolumes).where(and(slotCondition, eq(memoryVolumes.id, target.id),
            eq(memoryVolumes.sha256, target.sha256))).returning({ id: memoryVolumes.id });
          if (removed.length === 1) {
            await this.cleanupBarrier('after-delete');
            return result('removed', 'removed');
          }
          const [current] = await tx.select({ id: memoryVolumes.id }).from(memoryVolumes).where(slotCondition).limit(1);
          return current ? result('refused', 'mismatch') : result('absent', 'absent');
        } catch (cause) { failure = cause; throw abort; }
      }, { isolationLevel: 'read committed', accessMode: 'read write' });
    } catch (cause) {
      abandoned = true;
      if (cause === abort) return result('refused', failure instanceof CleanupRefusal ? failure.reason : 'query', { cause: failure });
      return result('unknown', 'query', { cause });
    }
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
