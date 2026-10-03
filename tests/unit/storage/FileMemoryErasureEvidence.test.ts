import { describe, expect, it } from '@jest/globals';
import { ERASURE_DOMAIN, ERASURE_NAMES_DOMAIN, ERASURE_NAMES_PROTOCOL, ERASURE_RECORD_LIMIT, erasureMaximumIdentity, erasurePack,
  erasureParseRecord, erasureParseSegment, erasureSegmentName, erasureSerialize, erasureInventoryDigest,
  erasureValidateRecord, erasureValidateSegment,
  type ErasureAnchor, type ErasureArtifact, type ErasureBinding, type ErasureNamespace,
  type ErasureNode, type ErasureRecord, type ErasureSegment } from '../../../src/storage/FileMemoryErasureEvidence.js';

const binding: ErasureBinding = { userId: 'fixture-user', ownerId: '11111111-1111-4111-8111-111111111111',
  deleteOperationId: '22222222-2222-4222-8222-222222222222', operationId: '33333333-3333-4333-8333-333333333333' };
const hash = 'a'.repeat(64);
const identity = { device: '1', inode: '20', size: '23', mtimeNs: '100', ctimeNs: '101' };
const artifact: ErasureArtifact = { identity, mode: '33152', uid: '501', links: '1', digest: hash };
function namespace(locator: string, inode: number): ErasureNamespace {
  return { locator, device: '1', inode: String(inode), mode: '16832', uid: '501', childCount: 1, sha256: hash };
}
function anchor(ordinal: number): ErasureAnchor { return { ordinal, identity: { ...identity, inode: String(50 + ordinal) }, digest: hash }; }
function record(state: ErasureRecord['state'] = 'INVENTORY_READY'): ErasureRecord {
  const head = { locator: 'Notes/Memory.yaml', originalHeadIdentity: identity, sidecar: artifact, intent: artifact, registry: artifact,
    namespace: [namespace('.', 1), namespace('.memory-owners', 2), namespace('.memory-owners/owners', 3), namespace('Notes', 4)] };
  const base: ErasureRecord = { schema: 1, domain: ERASURE_DOMAIN, ...binding, state, head };
  if (state === 'HEAD_PREPARED') return base;
  const archive = { firstMissing: null, existing: [namespace('.', 1), namespace('volumes', 5), namespace('volumes/by-id', 6), namespace(`volumes/by-id/${binding.ownerId}`, 7)] };
  if (state === 'ERASURE_READY') return { ...base, archive };
  const value: ErasureRecord = { ...base, archive, manifest: { nodes: 3, segments: 3, sha256: hash, anchor: anchor(0) }, cursor: 0 };
  if (state === 'ACTION_PREPARED') value.action = { index: 0, parent: { locator: 'volumes/by-id', device: '1', inode: '5', mode: '16832', uid: '501' },
    name: 'selected', directory: false, identity, mode: '33152', uid: '501', links: '1', beforeCount: 2, beforeDigest: hash, afterCount: 1, afterDigest: hash };
  if (state === 'OWNER_ROOT_REMOVED' || state === 'EVIDENCE_RETIRING' || state === 'RETIRE_ACTION_PREPARED') value.cursor = 3;
  if (state === 'RETIRE_ACTION_PREPARED') value.retirement = { kind: 'segment', name: erasureSegmentName(binding.ownerId, binding.operationId, 0),
    artifact: { ...artifact, identity: anchor(0).identity }, successor: anchor(1), beforeCount: 5, beforeDigest: hash, afterCount: 4, afterDigest: hash };
  return value;
}
function node(index: number, name = `私有-${index}`): ErasureNode {
  return { index, parent: null, name, directory: false, identity: { ...identity, inode: String(100 + index) }, mode: '33152', uid: '501', links: '1', childCount: 0, sha256: hash };
}
function segment(nodes = [node(0)]): ErasureSegment {
  return { schema: 1, domain: ERASURE_DOMAIN, ...binding, ordinal: 0, total: 1, first: 0, nodes, successor: null };
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

describe('owner-erasure authority records', () => {
  it('round-trips explicit V2 shared names and full owner-root commitments without changing V1 grammar', () => {
    const old = record(), current: ErasureRecord = { ...old, ...ERASURE_NAMES_PROTOCOL,
      head: { ...old.head, namespace: old.head.namespace.map(value => ({ ...value, kind: 'names' })) },
      archive: { ...old.archive!, existing: old.archive!.existing.map((value, index) => ({ ...value, kind: index === 3 ? 'full' : 'names' })) } };
    expect(erasureParseRecord(erasureSerialize(current))).toEqual(current);
    expect(erasureParseRecord(erasureSerialize(old))).toEqual(old);
    expect(old.head.namespace.every(value => !Object.hasOwn(value, 'kind'))).toBe(true);
  });
  it.each(['wrong-domain', 'unknown-version', 'missing-kind', 'shared-full', 'owner-names', 'legacy-kind'] as const)(
    'refuses version/commitment confusion: %s', change => {
      const old = record(), value: ErasureRecord = { ...old, ...ERASURE_NAMES_PROTOCOL,
        head: { ...old.head, namespace: old.head.namespace.map(item => ({ ...item, kind: 'names' })) },
        archive: { ...old.archive!, existing: old.archive!.existing.map((item, index) => ({ ...item, kind: index === 3 ? 'full' : 'names' })) } };
      if (change === 'wrong-domain') Object.assign(value, { domain: ERASURE_DOMAIN });
      if (change === 'unknown-version') Object.assign(value, { schema: 3 });
      if (change === 'missing-kind') delete value.head.namespace[0].kind;
      if (change === 'shared-full') value.head.namespace[0].kind = 'full';
      if (change === 'owner-names') value.archive!.existing[3].kind = 'names';
      if (change === 'legacy-kind') Object.assign(value, { schema: 1, domain: ERASURE_DOMAIN });
      expect(() => erasureParseRecord(erasureSerialize(value))).toThrow();
    });
  it('binds segment schema to its exact domain, including explicitly versioned packing', () => {
    const current: ErasureSegment = { ...segment(), ...ERASURE_NAMES_PROTOCOL };
    expect(erasureParseSegment(erasureSerialize(current))).toEqual(current);
    for (const mismatch of [{ schema: 1, domain: ERASURE_NAMES_DOMAIN }, { schema: 2, domain: ERASURE_DOMAIN }, { schema: 3, domain: ERASURE_NAMES_DOMAIN }]) {
      expect(() => erasureParseSegment(erasureSerialize(Object.assign(clone(current), mismatch)))).toThrow();
    }
    expect(erasurePack(binding, [node(0)], ERASURE_NAMES_PROTOCOL).flat()).toEqual([node(0)]);
  });
  it.each(['ERASURE_READY', 'INVENTORY_READY', 'ACTION_PREPARED', 'OWNER_ROOT_REMOVED', 'EVIDENCE_RETIRING', 'RETIRE_ACTION_PREPARED'] as const)(
    'requires an actual archive witness in %s, even when the selected key exists', state => {
      for (const missing of [null, undefined]) {
        const value = record(state); Object.assign(value, { archive: missing });
        expect(() => erasureValidateRecord(value)).toThrow();
      }
    });
  it.each(['INVENTORY_READY', 'ACTION_PREPARED', 'OWNER_ROOT_REMOVED', 'EVIDENCE_RETIRING', 'RETIRE_ACTION_PREPARED'] as const)(
    'requires an actual manifest in %s', state => {
      for (const missing of [null, undefined]) {
        const value = record(state); Object.assign(value, { manifest: missing });
        expect(() => erasureValidateRecord(value)).toThrow();
      }
    });
  it.each(['action', 'retirement'] as const)('refuses absent selected %s authority', key => {
    for (const missing of [null, undefined]) {
      const value = record(key === 'action' ? 'ACTION_PREPARED' : 'RETIRE_ACTION_PREPARED'); Object.assign(value, { [key]: missing });
      expect(() => erasureValidateRecord(value)).toThrow();
    }
  });
  it('accepts a retirement suffix without pretending its original segment count shrank', () => {
    const value = record('EVIDENCE_RETIRING'); value.manifest!.anchor = anchor(2);
    expect(erasureParseRecord(erasureSerialize(value))).toEqual(value);
    value.manifest!.anchor = null;
    expect(erasureParseRecord(erasureSerialize(value)).manifest).toEqual({ nodes: 3, segments: 3, sha256: hash, anchor: null });
    const pending = record('RETIRE_ACTION_PREPARED'); pending.manifest!.anchor = anchor(2);
    pending.retirement = { ...pending.retirement!, name: erasureSegmentName(binding.ownerId, binding.operationId, 2),
      artifact: { ...artifact, identity: anchor(2).identity }, successor: null };
    expect(() => erasureValidateRecord(pending)).not.toThrow();
    pending.manifest!.anchor = null;
    pending.retirement = { ...pending.retirement, kind: 'registry', name: `${binding.ownerId}.json`, artifact, successor: null };
    expect(() => erasureValidateRecord(pending)).not.toThrow();
  });
  it('rejects a nonempty terminal inventory cursor while admitting an initial empty inventory', () => {
    const nonempty = record('INVENTORY_READY'); nonempty.cursor = nonempty.manifest!.nodes;
    expect(() => erasureValidateRecord(nonempty)).toThrow();
    const empty = record('INVENTORY_READY');
    empty.archive = { firstMissing: 1, existing: [namespace('.', 1)] };
    empty.manifest = { nodes: 0, segments: 0, sha256: hash, anchor: null }; empty.cursor = 0;
    expect(erasureParseRecord(erasureSerialize(empty))).toEqual(empty);
  });
  it('refuses cursor and pending-action drift rather than selecting another object', () => {
    for (const cursor of [-1, 4, 0.5, Number.MAX_SAFE_INTEGER]) {
      const value = record(); value.cursor = cursor; expect(() => erasureValidateRecord(value)).toThrow();
    }
    const value = record('ACTION_PREPARED'); value.action!.index = 1;
    expect(() => erasureValidateRecord(value)).toThrow();
    const completed = record('OWNER_ROOT_REMOVED'); completed.cursor = 2;
    expect(() => erasureValidateRecord(completed)).toThrow();
  });
  it('refuses mismatched retirement identity and skipped successors', () => {
    const changed = record('RETIRE_ACTION_PREPARED'); changed.retirement!.artifact = { ...artifact, identity: { ...identity, inode: '999' } };
    expect(() => erasureValidateRecord(changed)).toThrow();
    for (const successor of [null, anchor(0), anchor(2), anchor(4096)]) {
      const value = record('RETIRE_ACTION_PREPARED'); value.retirement!.successor = successor;
      expect(() => erasureValidateRecord(value)).toThrow();
    }
  });
  it('refuses noncanonical authority bytes and unwanted state fields', () => {
    const value = record(); const raw = erasureSerialize(value);
    expect(() => erasureParseRecord(` ${raw}`)).toThrow();
    expect(() => erasureParseRecord(raw.replace('"cursor":0', '"cursor":0,"cursor":0'))).toThrow();
    expect(() => erasureValidateRecord({ ...record('HEAD_PREPARED'), archive: value.archive })).toThrow();
  });
});

describe('bounded erasure manifest segments', () => {
  it('keeps inventory authority stable across canonical segment field ordering', () => {
    const original = node(0, 'private payload');
    const reordered: ErasureNode = { sha256: original.sha256, childCount: original.childCount,
      links: original.links, uid: original.uid, mode: original.mode, identity: original.identity,
      directory: original.directory, name: original.name, parent: original.parent, index: original.index };
    const parsed = erasureParseSegment(erasureSerialize(segment([reordered])));
    expect(erasureInventoryDigest([original])).toBe(erasureInventoryDigest(parsed.nodes));
    const replaced = { ...original, identity: { ...original.identity, inode: '999' } };
    expect(erasureInventoryDigest([replaced])).not.toBe(erasureInventoryDigest(parsed.nodes));
  });

  it('rejects missing, skipped and surplus successor authority', () => {
    const first = { ...segment(), total: 2, successor: anchor(1) };
    expect(() => erasureValidateSegment(first)).not.toThrow();
    for (const successor of [null, anchor(0), anchor(2)]) expect(() => erasureValidateSegment({ ...first, successor })).toThrow();
    expect(() => erasureValidateSegment({ ...segment(), successor: anchor(1) })).toThrow();
    expect(() => erasureValidateSegment({ ...segment(), ordinal: 1 })).toThrow();
    const invalid = clone(segment()); invalid.nodes[0].parent = 0;
    expect(() => erasureValidateSegment(invalid)).toThrow();
  });
  it('packs UTF-8 nodes with a complete worst-width successor reservation', () => {
    const nodes = Array.from({ length: 50 }, (_, index) => node(index, `${'漢'.repeat(60)}-${index}`));
    const groups = erasurePack(binding, nodes);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.flat()).toEqual(nodes);
    let first = 0;
    for (const [ordinal, group] of groups.entries()) {
      const value: ErasureSegment = { ...segment(group), ordinal, total: groups.length, first,
        successor: ordinal === groups.length - 1 ? null : { ordinal: ordinal + 1, identity: erasureMaximumIdentity(), digest: hash } };
      const raw = erasureSerialize(value);
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(ERASURE_RECORD_LIMIT);
      expect(erasureParseSegment(raw)).toEqual(value);
      first += group.length;
    }
  });
  it('admits exactly 8,192 UTF-8 bytes and refuses one additional byte', () => {
    const value = segment([node(0, '界')]);
    // Fill with usable nodes, then grow valid basenames to the exact byte
    // boundary; no padding fields outside the authority grammar are used.
    while (true) {
      const larger = { ...value, nodes: [...value.nodes, node(value.nodes.length, '界')] };
      try { erasureSerialize(larger); } catch { break; }
      value.nodes = larger.nodes;
    }
    for (const entry of value.nodes) {
      const remaining = ERASURE_RECORD_LIMIT - Buffer.byteLength(erasureSerialize(value));
      entry.name += 'x'.repeat(Math.min(remaining, 255 - Buffer.byteLength(entry.name)));
    }
    expect(Buffer.byteLength(erasureSerialize(value))).toBe(ERASURE_RECORD_LIMIT);
    expect(erasureParseSegment(erasureSerialize(value))).toEqual(value);
    const spare = value.nodes.find(entry => Buffer.byteLength(entry.name) < 255)!;
    const overflow = clone(value); overflow.nodes[value.nodes.indexOf(spare)].name += 'x';
    expect(() => erasureSerialize(overflow)).toThrow(expect.objectContaining({ code: 'EHEADRESOURCE' }));
  });
});
