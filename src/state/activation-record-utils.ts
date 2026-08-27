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

export function removeActivationRecords(
  records: PersistedActivation[],
  input: NormalizedActivationInput,
): { records: PersistedActivation[]; removed: boolean } {
  const remaining = records.filter((record) => {
    if (input.identity) {
      const identityMatches = record.identity?.kind === input.identity.kind &&
        record.identity.value === input.identity.value;
      const legacyNameMatches = !record.identity && record.name === input.name;
      return !identityMatches && !legacyNameMatches;
    }
    if (input.filename) {
      const filenameMatches = record.filename === input.filename;
      const legacyNameMatches = !record.filename && record.name === input.name;
      return !filenameMatches && !legacyNameMatches;
    }
    return record.name !== input.name;
  });
  return { records: remaining, removed: remaining.length !== records.length };
}
