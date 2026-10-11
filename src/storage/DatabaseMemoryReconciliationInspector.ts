/** Read-only qualification of legacy PostgreSQL memory heads. No writer uses this result. */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import type { DrizzleTx } from '../database/db-utils.js';
import type { UserIdResolver } from '../database/UserContext.js';
import { elements, elementTags } from '../database/schema/elements.js';
import { memoryEntries } from '../database/schema/memories.js';
import { memoryVolumes } from '../database/schema/memoryVolumes.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import { validateMemoryControlFields } from '../elements/memories/memoryYamlValidation.js';
import { SecurityError } from '../errors/SecurityError.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { assertJsonNumericReadFidelity } from '../security/numericReadFidelity.js';
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
function hasUnrepresentableChildDate(child: ChildSnapshot): boolean {
  return child.timestampUnrepresentable || child.expiryUnrepresentable ||
    dateValue(child.entry.timestamp) === undefined || dateValue(child.entry.expiresAt) === undefined;
}
function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function jsonContainerOrEmpty(value: unknown): Record<string, unknown> | unknown[] | undefined {
  if (value === undefined || value === null) return {};
  return typeof value === 'object' ? value as Record<string, unknown> | unknown[] : undefined;
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

/** Apply-only first slice: numeric JSON/YAML authority is limited to safe integers. */
function hasUnqualifiedNumericPrecision(rows: readonly { kind: string; value: string }[]): boolean {
  for (const row of rows) {
    // Strip complete JSON strings, including escaped quotes, before examining
    // PostgreSQL's ORIGINAL numeric lexemes. JSON.parse would lose this evidence.
    const numericText = row.value.replace(/"(?:\\.|[^"\\])*"/gu, '""');
    const numbers = numericText.match(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/gu) ?? [];
    if (numbers.some(token => /[.eE]/u.test(token) || !Number.isSafeInteger(Number(token)))) return true;
    if (row.kind === 'parent') {
      const parent = JSON.parse(row.value) as { raw_content: string };
      try {
        SecureYamlParser.parseRawYaml(parent.raw_content, { maxSize: MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE,
          contentPolicy: 'structure-only', numericPolicy: 'safe-integers' });
      } catch (cause) {
        if (cause instanceof SecurityError && cause.code === 'YAML_NUMERIC_PRECISION') return true;
        throw cause;
      }
    }
  }
  return false;
}

async function checked<T>(checkpoint: () => void, read: () => PromiseLike<T>): Promise<T> {
  checkpoint(); const value = await read(); checkpoint(); return value;
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

      return this.inspectInTransaction(tx, captured);
    });
  }

  /** @internal Same-transaction classification; never grants apply authority. */
  async inspectInTransaction(tx: DrizzleTx, captured: MemoryInspectionOwner, checkpoint: () => void = () => undefined): Promise<MemoryReconciliationInspection> {
    return (await this.readProjection(tx, captured, checkpoint, false)).inspection;
  }

  /** Non-destructive raw-reader qualification. Ordinary RLS visibility stays ordinary. */
  async inspectGuardedReadInTransaction(tx: DrizzleTx, captured: MemoryInspectionOwner,
    checkpoint: () => void): Promise<{ inspection: MemoryReconciliationInspection; rawContent?: string }> {
    if (!UUID.test(captured.userId) || !UUID.test(captured.memoryId)) throw new TypeError('Memory inspection requires UUIDs');
    return this.readProjection(tx, captured, checkpoint, true);
  }

  private async readProjection(tx: DrizzleTx, captured: MemoryInspectionOwner, checkpoint: () => void,
    guardedRead: boolean): Promise<{ inspection: MemoryReconciliationInspection; rawContent?: string }> {
      const parentBounds = await checked(checkpoint, () => tx.select({
        rawBytes: sql<number>`octet_length(${elements.rawContent})`,
        metadataBytes: sql<number>`octet_length(${elements.metadata}::text)`,
        descriptionBytes: sql<number>`coalesce(octet_length(${elements.description}), 0)`,
      }).from(elements).where(and(eq(elements.userId, captured.userId),
        eq(elements.elementType, 'memories'), eq(elements.id, captured.memoryId))).limit(1));
      if (!parentBounds[0]) {
        const error = new Error('Memory head not found') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      const [childBounds] = await checked(checkpoint, () => tx.select({
        count: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(octet_length(row_to_json(${memoryEntries})::text)), 0)::bigint`,
      }).from(memoryEntries).where(and(eq(memoryEntries.userId, captured.userId),
        eq(memoryEntries.memoryId, captured.memoryId))));
      const [tagBounds] = await checked(checkpoint, () => tx.select({
        count: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(octet_length(${elementTags.tag})), 0)::bigint`,
      }).from(elementTags).where(and(eq(elementTags.userId, captured.userId),
        eq(elementTags.elementId, captured.memoryId))));
      const [volumeBounds] = await checked(checkpoint, () => tx.select({ count: sql<number>`count(*)::int` })
        .from(memoryVolumes).where(and(eq(memoryVolumes.userId, captured.userId),
          eq(memoryVolumes.memoryId, captured.memoryId))));

      const tooLarge = parentBounds[0].rawBytes > MAX_RAW_BYTES ||
        parentBounds[0].metadataBytes > MAX_METADATA_BYTES || parentBounds[0].descriptionBytes > MAX_METADATA_BYTES ||
        childBounds.count > MAX_ROWS || Number(childBounds.bytes) > MAX_PROJECTED_BYTES ||
        tagBounds.count > MAX_ROWS || Number(tagBounds.bytes) > MAX_PROJECTED_BYTES || volumeBounds.count > MAX_ROWS;
      if (tooLarge) {
        const row = await checked(checkpoint, () => tx.select({ name: elements.name, revision: elements.storageRevision,
          dirty: elements.memoryEntriesOutOfSync })
          .from(elements).where(and(eq(elements.userId, captured.userId), eq(elements.id, captured.memoryId))).limit(1));
        return {
          inspection: { status: 'ineligible' as const, canApply: false as const, owner: captured,
          name: row[0].name, revision: row[0].revision.toString(), dirty: row[0].dirty,
          rawUnits: null, counts: { rawEntries: null, childEntries: childBounds.count, volumes: volumeBounds.count },
          diagnostics: [diagnostic('resource_limit', 'head')], diagnosticsTruncated: false },
        };
      }
      const [parent] = await checked(checkpoint, () => tx.select({
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
        eq(elements.elementType, 'memories'), eq(elements.id, captured.memoryId))).limit(1));
      await checked(checkpoint, () => this.afterParentRead());
      const children = await checked(checkpoint, () => tx.select({
        entry: memoryEntries,
        timestampUnrepresentable: sql<boolean>`NOT isfinite(${memoryEntries.timestamp}) OR mod(extract(microseconds from ${memoryEntries.timestamp})::numeric, 1000) <> 0`,
        expiryUnrepresentable: sql<boolean>`${memoryEntries.expiresAt} IS NOT NULL AND (NOT isfinite(${memoryEntries.expiresAt}) OR mod(extract(microseconds from ${memoryEntries.expiresAt})::numeric, 1000) <> 0)`,
      }).from(memoryEntries).where(and(eq(memoryEntries.userId, captured.userId),
        eq(memoryEntries.memoryId, captured.memoryId)))
        .orderBy(desc(memoryEntries.timestamp), asc(memoryEntries.entryId)));
      const tags = await checked(checkpoint, () => tx.select({ tag: elementTags.tag }).from(elementTags).where(and(
        eq(elementTags.userId, captured.userId), eq(elementTags.elementId, captured.memoryId))));
      const volumes = await checked(checkpoint, () => tx.select({ volume: memoryVolumes.volume, sha256: memoryVolumes.sha256,
        entryCount: memoryVolumes.entryCount, sealedAt: memoryVolumes.sealedAt,
        firstEntryAt: memoryVolumes.firstEntryAt, lastEntryAt: memoryVolumes.lastEntryAt,
        sealedUnrepresentable: sql<boolean>`NOT isfinite(${memoryVolumes.sealedAt}) OR mod(extract(microseconds from ${memoryVolumes.sealedAt})::numeric, 1000) <> 0`,
        firstUnrepresentable: sql<boolean>`${memoryVolumes.firstEntryAt} IS NOT NULL AND (NOT isfinite(${memoryVolumes.firstEntryAt}) OR mod(extract(microseconds from ${memoryVolumes.firstEntryAt})::numeric, 1000) <> 0)`,
        lastUnrepresentable: sql<boolean>`${memoryVolumes.lastEntryAt} IS NOT NULL AND (NOT isfinite(${memoryVolumes.lastEntryAt}) OR mod(extract(microseconds from ${memoryVolumes.lastEntryAt})::numeric, 1000) <> 0)`,
      })
        .from(memoryVolumes).where(and(eq(memoryVolumes.userId, captured.userId),
          eq(memoryVolumes.memoryId, captured.memoryId))).orderBy(asc(memoryVolumes.volume)));
      if (guardedRead) {
        // Only user JSONB fields, never typed bigint revisions/counters.
        const numericFields = await checked(checkpoint, () => tx.execute(sql`SELECT e.metadata::text AS value
          FROM public.elements e WHERE e.id=${captured.memoryId}::uuid AND e.user_id=${captured.userId}::uuid
          UNION ALL SELECT c.entry_metadata::text FROM public.memory_entries c
            WHERE c.memory_id=${captured.memoryId}::uuid AND c.user_id=${captured.userId}::uuid
          UNION ALL SELECT c.sanitized_patterns::text FROM public.memory_entries c
            WHERE c.memory_id=${captured.memoryId}::uuid AND c.user_id=${captured.userId}::uuid`));
        for (const row of numericFields) {
          if (row.value !== null) {
            if (typeof row.value !== 'string') throw new Error('Unknown JSONB numeric representation');
            assertJsonNumericReadFidelity(row.value);
          }
        }
      }
      return { inspection: this.classify(captured, parent, children, tags.map(row => row.tag), volumes, guardedRead),
        ...(guardedRead ? { rawContent: parent.rawContent } : {}) };
  }

  /** @internal Complete comparison fingerprint, not authorization. Bounds precede transfer. */
  async captureEquivalentProjection(tx: DrizzleTx, owner: MemoryInspectionOwner, checkpoint: () => void = () => undefined): Promise<{
    inspection: MemoryReconciliationInspection; projectionSha256: string | null;
  }> {
    const inspection = await this.inspectInTransaction(tx, owner, checkpoint);
    if (inspection.status !== 'equivalent' || inspection.diagnosticsTruncated || inspection.counts.volumes !== 0) {
      return { inspection, projectionSha256: null };
    }
    const bounds = await checked(checkpoint, () => tx.execute(sql`SELECT
      (SELECT pg_catalog.octet_length(pg_catalog.row_to_json(e)::text) FROM public.elements e
        WHERE e.id=${owner.memoryId}::uuid AND e.user_id=${owner.userId}::uuid AND e.element_type='memories') AS parent_bytes,
      (SELECT coalesce(sum(pg_catalog.octet_length(pg_catalog.row_to_json(t)::text)),0)::text FROM public.element_tags t
        WHERE t.element_id=${owner.memoryId}::uuid AND t.user_id=${owner.userId}::uuid) AS tag_bytes`));
    const bound = (bounds as unknown as { parent_bytes: number; tag_bytes: string }[])[0];
    if (!bound || !Number.isSafeInteger(bound.parent_bytes) || bound.parent_bytes > MAX_PROJECTED_BYTES ||
      !/^\d+$/u.test(bound.tag_bytes) || BigInt(bound.tag_bytes) > BigInt(MAX_PROJECTED_BYTES)) {
      return { inspection: { ...inspection, status: 'ineligible', diagnostics: [diagnostic('resource_limit', 'projection')] }, projectionSha256: null };
    }
    // PostgreSQL's row JSON retains all stored fields and microsecond timestamps;
    // digest its text directly rather than rounding dates through JavaScript Date.
    const rows = await checked(checkpoint, () => tx.execute(sql`SELECT 'parent' AS kind, pg_catalog.row_to_json(e)::text AS value
      FROM public.elements e WHERE e.id=${owner.memoryId}::uuid AND e.user_id=${owner.userId}::uuid AND e.element_type='memories'
      UNION ALL SELECT 'child', pg_catalog.row_to_json(c)::text FROM public.memory_entries c
        WHERE c.memory_id=${owner.memoryId}::uuid AND c.user_id=${owner.userId}::uuid
      UNION ALL SELECT 'tag', pg_catalog.row_to_json(t)::text FROM public.element_tags t
        WHERE t.element_id=${owner.memoryId}::uuid AND t.user_id=${owner.userId}::uuid`));
    const values = rows as unknown as { kind: string; value: string }[];
    if (!Array.isArray(values) || values.filter(row => row.kind === 'parent').length !== 1 ||
      values.some(row => typeof row.value !== 'string' || !['parent', 'child', 'tag'].includes(row.kind))) throw new Error('Incomplete reconciliation projection');
    if (hasUnqualifiedNumericPrecision(values)) return { inspection: { ...inspection, status: 'ineligible',
      diagnostics: [diagnostic('unrepresentable_numeric_precision', 'projection')] }, projectionSha256: null };
    const encoded = values.map(row => JSON.stringify([row.kind, row.value])).sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
    return { inspection, projectionSha256: createHash('sha256').update(JSON.stringify([1, owner.userId, owner.memoryId, encoded, 'archive-free'])).digest('hex') };
  }

  /** @internal Test-only barrier for deterministic concurrent-writer checks. */
  protected afterParentRead(): Promise<void> { return Promise.resolve(); }

  private classify(owner: MemoryInspectionOwner, parent: Parent, children: ChildSnapshot[], tags: string[], volumes: Volume[], guardedRead = false): MemoryReconciliationInspection {
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
        ...(guardedRead ? { numericPolicy: 'read-fidelity' as const } : {}),
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
    const ambiguous = this.checkMetadata(raw, parent, tags, volumes, add, guardedRead);
    const entryStatus = this.checkEntries(rawEntries, children, add, guardedRead);
    if (guardedRead && (parent.memoryEntriesOutOfSync || parent.storageRevision <= 0n || volumes.length !== 0)) {
      add('unsupported_guarded_head', 'head');
      return report('ineligible', rawEntries.length);
    }
    let status: MemoryInspectionStatus = entryStatus;
    // Any unresolvable authority/precision question wins over a separately
    // observed mismatch; callers must not infer that only entries need repair.
    if (ambiguous) status = 'ambiguous';
    return report(status, rawEntries.length);
  }

  private checkEntries(rawEntries: unknown[], children: ChildSnapshot[], add: (code: string, path: string) => void, rawAuthoritative = false): 'equivalent' | 'divergent' | 'ambiguous' {
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
    const unmatchedAmbiguous = this.checkUnmatchedChildDates(children, seen, add);
    ambiguous ||= unmatchedAmbiguous;
    // A child row has no persisted sequence and the current loader orders
    // only by timestamp. Equal-time order cannot be proven; otherwise a
    // difference from descending timestamp order is a definite mismatch.
    const unprovenOrder = !rawAuthoritative && (this.hasTimestampTies(rawEntries) ||
      this.hasTimestampTies(children.map(child => child.entry)));
    if (unprovenOrder) {
      add('unproven_equal_time_order', 'entries');
      ambiguous = true;
    }
    if (!rawAuthoritative && rawEntries.length === children.length &&
      !isDeepStrictEqual(rawEntries.map(entry => objectValue(entry)?.id), children.map(child => child.entry.entryId))) {
      add('raw_order_differs_from_loader', 'entries');
      if (unprovenOrder) ambiguous = true;
      else mismatch = true;
    }
    if (ambiguous) return 'ambiguous';
    if (mismatch || rawEntries.length !== children.length) return 'divergent';
    return 'equivalent';
  }

  private checkUnmatchedChildDates(
    children: ChildSnapshot[], seen: Set<string>, add: (code: string, path: string) => void,
  ): boolean {
    let ambiguous = false;
    for (const child of children) {
      if (seen.has(child.entry.entryId) || !hasUnrepresentableChildDate(child)) continue;
      add('unrepresentable_child_timestamp', 'entries');
      ambiguous = true;
    }
    return ambiguous;
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
    if (child && hasUnrepresentableChildDate(child)) {
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
    const patterns = jsonContainerOrEmpty(raw.sanitizedPatterns);
    const metadata = jsonContainerOrEmpty(raw.metadata);
    if (patterns === undefined || metadata === undefined) return false;
    return timestamp === dateValue(child.timestamp) &&
      expiresAt === dateValue(child.expiresAt) && content === child.content &&
      sanitized === child.sanitizedContent && privacy === child.privacyLevel &&
      trust === child.trustLevel && source === child.source &&
      // The writer stores non-null containers; SQL NULL is a distinct legacy projection.
      isDeepStrictEqual(tags, child.tags) &&
      isDeepStrictEqual(patterns, child.sanitizedPatterns) &&
      isDeepStrictEqual(metadata, child.entryMetadata);
  }

  private checkMetadata(
    raw: Record<string, unknown>, parent: Parent,
    tags: string[], volumes: Volume[],
    add: (code: string, path: string) => void,
    guardedRead = false,
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
    // Default the expected raw projection only. A stored NULL or empty version
    // is not interchangeable with the non-null values written by normal saves.
    const comparisons: Array<[string, unknown, unknown]> = [
      ...(!guardedRead ? [['name', extracted.name, parent.name] as [string, unknown, unknown]] : []),
      ['description', extracted.description || '', parent.description],
      ['version', extracted.version || '1.0.0', parent.version],
      ['author', extracted.author || '', parent.author],
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
