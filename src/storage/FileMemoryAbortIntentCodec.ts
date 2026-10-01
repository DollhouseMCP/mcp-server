/** Dormant abort-intent value codec. Parsing does not establish filesystem authority. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';

export const MAX_FILE_MEMORY_ABORT_INTENT_BYTES = 8192;
const MAX_REVISION = 9_223_372_036_854_775_807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
const RESERVED = /^\.[0-9a-f]{64}\.memory-(?:owner\.json|write)(?:\.|$)/iu;

export interface FileMemoryAbortIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly ctimeNs: string;
  readonly mtimeNs: string;
}

/** Exact original PREPARED bindings plus unchanged old-record evidence. */
export interface FileMemoryAbortIntent {
  readonly schema: 2;
  readonly state: 'ABORTING_WRITE';
  readonly userId: string;
  readonly ownerId: string;
  readonly locator: string;
  readonly operationId: string;
  readonly oldRevision: string;
  readonly newRevision: string;
  readonly oldContentHash: string;
  readonly newContentHash: string;
  readonly oldFileIdentity: FileMemoryAbortIdentity;
  readonly preparedTempName: string;
  readonly preparedTempIdentity: FileMemoryAbortIdentity;
  readonly preparedJournalHash: string;
  readonly preparedJournalIdentity: FileMemoryAbortIdentity;
  readonly oldSidecarHash: string;
  readonly oldSidecarIdentity: FileMemoryAbortIdentity;
  readonly oldRegistryHash: string;
  readonly oldRegistryIdentity: FileMemoryAbortIdentity;
}

const FIELDS = ['schema', 'state', 'userId', 'ownerId', 'locator', 'operationId',
  'oldRevision', 'newRevision', 'oldContentHash', 'newContentHash', 'oldFileIdentity',
  'preparedTempName', 'preparedTempIdentity', 'preparedJournalHash', 'preparedJournalIdentity',
  'oldSidecarHash', 'oldSidecarIdentity', 'oldRegistryHash', 'oldRegistryIdentity'] as const;
const IDENTITIES = ['oldFileIdentity', 'preparedTempIdentity', 'preparedJournalIdentity',
  'oldSidecarIdentity', 'oldRegistryIdentity'] as const;
const HASHES = ['oldContentHash', 'newContentHash', 'preparedJournalHash', 'oldSidecarHash', 'oldRegistryHash'] as const;

function invalid(): never {
  throw new TypeError('Invalid bounded file memory abort intent');
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}

function exactText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_FILE_MEMORY_ABORT_INTENT_BYTES &&
    Buffer.from(value, 'utf8').toString('utf8') === value;
}

function identity(value: unknown): FileMemoryAbortIdentity {
  const source = record(value, ['device', 'inode', 'size', 'ctimeNs', 'mtimeNs']);
  for (const key of ['device', 'inode', 'size']) {
    if (!exactText(source[key]) || !/^(?:0|[1-9]\d*)$/u.test(source[key])) return invalid();
  }
  for (const key of ['ctimeNs', 'mtimeNs']) {
    if (!exactText(source[key]) || !/^(?:0|[1-9]\d*|-[1-9]\d*)$/u.test(source[key])) return invalid();
  }
  return Object.freeze({ ...source }) as unknown as FileMemoryAbortIdentity;
}

function requireLocator(locator: string): void {
  // Match existing actual-head compatibility: uppercase and Unicode are retained.
  if (!locator || locator.includes('\0') || locator.includes('\\') ||
    path.posix.isAbsolute(locator) || path.win32.isAbsolute(locator) ||
    locator.split('/').some(part => !part || part === '.' || part === '..') ||
    ['.memory-owners', '.memory-fences'].includes(locator.split('/')[0]) ||
    RESERVED.test(path.posix.basename(locator))) invalid();
}

function validate(value: unknown): FileMemoryAbortIntent {
  const source = record(value, FIELDS);
  for (const field of FIELDS) {
    if (!IDENTITIES.includes(field as typeof IDENTITIES[number]) && field !== 'schema' && !exactText(source[field])) invalid();
  }
  if (source.schema !== 2 || source.state !== 'ABORTING_WRITE' || !source.userId ||
    !UUID.test(source.ownerId as string) || !UUID.test(source.operationId as string)) invalid();
  const old = source.oldRevision as string;
  const next = source.newRevision as string;
  if (!/^[1-9]\d{0,18}$/u.test(old) || !/^[1-9]\d{0,18}$/u.test(next) ||
    BigInt(next) > MAX_REVISION || BigInt(old) + 1n !== BigInt(next)) invalid();
  if (HASHES.some(field => !HASH.test(source[field] as string))) invalid();
  const locator = source.locator as string;
  requireLocator(locator);
  const basenameHash = createHash('sha256').update(path.posix.basename(locator)).digest('hex');
  if (source.preparedTempName !== `.${basenameHash}.memory-write.${source.ownerId}.${source.operationId}.tmp`) invalid();
  const result = { ...source };
  for (const field of IDENTITIES) result[field] = identity(source[field]);
  return Object.freeze(result) as unknown as FileMemoryAbortIntent;
}

function boundedRaw(raw: string): string {
  if (!exactText(raw) || Buffer.byteLength(raw, 'utf8') > MAX_FILE_MEMORY_ABORT_INTENT_BYTES) invalid();
  return raw;
}

/** Strict value validation only; callers must separately prove live descriptor bindings. */
export function parseFileMemoryAbortIntent(raw: string | Uint8Array): FileMemoryAbortIntent {
  if (typeof raw !== 'string') {
    if (!(raw instanceof Uint8Array) || raw.byteLength > MAX_FILE_MEMORY_ABORT_INTENT_BYTES) invalid();
    const bytes = Buffer.from(raw);
    const decoded = bytes.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(bytes)) invalid();
    raw = decoded;
  }
  const bounded = boundedRaw(raw);
  let parsed: unknown;
  try { parsed = JSON.parse(bounded); } catch { return invalid(); }
  return validate(parsed);
}

/** Produces exact UTF-8 bounded JSON without filesystem I/O or ownership authority. */
export function serializeFileMemoryAbortIntent(value: FileMemoryAbortIntent): string {
  return boundedRaw(`${JSON.stringify(validate(value))}\n`);
}
