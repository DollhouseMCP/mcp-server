import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { FileMemoryOwnerSnapshots } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { MAX_FILE_MEMORY_ABORT_INTENT_BYTES, parseFileMemoryAbortIntent, serializeFileMemoryAbortIntent,
  type FileMemoryAbortIntent } from '../../../src/storage/FileMemoryAbortIntentCodec.js';

const ownerId = 'ABCDEF12-1234-4123-8123-ABCDEF123456';
const operationId = 'fedcba98-1234-4123-9123-fedcba987654';
const fileIdentity = { device: '0', inode: '98765432109876543210', size: '123', ctimeNs: '-1', mtimeNs: '0' };
function intent(locator = 'memories/Éxisting.YAML'): FileMemoryAbortIntent {
  const basename = createHash('sha256').update(path.posix.basename(locator)).digest('hex');
  return { schema: 2, state: 'ABORTING_WRITE', userId: 'tenant-user', ownerId, operationId, locator,
    oldRevision: '9223372036854775806', newRevision: '9223372036854775807',
    oldContentHash: 'a'.repeat(64), newContentHash: 'b'.repeat(64), oldFileIdentity: { ...fileIdentity },
    preparedTempName: `.${basename}.memory-write.${ownerId}.${operationId}.tmp`, preparedTempIdentity: { ...fileIdentity },
    preparedJournalHash: 'c'.repeat(64), preparedJournalIdentity: { ...fileIdentity },
    oldSidecarHash: 'd'.repeat(64), oldSidecarIdentity: { ...fileIdentity },
    oldRegistryHash: 'e'.repeat(64), oldRegistryIdentity: { ...fileIdentity } };
}
function prepared(value: FileMemoryAbortIntent): Record<string, unknown> {
  const { preparedJournalHash: _journalHash, preparedJournalIdentity: _journalIdentity,
    oldSidecarHash: _sidecarHash, oldSidecarIdentity: _sidecarIdentity,
    oldRegistryHash: _registryHash, oldRegistryIdentity: _registryIdentity, ...original } = value;
  return { ...original, schema: 1, state: 'PREPARED_WRITE' };
}
// Exercise the unchanged schema-1 validator without constructing any filesystem authority.
const legacy = Object.create(FileMemoryOwnerSnapshots.prototype) as { validJournal(value: unknown): boolean };

describe('dormant file memory abort intent codec', () => {
  it('round trips exact retained identities and freezes independent nested values', () => {
    const original = intent();
    const raw = serializeFileMemoryAbortIntent(original);
    expect(Buffer.byteLength(raw)).toBeLessThan(MAX_FILE_MEMORY_ABORT_INTENT_BYTES);
    const parsed = parseFileMemoryAbortIntent(Buffer.from(raw));
    expect(parsed).toEqual(original);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.oldFileIdentity)).toBe(true);
    expect(parsed.oldFileIdentity).not.toBe(original.oldFileIdentity);
    expect(raw.endsWith('\n')).toBe(true);
  });

  it.each(['memories/Éxisting.YAML', 'memories/UPPER.MD', '目录/记忆.yaml', 'nested/path/Name with spaces.yaml'])('preserves actual locator compatibility with schema 1: %s', locator => {
    const value = intent(locator);
    expect(legacy.validJournal(prepared(value))).toBe(true);
    expect(parseFileMemoryAbortIntent(serializeFileMemoryAbortIntent(value))).toEqual(value);
  });

  it('leaves schema-1 acceptance unchanged and rejects cross-protocol adoption', () => {
    const value = intent();
    expect(legacy.validJournal(prepared(value))).toBe(true);
    expect(legacy.validJournal(value)).toBe(false);
    expect(() => parseFileMemoryAbortIntent(JSON.stringify(prepared(value)))).toThrow(TypeError);
    expect(legacy.validJournal({ ...prepared(value), state: 'PUBLISHED_WRITE', publishedHeadIdentity: fileIdentity })).toBe(true);
    expect(() => parseFileMemoryAbortIntent(JSON.stringify({ ...value, state: 'PUBLISHED_WRITE' }))).toThrow(TypeError);
  });

  it.each(['../head.yaml', 'a/../head.yaml', 'a//head.yaml', '/head.yaml', 'C:\\head.yaml', 'a\\head.yaml',
    'head\0.yaml', '.memory-owners/head.yaml', '.memory-fences/head.yaml', `.${'a'.repeat(64)}.memory-write.tmp`])('rejects confined locator violations with schema-1 parity: %s', locator => {
    const value = intent(locator);
    expect(legacy.validJournal(prepared(value))).toBe(false);
    expect(() => serializeFileMemoryAbortIntent(value)).toThrow(TypeError);
  });

  it.each([
    ['schema', 1], ['schema', '2'], ['state', 'ABORTED_WRITE'], ['userId', ''],
    ['ownerId', 'abcdef12-1234-1123-8123-abcdef123456'], ['operationId', 'not-a-uuid'],
    ['oldRevision', '01'], ['newRevision', '9223372036854775808'], ['newRevision', '2'],
    ['oldContentHash', 'A'.repeat(64)], ['preparedJournalHash', 'a'.repeat(63)],
    ['oldSidecarHash', null], ['oldRegistryHash', 'x'.repeat(64)],
    ['preparedTempName', 'random.tmp'], ['preparedTempName', intent().preparedTempName.toLowerCase()],
  ])('rejects invalid exact field %s', (field, replacement) => {
    const value = { ...intent(), [field as string]: replacement };
    expect(() => parseFileMemoryAbortIntent(JSON.stringify(value))).toThrow(TypeError);
    expect(() => serializeFileMemoryAbortIntent(value as FileMemoryAbortIntent)).toThrow(TypeError);
  });

  it.each(['oldFileIdentity', 'preparedTempIdentity', 'preparedJournalIdentity', 'oldSidecarIdentity', 'oldRegistryIdentity'])('requires exact descriptor identity structure for %s', field => {
    for (const bad of [null, [], { ...fileIdentity, inode: '01' }, { ...fileIdentity, size: '-1' },
      { ...fileIdentity, ctimeNs: '-0' }, { ...fileIdentity, mtimeNs: '1.5' }, { ...fileIdentity, extra: true }]) {
      expect(() => parseFileMemoryAbortIntent(JSON.stringify({ ...intent(), [field]: bad }))).toThrow(TypeError);
    }
  });

  it('rejects missing and extra fields, arrays and malformed JSON', () => {
    for (const field of Object.keys(intent())) {
      const value = { ...intent() } as Record<string, unknown>;
      delete value[field];
      expect(() => parseFileMemoryAbortIntent(JSON.stringify(value))).toThrow(TypeError);
    }
    for (const raw of ['null', '[]', '{', JSON.stringify({ ...intent(), publishedHeadIdentity: fileIdentity }),
      JSON.stringify({ ...intent(), extra: true })]) expect(() => parseFileMemoryAbortIntent(raw)).toThrow(TypeError);
  });

  it('enforces exact UTF-8 before JSON parsing and rejects unpaired serialized surrogates', () => {
    expect(() => parseFileMemoryAbortIntent(Buffer.from([0xc0, 0xaf]))).toThrow(TypeError);
    expect(() => parseFileMemoryAbortIntent(JSON.stringify({ ...intent(), userId: '\ud800' }))).toThrow(TypeError);
    expect(() => serializeFileMemoryAbortIntent({ ...intent(), userId: '\ud800' })).toThrow(TypeError);
  });

  it('accepts exactly 8192 bytes and rejects one byte more before parsing', () => {
    const raw = serializeFileMemoryAbortIntent(intent());
    const padded = raw + ' '.repeat(MAX_FILE_MEMORY_ABORT_INTENT_BYTES - Buffer.byteLength(raw));
    expect(parseFileMemoryAbortIntent(Buffer.from(padded))).toEqual(intent());
    expect(() => parseFileMemoryAbortIntent(padded + ' ')).toThrow(TypeError);
    expect(() => parseFileMemoryAbortIntent(Buffer.from(padded + ' '))).toThrow(TypeError);
    expect(() => serializeFileMemoryAbortIntent({ ...intent(), userId: 'é'.repeat(4000) })).toThrow(TypeError);
  });
});
