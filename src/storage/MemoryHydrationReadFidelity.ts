import { isDeepStrictEqual } from 'node:util';
import type { Memory } from '../elements/memories/Memory.js';

function refuse(): never { throw new Error('Memory hydration does not preserve captured data'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(new Date(value).getTime())) refuse();
  const fraction = /\.(\d+)/u.exec(value)?.[1];
  if (fraction && /[1-9]/u.test(fraction.slice(3))) refuse();
  return new Date(value).toISOString();
}

function normalizeEntries(rawEntries: unknown): unknown[] {
  const entries = rawEntries ?? [];
  if (!Array.isArray(entries)) refuse();
  return entries.map(value => {
    const entry = record(value);
    return { ...entry, timestamp: timestamp(entry.timestamp),
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt === null ? null : timestamp(entry.expiresAt) }),
      tags: entry.tags ?? [], trustLevel: entry.trustLevel || 'untrusted', source: entry.source || 'loaded' };
  });
}

/** Compare the actual quiet loader result, retaining raw ordering rather than SQL row order. */
export function assertHydratedMemoryReadFidelity(raw: Record<string, unknown>, memory: Memory,
  decodedRetentionDays: unknown): void {
  const source = raw.metadata === undefined ? raw : record(raw.metadata);
  if (source.volumes !== undefined && (!Array.isArray(source.volumes) || source.volumes.length !== 0)) refuse();
  const normalized = normalizeEntries(raw.entries);
  const serialized = JSON.parse(memory.serialize()) as { entries: unknown[] };
  if (!isDeepStrictEqual(normalized, serialized.entries) ||
      raw.extensions !== undefined && !isDeepStrictEqual(raw.extensions, memory.extensions) ||
      (raw.instructions ?? '') !== (memory.instructions ?? '')) refuse();

  // Established disk/identity fields have a separate owner/locator binder.
  // Defaults for absent fields are allowed; present authored fields must survive.
  const diskFields = new Set(['name', 'type', 'unique_id', 'format_version', 'volumes']);
  const aliases: Record<string, string> = { storage_backend: 'storageBackend', privacy_level: 'privacyLevel',
    on_full: 'onFull' };
  for (const [key, value] of Object.entries(source)) {
    if (diskFields.has(key)) continue;
    if (raw.metadata === undefined && ['entries', 'stats', 'instructions', 'extensions'].includes(key)) continue;
    const actual = (memory.metadata as unknown as Record<string, unknown>)[aliases[key] ?? key];
    assertMetadataField(key, value, actual, memory, decodedRetentionDays);
  }
}

function assertMetadataField(key: string, value: unknown, actual: unknown, memory: Memory,
  decodedRetentionDays: unknown): void {
  if (key === 'description' && value === '' && actual === undefined) return;
  if (['created', 'modified'].includes(key)) {
    if (timestamp(value) !== timestamp(actual instanceof Date ? actual.toISOString() : actual)) refuse();
    return;
  }
  if (key === 'retention_policy') {
    // Reuse the actual loader's duration interpretation, without a new parser.
    if (!isDeepStrictEqual(decodedRetentionDays, (memory.metadata as unknown as Record<string, unknown>).retentionDays)) refuse();
    return;
  }
  if (!isDeepStrictEqual(value, actual)) refuse();
}
