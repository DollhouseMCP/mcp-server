/** Internal bounded, content-free authority records for dormant whole-owner erasure. */
import * as path from 'node:path';
import { canonicalEvidence, evidenceDecimal, evidenceDigest, evidenceKeys, evidenceValidIdentity,
  type HeadIdentity } from './FileMemoryOwnedHeadEvidence.js';

export const ERASURE_RECORD_LIMIT = 8192;
export const ERASURE_NODE_LIMIT = 4096;
export const ERASURE_DEPTH_LIMIT = 16;
export const ERASURE_DOMAIN = 'dollhouse.owner-erasure.schema1.v1';
export const ERASURE_NAMES_DOMAIN = 'dollhouse.owner-erasure.schema2.names.v1';
export type ErasureProtocol = { schema: 1; domain: typeof ERASURE_DOMAIN } | { schema: 2; domain: typeof ERASURE_NAMES_DOMAIN };
export const ERASURE_LEGACY_PROTOCOL: ErasureProtocol = { schema: 1, domain: ERASURE_DOMAIN };
export const ERASURE_NAMES_PROTOCOL: ErasureProtocol = { schema: 2, domain: ERASURE_NAMES_DOMAIN };
function protocol(value: ErasureProtocol): void {
  if (!(value.schema === 1 && value.domain === ERASURE_DOMAIN || value.schema === 2 && value.domain === ERASURE_NAMES_DOMAIN)) erasureFail();
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
export function erasureFail(code = 'EERASURERESIDUAL'): never {
  throw Object.assign(new Error('Owner erasure authority is unsafe, changed or unsupported'), { code });
}
export interface ErasureBinding { userId: string; ownerId: string; deleteOperationId: string; operationId: string }
export interface ErasureDirectoryBinding {
  locator: string; device: string; inode: string; mode: string; uid: string;
}
export interface ErasureNamespace extends ErasureDirectoryBinding { childCount: number; sha256: string; kind?: 'names' | 'full' }
export interface ErasureArtifact { identity: HeadIdentity; mode: string; uid: string; links: string; digest: string }
export interface ErasureHeadPreparation {
  locator: string; originalHeadIdentity: HeadIdentity;
  sidecar: ErasureArtifact; intent: ErasureArtifact; registry: ErasureArtifact;
  namespace: ErasureNamespace[];
}
/** Fixed root/volumes/by-id/oldUUID chain; null means the old owner root exists. */
export interface ErasureArchiveWitness {
  firstMissing: number | null; existing: ErasureNamespace[];
}
export interface ErasureNode {
  index: number; parent: number | null; name: string; directory: boolean;
  identity: HeadIdentity; mode: string; uid: string; links: string;
  childCount: number; sha256: string;
}
export interface ErasureAnchor { ordinal: number; identity: HeadIdentity; digest: string }
export interface ErasureManifest {
  nodes: number; segments: number; sha256: string; anchor: ErasureAnchor | null;
}
export interface ErasurePreparedAction {
  index: number; parent: ErasureDirectoryBinding; name: string; directory: boolean;
  identity: HeadIdentity; mode: string; uid: string; links: string;
  beforeCount: number; beforeDigest: string; afterCount: number; afterDigest: string;
}
export interface ErasureRetirementAction {
  kind: 'segment' | 'registry'; name: string; artifact: ErasureArtifact;
  successor: ErasureAnchor | null; beforeCount: number; beforeDigest: string;
  afterCount: number; afterDigest: string;
}
export type ErasureState = 'HEAD_PREPARED' | 'ERASURE_READY' | 'INVENTORY_READY' |
  'ACTION_PREPARED' | 'OWNER_ROOT_REMOVED' | 'EVIDENCE_RETIRING' | 'RETIRE_ACTION_PREPARED';
export type ErasureRecord = ErasureBinding & ErasureProtocol & {
  state: ErasureState;
  head: ErasureHeadPreparation;
  archive?: ErasureArchiveWitness;
  manifest?: ErasureManifest;
  cursor?: number;
  action?: ErasurePreparedAction;
  retirement?: ErasureRetirementAction;
}
export type ErasureSegment = ErasureBinding & ErasureProtocol & {
  ordinal: number; total: number;
  first: number; nodes: ErasureNode[]; successor: ErasureAnchor | null;
}
const order = ['schema', 'domain', 'state', 'userId', 'ownerId', 'deleteOperationId', 'operationId',
  'head', 'locator', 'originalHeadIdentity', 'sidecar', 'intent', 'registry', 'namespace',
  'archive', 'firstMissing', 'existing', 'manifest', 'segments', 'sha256', 'anchor', 'cursor',
  'action', 'retirement', 'kind', 'ordinal', 'total', 'first', 'nodes', 'successor', 'index',
  'parent', 'name', 'directory', 'artifact', 'identity', 'digest', 'device', 'inode', 'size',
  'mtimeNs', 'ctimeNs', 'mode', 'uid', 'links', 'childCount', 'beforeCount', 'beforeDigest',
  'afterCount', 'afterDigest'];
export function erasureSerialize(value: ErasureRecord | ErasureSegment): string {
  const raw = JSON.stringify(canonicalEvidence(value, order, erasureFail));
  if (Buffer.byteLength(raw) > ERASURE_RECORD_LIMIT) erasureFail('EHEADRESOURCE');
  return raw;
}
export function erasureBasename(value: unknown): value is string {
  return typeof value === 'string' && !!value && value !== '.' && value !== '..' &&
    !/[\\/\0]/u.test(value) && Buffer.byteLength(value) <= 255 && Buffer.from(value).toString('utf8') === value;
}
function locator(value: unknown): value is string {
  return typeof value === 'string' && !!value && !path.isAbsolute(value) && !path.win32.isAbsolute(value) &&
    value.split('/').every(erasureBasename);
}
function integer(value: unknown, maximum = ERASURE_NODE_LIMIT): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}
export function erasureBinding(value: ErasureBinding): void {
  if (typeof value.userId !== 'string' || !value.userId || Buffer.byteLength(value.userId) > 128 ||
    !UUID.test(value.ownerId) || !UUID.test(value.deleteOperationId) || !UUID.test(value.operationId)) erasureFail();
}
function directory(value: ErasureDirectoryBinding): void {
  if (!evidenceKeys(value, ['locator', 'device', 'inode', 'mode', 'uid']) ||
    value.locator !== '.' && !locator(value.locator) ||
    !evidenceDecimal(value.device, 40) || !evidenceDecimal(value.inode, 40) ||
    !evidenceDecimal(value.mode, 20) || !evidenceDecimal(value.uid, 20)) erasureFail();
}
function namespace(value: ErasureNamespace, version: 1 | 2, kind: 'names' | 'full'): void {
  if (!evidenceKeys(value, ['locator', 'device', 'inode', 'mode', 'uid', 'childCount', 'sha256', ...(version === 2 ? ['kind'] : [])]) ||
    version === 2 && value.kind !== kind ||
    !integer(value.childCount, 4095) || !HASH.test(value.sha256)) erasureFail();
  const { childCount: _count, sha256: _digest, kind: _kind, ...binding } = value;
  directory(binding);
}
export function erasureArtifact(value: ErasureArtifact): void {
  if (!evidenceKeys(value, ['identity', 'mode', 'uid', 'links', 'digest']) ||
    !evidenceValidIdentity(value.identity) || !evidenceDecimal(value.mode, 20) ||
    !evidenceDecimal(value.uid, 20) || value.links !== '1' || !HASH.test(value.digest)) erasureFail();
}
function anchor(value: ErasureAnchor | null): void {
  if (value === null) return;
  if (!evidenceKeys(value, ['ordinal', 'identity', 'digest']) || !integer(value.ordinal, 4095) ||
    !evidenceValidIdentity(value.identity) || !HASH.test(value.digest)) erasureFail();
}
function head(value: ErasureHeadPreparation, version: 1 | 2): void {
  if (!evidenceKeys(value, ['locator', 'originalHeadIdentity', 'sidecar', 'intent', 'registry', 'namespace']) ||
    !locator(value.locator) || ['.memory-owners', '.memory-fences', 'volumes'].includes(value.locator.split('/')[0]) ||
    !evidenceValidIdentity(value.originalHeadIdentity) || !Array.isArray(value.namespace) ||
    !value.namespace.length || value.namespace.length > 20) erasureFail();
  for (const artifact of [value.sidecar, value.intent, value.registry]) erasureArtifact(artifact);
  for (const item of value.namespace) namespace(item, version, 'names');
  if (new Set(value.namespace.map(item => item.locator)).size !== value.namespace.length ||
    new Set(value.namespace.map(item => `${item.device}:${item.inode}`)).size !== value.namespace.length) erasureFail();
  const expected = new Set(['.', '.memory-owners', '.memory-owners/owners']);
  let parent = '.';
  for (const component of value.locator.split('/').slice(0, -1)) {
    parent = parent === '.' ? component : `${parent}/${component}`; expected.add(parent);
  }
  if (expected.size !== value.namespace.length || value.namespace.some(item => !expected.has(item.locator))) erasureFail();
}
function archive(value: ErasureArchiveWitness, ownerId: string, version: 1 | 2): void {
  if (!evidenceKeys(value, ['firstMissing', 'existing']) || !Array.isArray(value.existing) ||
    value.firstMissing !== null && (!integer(value.firstMissing, 3) || value.firstMissing < 1) ||
    value.existing.length !== (value.firstMissing ?? 4)) erasureFail();
  const expected = ['.', 'volumes', 'volumes/by-id', `volumes/by-id/${ownerId}`];
  for (const [index, item] of value.existing.entries()) { namespace(item, version, index === 3 ? 'full' : 'names'); if (item.locator !== expected[index]) erasureFail(); }
  if (new Set(value.existing.map(item => `${item.device}:${item.inode}`)).size !== value.existing.length) erasureFail();
}
function manifest(value: ErasureManifest, retiring: boolean): void {
  if (!evidenceKeys(value, ['nodes', 'segments', 'sha256', 'anchor']) || !integer(value.nodes) ||
    !integer(value.segments) || value.nodes === 0 !== (value.segments === 0) ||
    value.segments > value.nodes || !HASH.test(value.sha256)) erasureFail();
  anchor(value.anchor);
  if (value.segments === 0 ? value.anchor !== null : retiring ? value.anchor !== null && value.anchor.ordinal >= value.segments : value.anchor?.ordinal !== 0) erasureFail();
}
function action(value: ErasurePreparedAction): void {
  if (!evidenceKeys(value, ['index', 'parent', 'name', 'directory', 'identity', 'mode', 'uid', 'links',
    'beforeCount', 'beforeDigest', 'afterCount', 'afterDigest']) || !integer(value.index, 4095) ||
    !erasureBasename(value.name) || typeof value.directory !== 'boolean' || !evidenceValidIdentity(value.identity) ||
    !evidenceDecimal(value.mode, 20) || !evidenceDecimal(value.uid, 20) || !evidenceDecimal(value.links, 20) ||
    !integer(value.beforeCount, 4095) || value.afterCount !== value.beforeCount - 1 ||
    !HASH.test(value.beforeDigest) || !HASH.test(value.afterDigest)) erasureFail();
  directory(value.parent);
}
function retirement(value: ErasureRetirementAction): void {
  if (!evidenceKeys(value, ['kind', 'name', 'artifact', 'successor', 'beforeCount', 'beforeDigest', 'afterCount', 'afterDigest']) ||
    !['segment', 'registry'].includes(value.kind) || !erasureBasename(value.name) ||
    !integer(value.beforeCount, 4095) || value.afterCount !== value.beforeCount - 1 ||
    !HASH.test(value.beforeDigest) || !HASH.test(value.afterDigest)) erasureFail();
  erasureArtifact(value.artifact); anchor(value.successor);
  if (value.kind === 'registry' && value.successor !== null) erasureFail();
}
export function erasureValidateRecord(value: ErasureRecord): void {
  const extras: { [state in ErasureState]: string[] } = {
    HEAD_PREPARED: [], ERASURE_READY: ['archive'],
    INVENTORY_READY: ['archive', 'manifest', 'cursor'], ACTION_PREPARED: ['archive', 'manifest', 'cursor', 'action'],
    OWNER_ROOT_REMOVED: ['archive', 'manifest', 'cursor'], EVIDENCE_RETIRING: ['archive', 'manifest', 'cursor'],
    RETIRE_ACTION_PREPARED: ['archive', 'manifest', 'cursor', 'retirement'],
  };
  const extra = extras[value?.state];
  if (!extra ||
    !evidenceKeys(value, ['schema', 'domain', 'state', 'userId', 'ownerId', 'deleteOperationId', 'operationId', 'head', ...extra])) erasureFail();
  protocol(value); erasureBinding(value); head(value.head, value.schema);
  if (value.state !== 'HEAD_PREPARED') archive(value.archive!, value.ownerId, value.schema);
  if (extra.includes('manifest')) {
    const retiring = value.state === 'EVIDENCE_RETIRING' || value.state === 'RETIRE_ACTION_PREPARED';
    manifest(value.manifest!, retiring);
    if (!integer(value.cursor) || value.cursor! > value.manifest!.nodes ||
      (value.state === 'OWNER_ROOT_REMOVED' || retiring) && value.cursor !== value.manifest!.nodes) erasureFail();
    if (value.state === 'INVENTORY_READY' && value.manifest!.nodes > 0 && value.cursor === value.manifest!.nodes) erasureFail();
  }
  if (value.state === 'ACTION_PREPARED') {
    action(value.action!);
    if (value.action!.index !== value.cursor || value.cursor! >= value.manifest!.nodes) erasureFail();
  }
  if (value.state === 'RETIRE_ACTION_PREPARED') {
    retirement(value.retirement!);
    const pending = value.retirement!, current = value.manifest!.anchor;
    if (pending.kind === 'segment' ? !current || pending.name !== erasureSegmentName(value.ownerId, value.operationId, current.ordinal) ||
      pending.artifact.digest !== current.digest || JSON.stringify(pending.artifact.identity) !== JSON.stringify(current.identity) ||
      (current.ordinal === value.manifest!.segments - 1 ? pending.successor !== null : pending.successor?.ordinal !== current.ordinal + 1) :
      current !== null || pending.name !== `${value.ownerId}.json`) erasureFail();
  }
  erasureSerialize(value);
}
export function erasureValidateSegment(value: ErasureSegment): void {
  if (!evidenceKeys(value, ['schema', 'domain', 'userId', 'ownerId', 'deleteOperationId', 'operationId', 'ordinal', 'total', 'first', 'nodes', 'successor']) ||
    !integer(value.ordinal, 4095) ||
    !integer(value.total) || !value.total || value.ordinal >= value.total || !integer(value.first, 4095) ||
    !Array.isArray(value.nodes) || !value.nodes.length || value.first + value.nodes.length > ERASURE_NODE_LIMIT) erasureFail();
  protocol(value); erasureBinding(value); anchor(value.successor);
  if (value.ordinal === value.total - 1 ? value.successor !== null : value.successor?.ordinal !== value.ordinal + 1) erasureFail();
  for (const [offset, node] of value.nodes.entries()) {
    if (!evidenceKeys(node, ['index', 'parent', 'name', 'directory', 'identity', 'mode', 'uid', 'links', 'childCount', 'sha256']) ||
      node.index !== value.first + offset || node.parent !== null && (!integer(node.parent, 4095) || node.parent <= node.index) ||
      !erasureBasename(node.name) || typeof node.directory !== 'boolean' || !evidenceValidIdentity(node.identity) ||
      !evidenceDecimal(node.mode, 20) || !evidenceDecimal(node.uid, 20) || !evidenceDecimal(node.links, 20) ||
      !integer(node.childCount, 4095) || !HASH.test(node.sha256) || !node.directory && (node.links !== '1' || node.childCount !== 0)) erasureFail();
  }
  erasureSerialize(value);
}
export function erasureParseRecord(raw: string): ErasureRecord {
  const value = JSON.parse(raw) as ErasureRecord; erasureValidateRecord(value);
  if (erasureSerialize(value) !== raw) erasureFail(); return value;
}
export function erasureParseSegment(raw: string): ErasureSegment {
  const value = JSON.parse(raw) as ErasureSegment; erasureValidateSegment(value);
  if (erasureSerialize(value) !== raw) erasureFail(); return value;
}
export function erasureJournalName(ownerId: string): string { return `${ownerId}.erase.json`; }
export function erasureSegmentName(ownerId: string, operationId: string, ordinal: number): string {
  if (!integer(ordinal, 4095)) erasureFail();
  return `${ownerId}.erase-${operationId}.s${String(ordinal).padStart(4, '0')}.json`;
}
export function erasureStageName(name: string, operationId: string): string { return `${name}.erase-${operationId}.tmp`; }
export function erasureNamesDigest(names: readonly string[]): string {
  return evidenceDigest(JSON.stringify([ERASURE_DOMAIN, 'names', names]));
}
export function erasureInventoryDigest(nodes: readonly ErasureNode[]): string {
  if (nodes.length > ERASURE_NODE_LIMIT) erasureFail('EHEADRESOURCE');
  return evidenceDigest(JSON.stringify([ERASURE_DOMAIN, 'inventory', canonicalEvidence(nodes, order, erasureFail)]));
}
/** Complete future-width successor reservation, not a zero-width placeholder. */
export function erasureMaximumIdentity(): HeadIdentity {
  return { device: '9'.repeat(40), inode: '9'.repeat(40), size: '9'.repeat(40),
    mtimeNs: `-${'9'.repeat(40)}`, ctimeNs: `-${'9'.repeat(40)}` };
}
export function erasurePack(binding: ErasureBinding, nodes: ErasureNode[], selected: ErasureProtocol = ERASURE_LEGACY_PROTOCOL): ErasureNode[][] {
  protocol(selected);
  if (nodes.length > ERASURE_NODE_LIMIT) erasureFail('EHEADRESOURCE');
  const segments: ErasureNode[][] = [];
  let current: ErasureNode[] = [];
  const fits = (items: ErasureNode[]) => {
    const raw = JSON.stringify(canonicalEvidence({ ...selected, ...binding,
      ordinal: 4095, total: 4096, first: 4095, nodes: items,
      successor: { ordinal: 4095, identity: erasureMaximumIdentity(), digest: 'f'.repeat(64) } }, order, erasureFail));
    return Buffer.byteLength(raw) <= ERASURE_RECORD_LIMIT;
  };
  for (const node of nodes) {
    if (!fits([node])) erasureFail('EHEADRESOURCE');
    if (current.length && !fits([...current, node])) { segments.push(current); current = []; }
    current.push(node);
  }
  if (current.length) segments.push(current);
  if (segments.length > ERASURE_NODE_LIMIT) erasureFail('EHEADRESOURCE');
  return segments;
}
