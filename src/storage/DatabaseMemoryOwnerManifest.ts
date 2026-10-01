import { createHash } from 'node:crypto';
import type { MemoryTagAuditOwner } from './DatabaseMemoryLegacyTagAuditor.js';

export const MAX_MEMORY_OWNER_MANIFEST_OWNERS = 10_000;
export const MAX_MEMORY_OWNER_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_REVISION = 9223372036854775807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const FIELDS = new Set(['tenantId', 'ownerId', 'revision', 'dirty']);
type Reason = 'invalid-input' | 'owner-limit' | 'duplicate-owner' | 'conflicting-tenant' |
  'invalid-revision' | 'byte-limit' | 'set-mismatch' | 'revision-mismatch' | 'revision-overflow' | 'not-dirty';

/** Fixed diagnostics contain no protected owner identity or database content. */
export class DatabaseMemoryOwnerManifestError extends Error {
  readonly code = 'EOWNERMANIFEST';
  constructor(readonly reason: Reason) {
    super(`Memory owner manifest refused: ${reason}`);
  }
}

interface NoAuthority {
  readonly canBackfill: false;
  readonly canApply: false;
  readonly canActivate: false;
}
export interface DatabaseMemoryOwnerManifest extends NoAuthority {
  readonly formatVersion: 1;
  readonly claim: 'validated-supplied-owner-set';
  readonly ownerCount: number;
  /** Bytes/hash of the versioned canonical projection, not the returned JS object. */
  readonly encodedBytes: number;
  readonly sha256: string;
  /** Protected attribution; not routine log output. */
  readonly owners: readonly MemoryTagAuditOwner[];
}
export interface DatabaseMemoryOwnerInvalidationVerification extends NoAuthority {
  readonly formatVersion: 1;
  readonly claim: 'exact-supplied-owner-set-invalidation';
  readonly ownerCount: number;
  readonly encodedBytes: number;
  readonly sha256: string;
  readonly before: DatabaseMemoryOwnerManifest;
  readonly after: DatabaseMemoryOwnerManifest;
}
const NO_AUTHORITY = { canBackfill: false, canApply: false, canActivate: false } as const;
function refuse(reason: Reason): never { throw new DatabaseMemoryOwnerManifestError(reason); }

function captureRows(input: readonly MemoryTagAuditOwner[]): readonly MemoryTagAuditOwner[] {
  if (!Array.isArray(input)) refuse('invalid-input');
  if (input.length > MAX_MEMORY_OWNER_MANIFEST_OWNERS) refuse('owner-limit');
  const byOwner = new Map<string, string>();
  const rows: MemoryTagAuditOwner[] = [];
  for (let index = 0; index < input.length; index++) {
    if (!Object.hasOwn(input, index)) refuse('invalid-input');
    const row = input[index];
    if (!row || typeof row !== 'object' || Array.isArray(row)) refuse('invalid-input');
    const fields = Reflect.ownKeys(row);
    if (fields.length !== FIELDS.size || fields.some(key => typeof key !== 'string' || !FIELDS.has(key))) refuse('invalid-input');
    const { tenantId, ownerId, revision, dirty } = row;
    if (typeof tenantId !== 'string' || !UUID.test(tenantId) ||
      typeof ownerId !== 'string' || !UUID.test(ownerId) || typeof dirty !== 'boolean') refuse('invalid-input');
    if (typeof revision !== 'string' || revision.length > 19 || !/^[1-9][0-9]*$/u.test(revision) ||
      BigInt(revision) > MAX_REVISION) refuse('invalid-revision');
    const tenant = tenantId.toLowerCase();
    const owner = ownerId.toLowerCase();
    const priorTenant = byOwner.get(owner);
    if (priorTenant !== undefined) refuse(priorTenant === tenant ? 'duplicate-owner' : 'conflicting-tenant');
    byOwner.set(owner, tenant);
    rows.push(Object.freeze({ tenantId: tenant, ownerId: owner, revision, dirty }));
  }
  rows.sort((left, right) => {
    if (left.ownerId < right.ownerId) return -1;
    if (left.ownerId > right.ownerId) return 1;
    if (left.tenantId < right.tenantId) return -1;
    if (left.tenantId > right.tenantId) return 1;
    return 0;
  });
  return Object.freeze(rows);
}

function projection(owners: readonly MemoryTagAuditOwner[]) {
  return { formatVersion: 1, claim: 'validated-supplied-owner-set', ownerCount: owners.length,
    owners: owners.map(row => [row.tenantId, row.ownerId, row.revision, row.dirty]), ...NO_AUTHORITY };
}
function fingerprint(value: unknown): { encodedBytes: number; sha256: string } {
  // Fixed envelope and tuple ordering include all projection delimiters/flags.
  const encoded = JSON.stringify(value);
  const encodedBytes = Buffer.byteLength(encoded, 'utf8');
  if (encodedBytes > MAX_MEMORY_OWNER_MANIFEST_BYTES) refuse('byte-limit');
  return { encodedBytes, sha256: createHash('sha256').update(encoded, 'utf8').digest('hex') };
}

/** Validates only supplied rows. It cannot establish database inventory completeness. */
export function captureDatabaseMemoryOwnerManifest(input: readonly MemoryTagAuditOwner[]): DatabaseMemoryOwnerManifest {
  const owners = captureRows(input);
  return Object.freeze({ formatVersion: 1, claim: 'validated-supplied-owner-set', ownerCount: owners.length,
    ...fingerprint(projection(owners)), owners, ...NO_AUTHORITY });
}

/** Exact supplied-set comparison; no SQL, commit proof, receipt or mutation authority. */
export function verifyDatabaseMemoryOwnerInvalidation(
  input: readonly MemoryTagAuditOwner[], returned: readonly MemoryTagAuditOwner[],
): DatabaseMemoryOwnerInvalidationVerification {
  const before = captureDatabaseMemoryOwnerManifest(input);
  const after = captureDatabaseMemoryOwnerManifest(returned);
  if (before.ownerCount !== after.ownerCount) refuse('set-mismatch');
  for (let index = 0; index < before.ownerCount; index++) {
    const old = before.owners[index];
    const current = after.owners[index];
    if (old.ownerId !== current.ownerId || old.tenantId !== current.tenantId) refuse('set-mismatch');
    if (BigInt(old.revision) === MAX_REVISION) refuse('revision-overflow');
    if (BigInt(current.revision) !== BigInt(old.revision) + 1n) refuse('revision-mismatch');
    if (!current.dirty) refuse('not-dirty');
  }
  const encoded = { formatVersion: 1, claim: 'exact-supplied-owner-set-invalidation', ownerCount: before.ownerCount,
    before: projection(before.owners), after: projection(after.owners), ...NO_AUTHORITY };
  return Object.freeze({ formatVersion: 1, claim: 'exact-supplied-owner-set-invalidation', ownerCount: before.ownerCount,
    ...fingerprint(encoded), before, after, ...NO_AUTHORITY });
}
