/** Read-only qualification of legacy PostgreSQL memory heads. No writer uses this result. */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import type { UserIdResolver } from '../database/UserContext.js';
import { elements, elementTags } from '../database/schema/elements.js';
import { memoryEntries } from '../database/schema/memories.js';
import { memoryVolumes } from '../database/schema/memoryVolumes.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import { validateMemoryControlFields } from '../elements/memories/memoryYamlValidation.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { MemoryMetadataExtractor } from './MemoryMetadataExtractor.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_ROWS = 10_000;
// Row JSON projections can exceed raw YAML. The raw byte prefetch guard is
// deliberately wider than the 2 MiB UTF-16-unit recovery limit: valid CJK
// text near that limit can occupy about 6 MiB in UTF-8.
const MAX_PROJECTED_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTICS = 20;
const MAX_RAW_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;

export interface MemoryInspectionOwner { readonly userId: string; readonly memoryId: string }
export type MemoryInspectionStatus = 'equivalent' | 'divergent' | 'ambiguous' | 'ineligible';
export interface MemoryInspectionDiagnostic { readonly code: string; readonly path: string }
export interface MemoryReconciliationInspection {
  readonly status: MemoryInspectionStatus;
  readonly canApply: false;
  readonly owner: MemoryInspectionOwner;
  readonly name: string;
  readonly revision: string;
  readonly dirty: boolean;
  /** JavaScript UTF-16 code units, never bytes; null when prefetch bounds prevent reading raw YAML. */
  readonly rawUnits: number | null;
  readonly counts: { readonly rawEntries: number | null; readonly childEntries: number; readonly volumes: number };
  readonly diagnostics: readonly MemoryInspectionDiagnostic[];
  readonly diagnosticsTruncated: boolean;
}

type Parent = Pick<typeof elements.$inferSelect,
  'id' | 'name' | 'rawContent' | 'contentHash' | 'byteSize' | 'storageRevision' | 'memoryEntriesOutOfSync' |
  'metadata' | 'description' | 'version' | 'author' | 'visibility' | 'memoryType' | 'autoLoad' | 'priority'> &
  { hasBodyContent: boolean; elementCreated: string | null };
type Child = typeof memoryEntries.$inferSelect;
type ChildSnapshot = { entry: Child; timestampUnrepresentable: boolean; expiryUnrepresentable: boolean };
type EntryComparison = { ambiguous: boolean; mismatch: boolean };
type Volume = Pick<typeof memoryVolumes.$inferSelect,
  'volume' | 'sha256' | 'entryCount' | 'sealedAt' | 'firstEntryAt' | 'lastEntryAt'> &
  { sealedUnrepresentable: boolean; firstUnrepresentable: boolean; lastUnrepresentable: boolean };

function diagnostic(code: string, path: string): MemoryInspectionDiagnostic { return { code, path }; }
function dateValue(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && !(value instanceof Date)) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}
function hasUnrepresentableDate(value: unknown): boolean {
  if (dateValue(value) === undefined) return true;
  if (typeof value !== 'string') return false;
  const fraction = /\.(\d+)/u.exec(value)?.[1];
  return fraction !== undefined && /[1-9]/u.test(fraction.slice(3));
}
function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function stringOrNull(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}
function stringsOrEmpty(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
  return undefined;
}
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const value of a) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of b) {
    const remaining = counts.get(value);
    if (!remaining) return false;
    counts.set(value, remaining - 1);
  }
  return true;
}

/** A conservative inspector: never resolves ambiguity by rewriting or choosing a winner. */
export class DatabaseMemoryReconciliationInspector {
  constructor(private readonly db: DatabaseInstance, private readonly getCurrentUserId: UserIdResolver) {}

  async inspect(owner: MemoryInspectionOwner): Promise<MemoryReconciliationInspection> {
    const captured = { userId: owner.userId, memoryId: owner.memoryId };
    if (!UUID.test(captured.userId) || !UUID.test(captured.memoryId)) throw new TypeError('Memory inspection requires user and memory UUIDs');
    if (this.getCurrentUserId() !== captured.userId) throw new Error('Memory inspection owner does not match the active user');
    return this.db.transaction(async tx => {
      // Isolation/read-only must be set before set_config's SELECT starts the snapshot.
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${captured.userId}, true)`);

      const parentBounds = await tx.select({
        rawBytes: sql<number>`octet_length(${elements.rawContent})`,
        metadataBytes: sql<number>`octet_length(${elements.metadata}::text)`,
        descriptionBytes: sql<number>`coalesce(octet_length(${elements.description}), 0)`,
      }).from(elements).where(and(eq(elements.userId, captured.userId),
        eq(elements.elementType, 'memories'), eq(elements.id, captured.memoryId))).limit(1);
      if (!parentBounds[0]) {
        const error = new Error('Memory head not found') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      const [childBounds] = await tx.select({
        count: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(octet_length(row_to_json(${memoryEntries})::text)), 0)::bigint`,
      }).from(memoryEntries).where(and(eq(memoryEntries.userId, captured.userId),
        eq(memoryEntries.memoryId, captured.memoryId)));
      const [tagBounds] = await tx.select({
        count: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(octet_length(${elementTags.tag})), 0)::bigint`,
      }).from(elementTags).where(and(eq(elementTags.userId, captured.userId),
        eq(elementTags.elementId, captured.memoryId)));
      const [volumeBounds] = await tx.select({ count: sql<number>`count(*)::int` })
        .from(memoryVolumes).where(and(eq(memoryVolumes.userId, captured.userId),
          eq(memoryVolumes.memoryId, captured.memoryId)));

      const tooLarge = parentBounds[0].rawBytes > MAX_RAW_BYTES ||
        parentBounds[0].metadataBytes > MAX_METADATA_BYTES || parentBounds[0].descriptionBytes > MAX_METADATA_BYTES ||
        childBounds.count > MAX_ROWS || Number(childBounds.bytes) > MAX_PROJECTED_BYTES ||
        tagBounds.count > MAX_ROWS || Number(tagBounds.bytes) > MAX_PROJECTED_BYTES || volumeBounds.count > MAX_ROWS;
      if (tooLarge) {
        const row = await tx.select({ name: elements.name, revision: elements.storageRevision,
          dirty: elements.memoryEntriesOutOfSync })
          .from(elements).where(and(eq(elements.userId, captured.userId), eq(elements.id, captured.memoryId))).limit(1);
        return {
          status: 'ineligible' as const, canApply: false as const, owner: captured,
          name: row[0].name, revision: row[0].revision.toString(), dirty: row[0].dirty,
          rawUnits: null, counts: { rawEntries: null, childEntries: childBounds.count, volumes: volumeBounds.count },
          diagnostics: [diagnostic('resource_limit', 'head')], diagnosticsTruncated: false,
        };
      }
      const [parent] = await tx.select({
        id: elements.id, name: elements.name, rawContent: elements.rawContent,
        contentHash: elements.contentHash, byteSize: elements.byteSize,
        hasBodyContent: sql<boolean>`${elements.bodyContent} IS NOT NULL`,
        storageRevision: elements.storageRevision,
        memoryEntriesOutOfSync: elements.memoryEntriesOutOfSync,
        metadata: elements.metadata, description: elements.description,
        version: elements.version, author: elements.author,
        elementCreated: elements.elementCreated,
        visibility: elements.visibility, memoryType: elements.memoryType,
        autoLoad: elements.autoLoad, priority: elements.priority,
      }).from(elements).where(and(eq(elements.userId, captured.userId),
        eq(elements.elementType, 'memories'), eq(elements.id, captured.memoryId))).limit(1);
      await this.afterParentRead();
      const children = await tx.select({
        entry: memoryEntries,
        timestampUnrepresentable: sql<boolean>`NOT isfinite(${memoryEntries.timestamp}) OR mod(extract(microseconds from ${memoryEntries.timestamp})::numeric, 1000) <> 0`,
        expiryUnrepresentable: sql<boolean>`${memoryEntries.expiresAt} IS NOT NULL AND (NOT isfinite(${memoryEntries.expiresAt}) OR mod(extract(microseconds from ${memoryEntries.expiresAt})::numeric, 1000) <> 0)`,
      }).from(memoryEntries).where(and(eq(memoryEntries.userId, captured.userId),
        eq(memoryEntries.memoryId, captured.memoryId)))
        .orderBy(desc(memoryEntries.timestamp), asc(memoryEntries.entryId));
      const tags = await tx.select({ tag: elementTags.tag }).from(elementTags).where(and(
        eq(elementTags.userId, captured.userId), eq(elementTags.elementId, captured.memoryId)));
      const volumes = await tx.select({ volume: memoryVolumes.volume, sha256: memoryVolumes.sha256,
        entryCount: memoryVolumes.entryCount, sealedAt: memoryVolumes.sealedAt,
        firstEntryAt: memoryVolumes.firstEntryAt, lastEntryAt: memoryVolumes.lastEntryAt,
        sealedUnrepresentable: sql<boolean>`NOT isfinite(${memoryVolumes.sealedAt}) OR mod(extract(microseconds from ${memoryVolumes.sealedAt})::numeric, 1000) <> 0`,
        firstUnrepresentable: sql<boolean>`${memoryVolumes.firstEntryAt} IS NOT NULL AND (NOT isfinite(${memoryVolumes.firstEntryAt}) OR mod(extract(microseconds from ${memoryVolumes.firstEntryAt})::numeric, 1000) <> 0)`,
        lastUnrepresentable: sql<boolean>`${memoryVolumes.lastEntryAt} IS NOT NULL AND (NOT isfinite(${memoryVolumes.lastEntryAt}) OR mod(extract(microseconds from ${memoryVolumes.lastEntryAt})::numeric, 1000) <> 0)`,
      })
        .from(memoryVolumes).where(and(eq(memoryVolumes.userId, captured.userId),
          eq(memoryVolumes.memoryId, captured.memoryId))).orderBy(asc(memoryVolumes.volume));
      return this.classify(captured, parent, children, tags.map(row => row.tag), volumes);
    });
  }

  /** @internal Test-only barrier for deterministic concurrent-writer checks. */
  protected afterParentRead(): Promise<void> { return Promise.resolve(); }

  private classify(owner: MemoryInspectionOwner, parent: Parent, children: ChildSnapshot[], tags: string[], volumes: Volume[]): MemoryReconciliationInspection {
    const findings: MemoryInspectionDiagnostic[] = [];
    let findingCount = 0;
    const add = (code: string, path: string) => {
      findingCount += 1;
      if (findings.length < MAX_DIAGNOSTICS) findings.push(diagnostic(code, path));
    };
    const base = { canApply: false as const, owner, name: parent.name, revision: parent.storageRevision.toString(),
      dirty: parent.memoryEntriesOutOfSync, rawUnits: parent.rawContent.length };
    const report = (status: MemoryInspectionStatus, rawEntries: number | null): MemoryReconciliationInspection => ({
      ...base, status, counts: { rawEntries, childEntries: children.length, volumes: volumes.length },
      diagnostics: findings, diagnosticsTruncated: findingCount > MAX_DIAGNOSTICS,
    });
    if (parent.rawContent.length > MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE) {
      add('legacy_size_limit', 'rawContent');
      return report('ineligible', null);
    }
    let raw: Record<string, unknown>;
    try {
      raw = SecureYamlParser.parseRawYaml(parent.rawContent, {
        maxSize: MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE, contentPolicy: 'structure-only',
      });
      if (!validateMemoryControlFields(raw)) throw new Error('Invalid memory control fields');
    } catch {
      add('invalid_raw_yaml', 'rawContent');
      return report('ineligible', null);
    }
    const rawEntries = raw.entries === undefined ? [] : raw.entries;
    if (!Array.isArray(rawEntries)) {
      add('invalid_raw_entries', 'entries');
      return report('ineligible', null);
    }
    const ambiguous = this.checkMetadata(raw, parent, tags, volumes, add);
    const entryStatus = this.checkEntries(rawEntries, children, add);
    let status: MemoryInspectionStatus = entryStatus;
    // Any unresolvable authority/precision question wins over a separately
    // observed mismatch; callers must not infer that only entries need repair.
    if (ambiguous) status = 'ambiguous';
    return report(status, rawEntries.length);
  }

  private checkEntries(rawEntries: unknown[], children: ChildSnapshot[], add: (code: string, path: string) => void): 'equivalent' | 'divergent' | 'ambiguous' {
    let ambiguous = false;
    if (rawEntries.length !== children.length) add('entry_count_mismatch', 'entries');
    const byId = new Map(children.map(child => [child.entry.entryId, child]));
    const seen = new Set<string>();
    let mismatch = false;
    for (const [index, entry] of rawEntries.entries()) {
      const result = this.compareEntry(entry, index, byId, seen, add);
      ambiguous ||= result.ambiguous;
      mismatch ||= result.mismatch;
    }
    // A child row has no persisted sequence and the current loader orders
    // only by timestamp. Even a raw order matching our ID tie-break is not
    // proof of the loader's equal-time order.
    if (this.hasTimestampTies(rawEntries)) {
      add('unproven_equal_time_order', 'entries');
      ambiguous = true;
    }
    if (rawEntries.length === children.length &&
      !isDeepStrictEqual(rawEntries.map(entry => objectValue(entry)?.id), children.map(child => child.entry.entryId))) {
      add('raw_order_differs_from_loader', 'entries');
      ambiguous = true;
    }
    if (ambiguous) return 'ambiguous';
    if (mismatch || rawEntries.length !== children.length) return 'divergent';
    return 'equivalent';
  }

  private compareEntry(
    entry: unknown, index: number, byId: Map<string, ChildSnapshot>, seen: Set<string>,
    add: (code: string, path: string) => void,
  ): EntryComparison {
    const raw = objectValue(entry);
    const path = `entries[${index}]`;
    let ambiguous = false;
    if (raw && Object.keys(raw).some(key => ![
      'id', 'timestamp', 'content', 'sanitizedContent', 'sanitizedPatterns',
      'tags', 'metadata', 'privacyLevel', 'trustLevel', 'source', 'expiresAt',
    ].includes(key))) {
      add('unsupported_raw_entry_field', path);
      ambiguous = true;
    }
    if (raw && (raw.timestamp === undefined || raw.timestamp === null ||
      hasUnrepresentableDate(raw.timestamp) || hasUnrepresentableDate(raw.expiresAt))) {
      add('unrepresentable_raw_timestamp', path);
      ambiguous = true;
    }
    const id = raw?.id;
    if (typeof id !== 'string' || !id || seen.has(id)) {
      add('unqualified_raw_entry', path);
      return { ambiguous, mismatch: true };
    }
    seen.add(id);
    const child = byId.get(id);
    if (child && (child.timestampUnrepresentable || child.expiryUnrepresentable ||
      dateValue(child.entry.timestamp) === undefined || dateValue(child.entry.expiresAt) === undefined)) {
      add('unrepresentable_child_timestamp', path);
      ambiguous = true;
    }
    if (!child || !this.sameEntry(raw!, child.entry)) {
      add('entry_projection_mismatch', path);
      return { ambiguous, mismatch: true };
    }
    return { ambiguous, mismatch: false };
  }

  private hasTimestampTies(rawEntries: unknown[]): boolean {
    const counts = new Map<string, number>();
    for (const entry of rawEntries) {
      const time = dateValue(objectValue(entry)?.timestamp);
      if (!time) continue;
      const count = (counts.get(time) ?? 0) + 1;
      if (count > 1) return true;
      counts.set(time, count);
    }
    return false;
  }

  private sameEntry(raw: Record<string, unknown>, child: Child): boolean {
    const timestamp = dateValue(raw.timestamp);
    const expiresAt = dateValue(raw.expiresAt);
    const tags = stringsOrEmpty(raw.tags);
    const content = raw.content;
    if (!timestamp || expiresAt === undefined || !tags || typeof content !== 'string' || !content) return false;
    const sanitized = stringOrNull(raw.sanitizedContent);
    const privacy = stringOrNull(raw.privacyLevel);
    const trust = stringOrNull(raw.trustLevel);
    const source = stringOrNull(raw.source);
    if (sanitized === undefined || privacy === undefined || trust === undefined || source === undefined) return false;
    const patterns = raw.sanitizedPatterns === undefined || raw.sanitizedPatterns === null ? {} : objectValue(raw.sanitizedPatterns);
    const metadata = raw.metadata === undefined || raw.metadata === null ? {} : objectValue(raw.metadata);
    if (!patterns || !metadata) return false;
    return timestamp === dateValue(child.timestamp) &&
      expiresAt === dateValue(child.expiresAt) && content === child.content &&
      sanitized === child.sanitizedContent && privacy === child.privacyLevel &&
      trust === child.trustLevel && source === child.source &&
      isDeepStrictEqual(tags, child.tags ?? []) &&
      isDeepStrictEqual(patterns, child.sanitizedPatterns ?? {}) &&
      isDeepStrictEqual(metadata, child.entryMetadata ?? {});
  }

  private checkMetadata(
    raw: Record<string, unknown>, parent: Parent,
    tags: string[], volumes: Volume[],
    add: (code: string, path: string) => void,
  ): boolean {
    let ambiguous = false;
    const nested = objectValue(raw.metadata);
    if (raw.metadata !== undefined && !nested) { add('invalid_metadata_shape', 'metadata'); return true; }
    const source = nested ?? raw;
    if (parent.hasBodyContent) { add('unrepresented_body_content', 'bodyContent'); ambiguous = true; }
    if (parent.elementCreated !== null) { add('unrepresented_element_created', 'elementCreated'); ambiguous = true; }
    if (createHash('sha256').update(parent.rawContent, 'utf8').digest('hex') !== parent.contentHash.trim() ||
      Buffer.byteLength(parent.rawContent, 'utf8') !== parent.byteSize) {
      add('raw_integrity_mismatch', 'rawContent'); ambiguous = true;
    }
    if (nested && Object.keys(raw).some(key => !['metadata', 'entries', 'stats', 'instructions', 'extensions'].includes(key))) {
      add('mixed_metadata_sources', 'metadata'); ambiguous = true;
    }
    const { name: _name, description: _description, version: _version, author: _author,
      tags: _tags, entries: _entries, stats: _stats, ...rest } = raw;
    const expectedJson = nested ?? rest;
    if (!isDeepStrictEqual(expectedJson, parent.metadata)) { add('metadata_json_mismatch', 'metadata'); ambiguous = true; }
    const extracted = MemoryMetadataExtractor.extractMetadata(parent.rawContent, parent.name);
    const comparisons: Array<[string, unknown, unknown]> = [
      ['name', extracted.name, parent.name],
      ['description', extracted.description || '', parent.description || ''],
      ['version', extracted.version || '1.0.0', parent.version || '1.0.0'],
      ['author', extracted.author || '', parent.author || ''],
      ['memoryType', extracted.memoryType ?? null, parent.memoryType],
      ['autoLoad', extracted.autoLoad ?? null, parent.autoLoad],
      ['priority', extracted.priority ?? null, parent.priority],
      ['visibility', source.visibility ?? 'private', parent.visibility],
    ];
    for (const [field, expected, actual] of comparisons) {
      if (!isDeepStrictEqual(expected, actual)) { add('indexed_field_mismatch', field); ambiguous = true; }
    }
    if (!sameStrings(extracted.tags ?? [], tags)) { add('tags_mismatch', 'tags'); ambiguous = true; }
    if (this.checkVolumes(source.volumes, parent.id, volumes, add)) ambiguous = true;
    return ambiguous;
  }

  private checkVolumes(rawVolumes: unknown, ownerId: string, volumes: Volume[], add: (code: string, path: string) => void): boolean {
    if (rawVolumes === undefined && volumes.length === 0) return false;
    if (!Array.isArray(rawVolumes) || rawVolumes.length !== volumes.length) {
      add('volume_index_mismatch', 'metadata.volumes'); return true;
    }
    const byNumber = new Map(volumes.map(volume => [volume.volume, volume]));
    const seen = new Set<number>();
    let mismatch = false;
    for (const [index, item] of rawVolumes.entries()) {
      const raw = objectValue(item);
      const volume = byNumber.get(raw?.volume as number);
      const dates = this.volumeDates(raw, volume);
      if (this.volumeDatesUnrepresentable(raw, volume, dates)) {
        add('unrepresentable_volume_timestamp', `metadata.volumes[${index}]`);
        mismatch = true;
      }
      if (this.volumeRecordDiffers(raw, volume, ownerId, seen, dates)) {
        add('volume_record_mismatch', `metadata.volumes[${index}]`); mismatch = true;
      }
      if (typeof raw?.volume === 'number') seen.add(raw.volume);
    }
    return mismatch;
  }

  private volumeDates(raw: Record<string, unknown> | undefined, volume: Volume | undefined): (string | null | undefined)[] {
    return [raw && dateValue(raw.sealedAt), raw && dateValue(raw.firstEntryAt),
      raw && dateValue(raw.lastEntryAt), volume && dateValue(volume.sealedAt),
      volume && dateValue(volume.firstEntryAt), volume && dateValue(volume.lastEntryAt)];
  }

  private volumeDatesUnrepresentable(
    raw: Record<string, unknown> | undefined, volume: Volume | undefined,
    dates: (string | null | undefined)[],
  ): boolean {
    if (dates.includes(undefined)) return true;
    if (raw && [raw.sealedAt, raw.firstEntryAt, raw.lastEntryAt].some(hasUnrepresentableDate)) return true;
    return !!(volume?.sealedUnrepresentable || volume?.firstUnrepresentable || volume?.lastUnrepresentable);
  }

  private volumeRecordDiffers(
    raw: Record<string, unknown> | undefined, volume: Volume | undefined,
    ownerId: string, seen: Set<number>, dates: (string | null | undefined)[],
  ): boolean {
    if (!raw || !volume || typeof raw.volume !== 'number' || seen.has(raw.volume)) return true;
    if (Object.keys(raw).some(key => ![
      'volume', 'file', 'sha256', 'entryCount', 'sealedAt', 'firstEntryAt', 'lastEntryAt',
    ].includes(key))) return true;
    const expectedFile = `volumes/${ownerId}/v${String(raw.volume).padStart(4, '0')}.yaml`;
    return raw.file !== expectedFile || raw.sha256 !== volume.sha256.trim() ||
      raw.entryCount !== volume.entryCount || dates[0] !== dates[3] ||
      dates[1] !== dates[4] || dates[2] !== dates[5];
  }
}
