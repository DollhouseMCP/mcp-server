import { createHash, randomUUID } from 'node:crypto';
import yaml from 'js-yaml';

import type { IElement } from '../../types/elements/IElement.js';
import type { BaseElementManager } from '../../elements/base/BaseElementManager.js';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import { logger } from '../../utils/logger.js';
import {
  canonicalizePortfolioElementName,
  clonePortfolioElementDetailRecord,
  clonePortfolioElementSummaryRecord,
  CONSOLE_PORTFOLIO_ELEMENT_TYPES,
  PortfolioElementAlreadyExistsError,
  PortfolioElementVersionConflictError,
  type ConsolePortfolioElementCreateInput,
  type ConsolePortfolioElementDeleteInput,
  type ConsolePortfolioElementDetailRecord,
  type ConsolePortfolioElementSummaryRecord,
  type ConsolePortfolioElementType,
  type ConsolePortfolioElementUpdateInput,
  type ConsolePortfolioListFilters,
  type IPortfolioElementStore,
  validatePortfolioElementDetailRecord,
} from './IPortfolioElementStore.js';

type PortfolioElementManager = Pick<BaseElementManager<IElement>,
  | 'findByName'
  | 'getFileExtension'
  | 'importElement'
  | 'list'
  | 'save'
  | 'delete'
  | 'exportElement'
  | 'validate'
>;

interface StorageSerializationCapable {
  readonly serializeElement?: (element: IElement) => Promise<string>;
}

export type ManagerBackedPortfolioManagers = Readonly<Record<ConsolePortfolioElementType, PortfolioElementManager>>;

export interface ManagerBackedPortfolioElementStoreOptions {
  readonly managers: ManagerBackedPortfolioManagers;
  readonly getCurrentUserId: () => string;
}

export class ManagerBackedPortfolioElementStore implements IPortfolioElementStore {
  constructor(private readonly options: ManagerBackedPortfolioElementStoreOptions) {}

  async summarizeByUser(userId: string): Promise<readonly ConsolePortfolioElementSummaryRecord[]> {
    return (await this.listByUser(userId)).map(clonePortfolioElementSummaryRecord);
  }

  async listByUser(
    userId: string,
    filters: ConsolePortfolioListFilters = {},
  ): Promise<readonly ConsolePortfolioElementSummaryRecord[]> {
    this.assertAmbientUser(userId);
    const types = filters.type ? [filters.type] : CONSOLE_PORTFOLIO_ELEMENT_TYPES;
    const records: ConsolePortfolioElementSummaryRecord[] = [];
    for (const type of types) {
      for (const element of await this.manager(type).list()) {
        let record: ConsolePortfolioElementSummaryRecord;
        try {
          record = await this.toRecord(userId, type, element);
        } catch (error) {
          // Listing is inert — no element is activated here — so a single
          // element whose body fails content parsing/validation (e.g. a
          // security/agent element that legitimately contains injection-like
          // example text) must NOT 500 the whole portfolio. Surface it as
          // 'invalid', built from in-memory metadata with the body withheld,
          // so the user still sees it and knows it needs attention.
          record = this.toInvalidSummaryFallback(userId, type, element, error);
        }
        const filterTag = filters.tag;
        if (filterTag && !record.tags.some(tag => tag.toLowerCase() === filterTag.toLowerCase())) {
          continue;
        }
        records.push(record);
      }
    }
    return [...records]
      .sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name))
      .map(clonePortfolioElementSummaryRecord);
  }

  async findByName(
    userId: string,
    type: ConsolePortfolioElementType,
    canonicalName: string,
  ): Promise<ConsolePortfolioElementDetailRecord | null> {
    this.assertAmbientUser(userId);
    const element = await this.findElement(type, canonicalName);
    if (!element) return null;
    return clonePortfolioElementDetailRecord(await this.toRecord(userId, type, element));
  }

  async create(input: ConsolePortfolioElementCreateInput): Promise<ConsolePortfolioElementDetailRecord> {
    this.assertAmbientUser(input.userId);
    const manager = this.manager(input.type);
    const canonicalName = canonicalizePortfolioElementName(input.name);
    if (await this.findElement(input.type, canonicalName)) {
      throw new PortfolioElementAlreadyExistsError();
    }
    const element = await manager.importElement(rawContentFromInput(input, input.type), managerFormatForType(input.type));
    await manager.save(element, elementPath(manager, canonicalName), { exclusive: true });
    // Re-read the persisted element so the returned record (and its ETag) match
    // what a subsequent GET produces — the persist/reload round-trip can
    // normalize content, so hashing the pre-save in-memory element would yield
    // an ETag the next conditional write rejects with 412.
    const persisted = (await this.findElement(input.type, canonicalName)) ?? element;
    return clonePortfolioElementDetailRecord(await this.toRecord(input.userId, input.type, persisted));
  }

  async update(input: ConsolePortfolioElementUpdateInput): Promise<ConsolePortfolioElementDetailRecord | null> {
    this.assertAmbientUser(input.userId);
    const manager = this.manager(input.type);
    const existing = await this.findElement(input.type, input.canonicalName);
    if (!existing) return null;
    const existingRecord = await this.toRecord(input.userId, input.type, existing);
    this.assertExpectedHash(input.expectedContentHash, existingRecord);

    const updatedRaw = rawContentFromInput({
      name: existingRecord.name,
      displayName: input.displayName === undefined ? existingRecord.displayName : input.displayName,
      metadata: input.metadata ?? existingRecord.metadata,
      content: input.content ?? existingRecord.content,
      tags: input.tags ?? existingRecord.tags,
    }, input.type);
    const updated = await manager.importElement(updatedRaw, managerFormatForType(input.type));
    await manager.save(updated, elementPath(manager, existingRecord.canonicalName));
    // Re-read so the returned record/ETag match a subsequent GET (see create()).
    const persisted = (await this.findElement(input.type, existingRecord.canonicalName)) ?? updated;
    return clonePortfolioElementDetailRecord(await this.toRecord(input.userId, input.type, persisted));
  }

  async delete(input: ConsolePortfolioElementDeleteInput): Promise<ConsolePortfolioElementDetailRecord | null> {
    this.assertAmbientUser(input.userId);
    const manager = this.manager(input.type);
    const existing = await this.findElement(input.type, input.canonicalName);
    if (!existing) return null;
    const existingRecord = await this.toRecord(input.userId, input.type, existing);
    this.assertExpectedHash(input.expectedContentHash, existingRecord);
    await manager.delete(elementPath(manager, existingRecord.canonicalName));
    return clonePortfolioElementDetailRecord({
      ...existingRecord,
      updatedAt: input.now,
    });
  }

  private manager(type: ConsolePortfolioElementType): PortfolioElementManager {
    return this.options.managers[type];
  }

  private async findElement(type: ConsolePortfolioElementType, canonicalName: string): Promise<IElement | undefined> {
    const normalizedName = canonicalizePortfolioElementName(canonicalName);
    const normalizedFilename = filenameStem(canonicalName);
    return (await this.manager(type).list()).find(element =>
      canonicalizePortfolioElementName(element.metadata.name) === normalizedName ||
      filenameStem(element.metadata.name) === normalizedFilename,
    );
  }

  private assertAmbientUser(userId: string): void {
    const ambientUserId = this.options.getCurrentUserId();
    if (ambientUserId !== userId) {
      throw new Error('Portfolio manager ambient user does not match authenticated console user');
    }
  }

  private assertExpectedHash(
    expectedContentHash: string | undefined,
    record: ConsolePortfolioElementDetailRecord,
  ): void {
    if (expectedContentHash !== undefined && record.contentHash !== expectedContentHash) {
      throw new PortfolioElementVersionConflictError();
    }
  }

  private async toRecord(
    userId: string,
    type: ConsolePortfolioElementType,
    element: IElement,
  ): Promise<ConsolePortfolioElementDetailRecord> {
    const rawContent = await this.rawContentFor(type, element);
    const parsed = parseRawContent(type, rawContent);
    const validation = this.manager(type).validate(element);
    const metadata = parsed.metadata;
    const name = element.metadata.name;
    const record: ConsolePortfolioElementDetailRecord = {
      userId,
      type,
      name,
      canonicalName: canonicalizePortfolioElementName(name),
      displayName: typeof metadata.name === 'string' ? metadata.name : name,
      version: 1,
      contentHash: sha256(stableContentProjection(type, metadata, parsed.content)),
      updatedAt: parseUpdatedAt(element.metadata.modified),
      validationStatus: validation.valid ? 'valid' : 'invalid',
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      metadata,
      content: parsed.content,
    };
    validatePortfolioElementDetailRecord(record);
    return record;
  }

  /**
   * Build a degraded summary for an element that could not be parsed/validated
   * during a list. Uses only the already-loaded in-memory metadata (name/tags/
   * modified) — never re-parses or exposes the offending body — and marks the
   * element 'invalid' so the UI can flag it for the user instead of the whole
   * listing failing.
   */
  private toInvalidSummaryFallback(
    userId: string,
    type: ConsolePortfolioElementType,
    element: IElement,
    error: unknown,
  ): ConsolePortfolioElementSummaryRecord {
    const metadata = element.metadata;
    const name = typeof metadata.name === 'string' && metadata.name.length > 0 ? metadata.name : 'unknown';
    const rawTags = (metadata as { readonly tags?: unknown }).tags;
    const tags = Array.isArray(rawTags)
      ? rawTags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    logger.warn(
      '[ManagerBackedPortfolioElementStore] portfolio element failed validation on list; ' +
      'surfacing as invalid instead of failing the listing',
      { type, name, reason: error instanceof Error ? error.message : String(error) },
    );
    return {
      userId,
      type,
      name,
      canonicalName: canonicalizePortfolioElementName(name),
      displayName: name,
      version: 1,
      updatedAt: parseUpdatedAt(typeof metadata.modified === 'string' ? metadata.modified : undefined),
      validationStatus: 'invalid',
      tags,
    };
  }

  private async rawContentFor(type: ConsolePortfolioElementType, element: IElement): Promise<string> {
    const manager = this.manager(type) as PortfolioElementManager & StorageSerializationCapable;
    if (typeof manager.serializeElement === 'function') {
      return manager.serializeElement(element);
    }
    return manager.exportElement(element, managerFormatForType(type));
  }
}

function rawContentFromInput(input: {
  readonly name: string;
  readonly displayName: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly content: string;
  readonly tags: readonly string[];
}, type: ConsolePortfolioElementType): string {
  // Memories are pure YAML (entries + config), NOT markdown-with-frontmatter.
  // Wrapping them in `---` frontmatter (as the other types use) buries the
  // entries in the body where MemoryManager never parses them, so emit a single
  // pure-YAML document instead.
  if (type === 'memories') return memoryYamlFromInput(input);
  const metadata = {
    ...input.metadata,
    name: input.displayName ?? input.name,
    tags: [...input.tags],
  };
  return `---\n${yaml.dump(metadata, { lineWidth: -1, noRefs: true })}---\n\n${input.content}`;
}

const MEMORY_NON_CONFIG_KEYS = new Set(['entries', 'metadata', 'stats', 'extensions', 'type']);

/**
 * Build the pure-YAML document MemoryManager.importElement expects from a console
 * create/update request. Accepts either structured memory YAML in `content`
 * (a top-level `entries:` array, or a nested `metadata:`/`entries:` document) or
 * a plain-text body, which becomes a single memory entry. Request identity
 * (name/tags) and any config-only metadata fields are folded into the document.
 */
function memoryYamlFromInput(input: {
  readonly name: string;
  readonly displayName: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly content: string;
  readonly tags: readonly string[];
}): string {
  const body = input.content.trim();
  const parsed = body ? safeYamlLoad(body) : undefined;
  const structured = isRecord(parsed) && (Array.isArray(parsed.entries) || isRecord(parsed.metadata));

  // MemoryManager only loads entries that carry id + content + timestamp
  // (Memory.isValidEntry); normalize so callers needn't hand-write entry ids.
  const entries = resolveRawMemoryEntries(parsed, structured, body).map(normalizeMemoryEntry);

  const config: Record<string, unknown> = { ...resolveMemoryConfigFromContent(parsed, structured) };
  for (const [key, value] of Object.entries(input.metadata)) {
    if (MEMORY_NON_CONFIG_KEYS.has(key) || key === 'name' || key === 'tags') continue;
    if (config[key] === undefined) config[key] = value;
  }
  config.name = input.displayName ?? input.name;
  if (input.tags.length) config.tags = [...input.tags];

  return yaml.dump({ metadata: config, entries }, { lineWidth: -1, noRefs: true });
}

// Entries come from either a parsed structured doc (`entries:` array) or a
// plain-text body folded into a single entry. Kept as a helper so the builder
// stays flat (and below the cognitive-complexity budget).
function resolveRawMemoryEntries(parsed: unknown, structured: boolean, body: string): unknown[] {
  if (!structured) return body ? [{ content: body }] : [];
  return isRecord(parsed) && Array.isArray(parsed.entries) ? parsed.entries : [];
}

// Config-only metadata carried inside structured content: an explicit
// `metadata:` block wins, otherwise everything that isn't an entry/identity key.
function resolveMemoryConfigFromContent(parsed: unknown, structured: boolean): Record<string, unknown> {
  if (!structured || !isRecord(parsed)) return {};
  return isRecord(parsed.metadata) ? { ...parsed.metadata } : pickMemoryConfig(parsed);
}

function pickMemoryConfig(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !MEMORY_NON_CONFIG_KEYS.has(key)));
}

function normalizeMemoryEntry(entry: unknown): Record<string, unknown> {
  const e: Record<string, unknown> = isRecord(entry) ? { ...entry } : { content: coerceEntryContent(entry) };
  if (typeof e.id !== 'string' || e.id.length === 0) e.id = `mem_${randomUUID()}`;
  if (typeof e.content !== 'string') e.content = coerceEntryContent(e.content);
  if (e.timestamp === undefined) e.timestamp = new Date().toISOString();
  return e;
}

// Coerce arbitrary entry content to a string: objects serialize to JSON (not
// the useless "[object Object]"), primitives via String(); null/undefined → ''.
function coerceEntryContent(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  // objects/arrays — serialize to JSON rather than the useless "[object Object]".
  return JSON.stringify(value);
}

function safeYamlLoad(value: string): unknown {
  try {
    return yaml.load(value, { schema: yaml.JSON_SCHEMA });
  } catch {
    return undefined;
  }
}

function parseRawContent(
  type: ConsolePortfolioElementType,
  rawContent: string,
): { readonly metadata: Readonly<Record<string, unknown>>; readonly content: string } {
  if (!rawContent.trimStart().startsWith('---')) {
    return parsePureYamlExport(type, rawContent);
  }
  const parsed = SecureYamlParser.parse(rawContent, { contentContext: contentContextForType(type) });
  return { metadata: jsonClone(parsed.data), content: parsed.content.trimStart() };
}

function parsePureYamlExport(
  type: ConsolePortfolioElementType,
  rawContent: string,
): { readonly metadata: Readonly<Record<string, unknown>>; readonly content: string } {
  const parsed = yaml.load(rawContent, { schema: yaml.JSON_SCHEMA });
  const record = isRecord(parsed) ? parsed : {};
  const metadata = isRecord(record.metadata) ? record.metadata : record;
  if (type === 'memories') {
    // The serialized memory nests config under `metadata` and keeps `entries` at
    // the top level; the bare projection would drop the entries entirely. Surface
    // a flat memory document (config + entries) as `content` so the detail view
    // and Raw/Download can render the memory, while `metadata` stays the config.
    return { metadata: jsonClone(metadata), content: flatMemoryYaml(record, metadata) };
  }
  return {
    metadata: jsonClone(metadata),
    content: contentFromPureYamlExport(type, record),
  };
}

function flatMemoryYaml(
  record: Readonly<Record<string, unknown>>,
  metadata: Readonly<Record<string, unknown>>,
): string {
  const flat: Record<string, unknown> = { ...metadata };
  if (Array.isArray(record.entries)) flat.entries = record.entries;
  if (typeof record.instructions === 'string') flat.instructions = record.instructions;
  return yaml.dump(flat, { lineWidth: -1, noRefs: true });
}

function contentFromPureYamlExport(type: ConsolePortfolioElementType, record: Readonly<Record<string, unknown>>): string {
  if (type === 'skills' && typeof record.instructions === 'string') return record.instructions;
  if (typeof record.content === 'string') return record.content;
  return '';
}

function managerFormatForType(type: ConsolePortfolioElementType): 'yaml' | 'markdown' {
  return type === 'memories' ? 'yaml' : 'markdown';
}

function elementPath(manager: PortfolioElementManager, canonicalName: string): string {
  return `${filenameStem(canonicalName)}${manager.getFileExtension()}`;
}

function filenameStem(value: string): string {
  return value
    .trim()
    .replaceAll(/([a-z])([A-Z])/gu, '$1-$2')
    .replaceAll(/[\s_]+/gu, '-')
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, '-')
    .replaceAll(/-+/gu, '-')
    .replaceAll(/^-|-$/gu, '');
}

function parseUpdatedAt(value: string | undefined): Date {
  if (!value) return new Date(0);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : new Date(0);
}

function contentContextForType(type: ConsolePortfolioElementType): 'persona' | 'skill' | 'template' | 'agent' | 'memory' {
  if (type === 'personas') return 'persona';
  if (type === 'skills') return 'skill';
  if (type === 'templates') return 'template';
  if (type === 'agents') return 'agent';
  return 'memory';
}

function jsonClone(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return structuredClone(value) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableContentProjection(
  type: ConsolePortfolioElementType,
  metadata: Readonly<Record<string, unknown>>,
  content: string,
): string {
  return JSON.stringify({
    type,
    metadata: stableJson(metadata),
    content,
  });
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'modified')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJson(entry)]),
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
