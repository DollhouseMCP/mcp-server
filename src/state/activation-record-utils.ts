import { normalizeMCPAQLElementType } from '../handlers/mcp-aql/types.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import type {
  PersistedActivation,
  PersistedActivationIdentity,
} from './IActivationStateStore.js';

/** Shared alias retained for activation-store call sites. */
export { SESSION_ID_PATTERN as ACTIVATION_SESSION_ID_PATTERN } from '../services/sessionIdentity.js';

export interface NormalizedActivationInput {
  name: string;
  filename?: string;
  identity?: PersistedActivationIdentity;
}

export type ActivationUpsertResult = 'inserted' | 'updated' | 'unchanged';

export function normalizeActivationType(elementType: string): string | undefined {
  return normalizeMCPAQLElementType(elementType);
}

export function normalizeActivationIdentifier(value: string): string {
  return UnicodeValidator.normalize(value).normalizedContent.trim();
}

export function normalizeActivationIdentity(
  identity: PersistedActivationIdentity | undefined,
): PersistedActivationIdentity | undefined {
  if (
    !identity ||
    (identity.kind !== 'file' && identity.kind !== 'database') ||
    typeof identity.value !== 'string'
  ) return undefined;
  const value = normalizeActivationIdentifier(identity.value);
  return value ? { kind: identity.kind, value } : undefined;
}

export function normalizeActivationInput(
  name: string,
  filename?: string,
  identity?: PersistedActivationIdentity,
): NormalizedActivationInput | undefined {
  const normalizedName = normalizeActivationIdentifier(name);
  if (!normalizedName) return undefined;
  const normalizedFilename = typeof filename === 'string'
    ? normalizeActivationIdentifier(filename)
    : undefined;
  const normalizedIdentity = normalizeActivationIdentity(identity);
  return {
    name: normalizedName,
    ...(normalizedFilename ? { filename: normalizedFilename } : {}),
    ...(normalizedIdentity ? { identity: normalizedIdentity } : {}),
  };
}

export function normalizePersistedActivation(
  value: unknown,
): PersistedActivation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const activation = value as Partial<PersistedActivation>;
  if (typeof activation.name !== 'string') return undefined;
  const input = normalizeActivationInput(
    activation.name,
    activation.filename,
    activation.identity,
  );
  if (!input) return undefined;

  const { filename: _filename, identity: _identity, ...rest } = activation;
  return {
    ...rest,
    ...input,
    activatedAt: typeof activation.activatedAt === 'string'
      ? activation.activatedAt
      : new Date(0).toISOString(),
  };
}

export function normalizePersistedActivationMap(
  activations: Record<string, PersistedActivation[]>,
): Record<string, PersistedActivation[]> {
  const normalized: Record<string, PersistedActivation[]> = {};
  for (const [rawType, entries] of Object.entries(activations)) {
    const type = normalizeActivationType(rawType);
    if (!type || !Array.isArray(entries)) continue;
    const normalizedEntries = entries.flatMap((entry) => {
      const normalizedEntry = normalizePersistedActivation(entry);
      return normalizedEntry ? [normalizedEntry] : [];
    });
    if (normalizedEntries.length > 0) normalized[type] = normalizedEntries;
  }
  return normalized;
}

/** Mutate one type-specific activation list while preserving legacy upgrade rules. */
export function upsertActivationRecord(
  records: PersistedActivation[],
  elementType: string,
  input: NormalizedActivationInput,
  activatedAt: string,
): ActivationUpsertResult {
  const { name, filename, identity } = input;
  let activeRecord = identity
    ? records.find(record =>
      record.identity?.kind === identity.kind && record.identity.value === identity.value
    )
    : undefined;
  activeRecord ??= identity?.kind === 'file'
    ? records.find(record => !record.identity && record.filename === identity.value)
    : undefined;
  activeRecord ??= filename
    ? records.find(record => record.filename === filename)
    : undefined;
  activeRecord ??= records.find(record =>
    record.name === name && (!identity || !record.identity)
  );

  if (!activeRecord) {
    records.push({ ...input, activatedAt });
    return 'inserted';
  }

  // Replace even an unchanged activation: a repeated activation owns a new lifetime.
  const recordIndex = records.indexOf(activeRecord);
  activeRecord = { ...activeRecord };
  records[recordIndex] = activeRecord;
  let changed = false;
  if (activeRecord.name !== name) {
    activeRecord.name = name;
    changed = true;
  }
  if (filename && activeRecord.filename !== filename) {
    activeRecord.filename = filename;
    changed = true;
  }
  if (identity && (
    activeRecord.identity?.kind !== identity.kind ||
    activeRecord.identity.value !== identity.value
  )) {
    activeRecord.identity = identity;
    changed = true;
  }
  if (elementType === 'agent' && identity && activeRecord.filename) {
    delete activeRecord.filename;
    changed = true;
  }
  return changed ? 'updated' : 'unchanged';
}

/** Compare durable keys without treating a conflicting legacy filename as a name alias. */
function matchesRemovalKey(record: PersistedActivation, input: NormalizedActivationInput): boolean {
  if (!input.identity) return record.filename === input.filename;
  if (record.identity) {
    return record.identity.kind === input.identity.kind && record.identity.value === input.identity.value;
  }
  const filename = input.filename ?? (input.identity.kind === 'file' ? input.identity.value : undefined);
  return filename !== undefined && record.filename === filename;
}

export function removeActivationRecords(
  records: PersistedActivation[],
  input: NormalizedActivationInput,
  expectedRecord?: PersistedActivation,
): { records: PersistedActivation[]; removed: boolean } {
  if (expectedRecord) {
    return {
      records: records.filter(record => record !== expectedRecord),
      removed: records.includes(expectedRecord),
    };
  }
  const named = records.filter(record => record.name === input.name);
  let matches = named;
  if (input.identity || input.filename) {
    matches = records.filter(record => matchesRemovalKey(record, input));
    // Preserve migration from a single name-only record, never broaden an exact match.
    if (matches.length === 0 && named.length === 1 && !named[0].identity && !named[0].filename) {
      matches = named;
    }
  }
  const selected = new Set(matches);
  return { records: records.filter(record => !selected.has(record)), removed: selected.size > 0 };
}

/** Find the exact record just inserted by the activation store, without alias inference. */
export function recordedActivation(records: PersistedActivation[], input: Omit<PersistedActivation, 'activatedAt'>): PersistedActivation | undefined {
  const normalized = normalizeActivationInput(input.name, input.filename, input.identity);
  return normalized && records.find(record => record.name === normalized.name
    && record.filename === normalized.filename && record.identity?.kind === normalized.identity?.kind
    && record.identity?.value === normalized.identity?.value);
}
