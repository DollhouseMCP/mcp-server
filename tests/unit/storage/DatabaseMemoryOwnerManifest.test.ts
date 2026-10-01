import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import {
  captureDatabaseMemoryOwnerManifest as capture, verifyDatabaseMemoryOwnerInvalidation as verify,
  DatabaseMemoryOwnerManifestError, MAX_MEMORY_OWNER_MANIFEST_BYTES,
} from '../../../src/storage/DatabaseMemoryOwnerManifest.js';
import type { MemoryTagAuditOwner } from '../../../src/storage/DatabaseMemoryLegacyTagAuditor.js';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function row(overrides: Partial<MemoryTagAuditOwner> = {}): MemoryTagAuditOwner {
  return { tenantId: TENANT, ownerId: OWNER, revision: '1', dirty: false, ...overrides };
}
function failure(action: () => unknown, reason: string) {
  try { action(); throw new Error('Expected refusal'); }
  catch (error) {
    expect(error).toBeInstanceOf(DatabaseMemoryOwnerManifestError);
    expect(error).toMatchObject({ code: 'EOWNERMANIFEST', reason });
    expect((error as Error).message).not.toContain(TENANT);
    expect((error as Error).message).not.toContain(OWNER);
    return error;
  }
}
const authority = { canBackfill: false, canApply: false, canActivate: false };
function projection(owners: readonly MemoryTagAuditOwner[]) {
  return { formatVersion: 1, claim: 'validated-supplied-owner-set', ownerCount: owners.length,
    owners: owners.map(value => [value.tenantId, value.ownerId, value.revision, value.dirty]), ...authority };
}

describe('pure database memory owner manifests', () => {
  it.each(['revoked-array', 'revoked-row', 'ownKeys', 'index', 'hasOwn', 'row-getter', 'length'])('sanitizes input-thrown %s exceptions without retaining their cause', kind => {
    const thrown = new DatabaseMemoryOwnerManifestError('invalid-input');
    thrown.message = TENANT;
    const throwIdentity = () => { throw thrown; };
    let input: MemoryTagAuditOwner[] = [row()];
    if (kind.startsWith('revoked')) {
      const proxy = Proxy.revocable(kind === 'revoked-array' ? input : input[0], {});
      proxy.revoke();
      input = kind === 'revoked-array' ? proxy.proxy as MemoryTagAuditOwner[] : [proxy.proxy as MemoryTagAuditOwner];
    } else if (kind === 'ownKeys') input[0] = new Proxy(input[0], { ownKeys: throwIdentity });
    else if (kind === 'row-getter') Object.defineProperty(input[0], 'revision', { enumerable: true, get: throwIdentity });
    else if (kind === 'hasOwn') input = new Proxy(input, { getOwnPropertyDescriptor: throwIdentity });
    else input = new Proxy(input, { get: (target, key, receiver) => {
      if (key === (kind === 'index' ? '0' : 'length')) throwIdentity();
      return Reflect.get(target, key, receiver);
    } });
    const error = failure(() => capture(input), 'invalid-input');
    expect(error).not.toBe(thrown);
    expect(error).not.toHaveProperty('cause');
  });
  it('rejects a proxy length object without coercing it', () => {
    let coercions = 0;
    const length = { valueOf: () => { coercions++; throw new Error(TENANT); } };
    const input = new Proxy([row()], { get: (target, key, receiver) =>
      key === 'length' ? length : Reflect.get(target, key, receiver) });
    failure(() => capture(input), 'invalid-input');
    expect(coercions).toBe(0);
  });
  it.each(['1', -1, 0.5, NaN, Infinity])('rejects invalid proxy length %s without coercion', length => {
    const input = new Proxy([row()], { get: (target, key, receiver) =>
      key === 'length' ? length : Reflect.get(target, key, receiver) });
    failure(() => capture(input), 'invalid-input');
  });
  it.each(['array', 'row'])('bounds capture and rejects %s accessor length drift without inspecting appended rows', kind => {
    const input = [row()];
    let appendedReads = 0;
    const append = () => {
      Object.defineProperty(input, 1, { get: () => { appendedReads++; return row({ ownerId: OTHER }); } });
    };
    if (kind === 'array') {
      Object.defineProperty(input, 0, { get: () => { append(); return row(); } });
    } else {
      Object.defineProperty(input[0], 'revision', { enumerable: true, get: () => { append(); return '1'; } });
    }
    failure(() => capture(input), 'invalid-input');
    expect(input).toHaveLength(2);
    expect(appendedReads).toBe(0);
  });
  it('accepts empty supplied sets without claiming database completeness or authority', () => {
    expect(capture([])).toMatchObject({ claim: 'validated-supplied-owner-set', ownerCount: 0, owners: [], ...authority });
    const result = verify([], []);
    expect(result).toMatchObject({ claim: 'exact-supplied-owner-set-invalidation', ownerCount: 0, ...authority });
    expect(result.before).toMatchObject(authority);
    expect(result.after).toMatchObject(authority);
    expect(result).not.toHaveProperty('complete');
    expect(result).not.toHaveProperty('committed');
  });
  it('canonicalizes UUID case, sorts by owner, and fingerprints the exact full envelope', () => {
    const first = row({ tenantId: TENANT.toUpperCase(), ownerId: OWNER.toUpperCase() });
    const second = row({ ownerId: OTHER });
    const result = capture([second, first]);
    expect(result).toEqual(capture([row(), second]));
    const encoded = JSON.stringify(projection([row(), second]));
    expect(result.encodedBytes).toBe(Buffer.byteLength(encoded, 'utf8'));
    expect(result.sha256).toBe(createHash('sha256').update(encoded, 'utf8').digest('hex'));
  });
  it('copies and deeply freezes all protected values without freezing caller inputs', () => {
    const source = { ...row() };
    const inputs = [source];
    const result = capture(inputs);
    const originalHash = result.sha256;
    source.revision = '500';
    inputs.push(row({ ownerId: OTHER }));
    expect(result.owners).toEqual([row()]);
    expect(result.sha256).toBe(originalHash);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.owners)).toBe(true);
    expect(Object.isFrozen(result.owners[0])).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
    expect(() => { (result.owners[0] as { revision: string }).revision = '5'; }).toThrow(TypeError);
  });
  it.each([null, {}, [null], [1], [[]], [{ ...row(), extra: 'ignored' }], [{ ...row(), dirty: 1 }],
    [{ ...row(), ownerId: 'invalid' }], [{ ...row(), tenantId: '' }], new Array(1)].map(input => ({ input })))('rejects malformed supplied rows $input', ({ input }) => {
    failure(() => capture(input as unknown as MemoryTagAuditOwner[]), 'invalid-input');
  });
  it('rejects unknown symbol and nonenumerable fields', () => {
    const extra = { ...row(), [Symbol('hidden')]: true };
    failure(() => capture([extra]), 'invalid-input');
    const hidden = Object.defineProperty({ ...row() }, 'hidden', { value: true });
    failure(() => capture([hidden]), 'invalid-input');
  });
  it.each(['0', '-1', '+1', '01', '1e3', ' 1', '1 ', '1.0', '', '9223372036854775808', '100000000000000000000', 1, 1n])(
    'rejects noncanonical or unrepresentable revision %s', revision => {
      failure(() => capture([row({ revision: revision as string })]), 'invalid-revision');
    },
  );
  it('accepts the maximum signed bigint as captured data, without claiming it can advance', () => {
    expect(capture([row({ revision: '9223372036854775807' })]).owners[0].revision).toBe('9223372036854775807');
  });
  it('rejects canonical duplicates and globally rebound owner identities', () => {
    failure(() => capture([row(), row({ ownerId: OWNER.toUpperCase(), tenantId: TENANT.toUpperCase() })]), 'duplicate-owner');
    failure(() => capture([row(), row({ tenantId: OTHER })]), 'conflicting-tenant');
  });
  it('accepts exactly 10000 bounded rows and refuses 10001 before capturing entries', () => {
    const rows = Array.from({ length: 10000 }, (_, index) => row({ ownerId: `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}` }));
    expect(capture(rows).ownerCount).toBe(10000);
    const result = verify(rows, rows.map(value => ({ ...value, revision: '2', dirty: true })));
    expect(result.encodedBytes).toBeLessThan(MAX_MEMORY_OWNER_MANIFEST_BYTES);
    const excessive = new Array<MemoryTagAuditOwner>(10001);
    Object.defineProperty(excessive, '0', { get() { throw new Error('must not inspect over-cap input'); } });
    failure(() => capture(excessive), 'owner-limit');
  });
});

describe('exact supplied UPDATE-return verification', () => {
  it('requires exact identity/+1/dirty for clean and already-dirty owners, independent of row order/case', () => {
    const before = [row(), row({ ownerId: OTHER, revision: '9007199254740993', dirty: true })];
    const returned = [row({ ownerId: OTHER.toUpperCase(), tenantId: TENANT.toUpperCase(), revision: '9007199254740994', dirty: true }), row({ revision: '2', dirty: true })];
    const result = verify(before, returned);
    expect(result.ownerCount).toBe(2);
    expect(result.before.owners[1].revision).toBe('9007199254740993');
    expect(result.after.owners[1].revision).toBe('9007199254740994');
    const encoded = JSON.stringify({ formatVersion: 1, claim: 'exact-supplied-owner-set-invalidation', ownerCount: 2,
      before: projection(result.before.owners), after: projection(result.after.owners), ...authority });
    expect(result.encodedBytes).toBe(Buffer.byteLength(encoded, 'utf8'));
    expect(result.sha256).toBe(createHash('sha256').update(encoded, 'utf8').digest('hex'));
    expect(result).toMatchObject(authority);
  });
  it('copies returned inputs and freezes the whole verification result', () => {
    const old = { ...row() };
    const current = { ...row({ revision: '2', dirty: true }) };
    const result = verify([old], [current]);
    old.ownerId = OTHER;
    current.dirty = false;
    expect(result.before.owners[0]).toEqual(row());
    expect(result.after.owners[0]).toEqual(row({ revision: '2', dirty: true }));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.before)).toBe(true);
    expect(Object.isFrozen(result.after)).toBe(true);
  });
  it.each([[], [row({ revision: '2', dirty: true }), row({ ownerId: OTHER, revision: '2', dirty: true })],
    [row({ ownerId: OTHER, revision: '2', dirty: true })], [row({ tenantId: OTHER, revision: '2', dirty: true })]].map(returned => ({ returned })))(
    'refuses missing, extra or rebound rows $returned', ({ returned }) => {
      failure(() => verify([row()], returned), 'set-mismatch');
    },
  );
  it('does not bypass returned input validation with equal counts', () => {
    failure(() => verify([row(), row({ ownerId: OTHER })], [row({ revision: '2', dirty: true }), row({ revision: '2', dirty: true })]), 'duplicate-owner');
  });
  it.each(['1', '3'])('refuses unchanged or double-advanced revision %s', revision => {
    failure(() => verify([row({ dirty: true })], [row({ revision, dirty: true })]), 'revision-mismatch');
  });
  it('refuses signed bigint advance overflow', () => {
    const maximum = row({ revision: '9223372036854775807', dirty: true });
    failure(() => verify([maximum], [maximum]), 'revision-overflow');
  });
  it('refuses a clean returned owner despite a correct revision', () => {
    failure(() => verify([row()], [row({ revision: '2' })]), 'not-dirty');
  });
  it('changes fingerprints when supplied state changes, without claiming global coverage', () => {
    expect(capture([row()]).sha256).not.toBe(capture([row({ dirty: true })]).sha256);
    expect(capture([row()]).sha256).not.toBe(capture([row({ revision: '2' })]).sha256);
    expect(verify([row()], [row({ revision: '2', dirty: true })]).ownerCount).toBe(1);
  });
});
