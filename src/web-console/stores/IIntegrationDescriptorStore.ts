import { isDeepStrictEqual } from 'node:util';

import {
  ConsoleStoreValidationError,
  assertDisplayString,
  assertNullableDisplayString,
  assertNonEmptyBuffer,
  assertUuid,
  assertWellFormedUnicode,
  cloneBuffer,
  cloneDate,
} from './ConsoleStoreValidation.js';
import {
  assertUserIntegrationProvider,
  type UserIntegrationProvider,
} from './IUserIntegrationStore.js';
import {
  canonicalizeIntegrationApiHost,
  canonicalizeIntegrationApiHosts,
  IntegrationApiHostValidationError,
} from '../security/IntegrationApiHosts.js';

export type IntegrationDescriptorOwnership = 'curated' | 'byo';
export type IntegrationAuthStrategy = 'oauth2_authorization_code' | 'static_api_key' | 'coded';
export type IntegrationPkceMode = 'required' | 'supported' | 'unsupported';
export type IntegrationRefreshMode = 'none' | 'static' | 'rotating';

export interface IntegrationDescriptorRecord {
  readonly id: string;
  readonly provider: UserIntegrationProvider;
  readonly ownership: IntegrationDescriptorOwnership;
  readonly ownerUserId: string | null;
  readonly displayName: string;
  readonly category: string;
  readonly authStrategy: IntegrationAuthStrategy;
  readonly apiHosts: readonly string[];
  readonly oauth: IntegrationOAuthDescriptor | null;
  readonly staticApiKey: IntegrationStaticApiKeyDescriptor | null;
  readonly clientSecretCiphertext: Buffer | null;
  /** Opaque logical revision; stable across at-rest ciphertext rewraps. */
  readonly clientSecretRevision: string | null;
  readonly credentialKeyVersion: string | null;
  /** Monotonic deployment revision for curated seed data; null for legacy/BYO descriptors. */
  readonly curatedSeedRevision?: number | null;
  readonly operationPromotion: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IntegrationOAuthDescriptor {
  readonly clientId: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly pkce: IntegrationPkceMode;
  readonly refresh: IntegrationRefreshMode;
  readonly tokenExchange: Readonly<Record<string, unknown>>;
  readonly accountLabel: Readonly<Record<string, unknown>>;
}

export interface IntegrationStaticApiKeyDescriptor {
  readonly injection: {
    /**
     * `basic` sends `Authorization: Basic base64(credential)` where the
     * stored credential is `username:password`; name is fixed to
     * `Authorization` and no valuePrefix applies.
     */
    readonly location: 'header' | 'query' | 'basic';
    readonly name: string;
    readonly valuePrefix: string | null;
  };
}

export interface IntegrationDescriptorCreateInput {
  readonly provider: UserIntegrationProvider;
  readonly ownership: IntegrationDescriptorOwnership;
  readonly ownerUserId: string | null;
  readonly displayName: string;
  readonly category: string;
  readonly authStrategy: IntegrationAuthStrategy;
  readonly apiHosts: readonly string[];
  readonly oauth?: IntegrationOAuthDescriptor | null;
  readonly staticApiKey?: IntegrationStaticApiKeyDescriptor | null;
  readonly clientSecretCiphertext?: Buffer | null;
  readonly clientSecretRevision?: string | null;
  readonly credentialKeyVersion?: string | null;
  /** Optional positive integer. Once set, lower or missing curated revisions cannot overwrite it. */
  readonly curatedSeedRevision?: number | null;
  readonly operationPromotion?: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IntegrationDescriptorUpsertOptions {
  /** Reject an update if another mutation changed the descriptor after it was read. */
  readonly expectedUpdatedAt?: Date;
  /**
   * Permit a proven-equal legacy secret to gain its first logical revision
   * without revoking descriptor bindings. Stores must verify that no other
   * routing-sensitive field changed before honoring this option.
   */
  readonly initializeClientSecretRevision?: boolean;
  /**
   * Retain the current curated seed fields while refreshing deployment-owned
   * OAuth secret envelope at the same or an older seed revision. Logical
   * client identity or secret changes require a newer explicit seed revision.
   */
  readonly refreshDeploymentCredentialsAtRetainedSeedRevision?: boolean;
}

/**
 * The only routing-sensitive mutation allowed while credentials are cleanup
 * only: adding a previously absent revocation endpoint. Every execution and
 * token-exchange field must remain byte-for-byte equivalent.
 */
export function isCleanupRevocationEndpointRepair(
  current: IntegrationDescriptorRecord,
  proposed: IntegrationDescriptorRecord,
): boolean {
  const currentRevocationUrl = current.oauth?.tokenExchange.revocationUrl;
  const proposedRevocationUrl = proposed.oauth?.tokenExchange.revocationUrl;
  if (typeof currentRevocationUrl === 'string' && currentRevocationUrl.length > 0) return false;
  if (typeof proposedRevocationUrl !== 'string' || proposedRevocationUrl.length === 0) return false;
  const left = cleanupRepairRoutingShape(current);
  const right = cleanupRepairRoutingShape(proposed);
  return canonicalJsonValue(left) === canonicalJsonValue(right);
}

function cleanupRepairRoutingShape(descriptor: IntegrationDescriptorRecord): unknown {
  const tokenExchange = { ...(descriptor.oauth?.tokenExchange ?? {}) };
  delete tokenExchange.revocationUrl;
  return {
    provider: descriptor.provider,
    authStrategy: descriptor.authStrategy,
    apiHosts: descriptor.apiHosts,
    oauth: descriptor.oauth ? { ...descriptor.oauth, tokenExchange } : null,
    staticApiKey: descriptor.staticApiKey,
    operationPromotion: descriptor.operationPromotion,
    clientSecretRevision: descriptor.clientSecretRevision,
  };
}

function canonicalJsonValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJsonValue(record[key])}`).join(',')}}`;
}

export interface CuratedIntegrationDeploymentState {
  readonly provider: UserIntegrationProvider;
  readonly seedRevision: number;
  readonly enabled: boolean;
  readonly updatedAt: Date;
}

export type CuratedIntegrationSeedDirective =
  | {
    readonly provider: UserIntegrationProvider;
    readonly seedRevision: number;
    readonly enabled: false;
    readonly updatedAt: Date;
  }
  | {
    readonly provider: UserIntegrationProvider;
    readonly seedRevision: number | null;
    readonly enabled: true;
    readonly descriptor: IntegrationDescriptorCreateInput;
    readonly upsertOptions?: IntegrationDescriptorUpsertOptions;
    readonly updatedAt: Date;
  };

export interface CuratedIntegrationSeedResult {
  readonly applied: boolean;
  readonly enabled: boolean;
  readonly seedRevision: number | null;
  readonly descriptor: IntegrationDescriptorRecord | null;
}

export class CuratedIntegrationSeedConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CuratedIntegrationSeedConflictError';
  }
}

/** Routing mutation must wait until a consumed OAuth callback releases its completion lease. */
export class IntegrationDescriptorMutationBusyError extends Error {
  constructor() {
    super('integration descriptor has an OAuth callback completing');
    this.name = 'IntegrationDescriptorMutationBusyError';
  }
}

export class IntegrationDescriptorRevisionConflictError extends Error {
  constructor() {
    super('integration descriptor changed after it was read');
    this.name = 'IntegrationDescriptorRevisionConflictError';
  }
}

/**
 * Canonical lock identity for every mutation of one logical descriptor.
 * Descriptor ids are generated storage identities, so locking by id does not
 * serialize first insert, seed reconciliation, callback completion, and later
 * updates of the same ownership/provider tuple.
 */
export function integrationDescriptorMutationKey(
  identity: Pick<IntegrationDescriptorCreateInput, 'provider' | 'ownership' | 'ownerUserId'>,
): string {
  if (identity.ownership === 'curated') {
    return `integration-descriptor:curated:${identity.provider}`;
  }
  if (!identity.ownerUserId) {
    throw new ConsoleStoreValidationError('BYO descriptor mutation requires ownerUserId');
  }
  return `integration-descriptor:byo:${identity.ownerUserId}:${identity.provider}`;
}

export const INTEGRATION_DESCRIPTOR_PAGE_MAX_LIMIT = 100;

export interface IntegrationDescriptorPageRequest {
  /** 1..INTEGRATION_DESCRIPTOR_PAGE_MAX_LIMIT; defaults to the maximum. */
  readonly limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`; null/absent starts at the beginning. */
  readonly cursor?: string | null;
}

export interface IntegrationDescriptorPage {
  readonly items: readonly IntegrationDescriptorRecord[];
  readonly nextCursor: string | null;
}

export interface IntegrationDescriptorCredentialFence {
  hasCredentialMaterial(integrationDescriptorId: string): Promise<boolean>;
  hasExecutableCredentialMaterial(integrationDescriptorId: string): Promise<boolean>;
  revokeCredentiallessBindings(integrationDescriptorId: string, revokedAt: Date): Promise<void>;
  /** Cancel pending callbacks; return false when a consumed callback is completing. */
  fencePendingCallbacks?(integrationDescriptorId: string): Promise<boolean>;
}

export interface IIntegrationDescriptorStore {
  /** In-memory composition hook; PostgreSQL performs this fence in its transaction. */
  configureCredentialMutationFence?(fence: IntegrationDescriptorCredentialFence): void;
  /** Optional in-memory fence used to serialize callback persistence with descriptor mutation. */
  runIfCurrent?<T>(
    descriptorId: string,
    descriptorFingerprint: string,
    operation: () => Promise<T>,
  ): Promise<T | null>;
  /**
   * ALL descriptors visible to the user (curated + own BYO), ordered by
   * provider then id. Complete — implementations must iterate pages
   * internally rather than silently truncating; bounded reads use
   * `listVisiblePage`.
   */
  listVisible(userId: string): Promise<readonly IntegrationDescriptorRecord[]>;
  listVisiblePage(userId: string, page?: IntegrationDescriptorPageRequest): Promise<IntegrationDescriptorPage>;
  findVisibleByProvider(userId: string, provider: UserIntegrationProvider): Promise<IntegrationDescriptorRecord | null>;
  /** Deployment-scoped lookup that never resolves a same-provider BYO descriptor. */
  findCuratedByProvider(provider: UserIntegrationProvider): Promise<IntegrationDescriptorRecord | null>;
  /**
   * Owner-scoped id lookup for the BYO authoring plane: returns the
   * descriptor only when it is BYO and owned by `userId`. Curated
   * descriptors, other users' descriptors, and unknown ids all resolve to
   * null — indistinguishable, so the caller can only 404.
   */
  findById(id: string, userId: string): Promise<IntegrationDescriptorRecord | null>;
  /**
   * Owner-scoped delete: removes the descriptor only when it is BYO and
   * owned by `ownerUserId`; returns whether a record was deleted. Curated /
   * non-owned / missing all return false (fail closed). The stored OpenAPI
   * spec is NOT cascaded by this contract — callers delete it via
   * `IIntegrationOpenApiSpecStore.deleteByDescriptorId` after a successful
   * descriptor delete (PostgreSQL additionally enforces FK ON DELETE CASCADE
   * as defense-in-depth).
   */
  delete(id: string, ownerUserId: string): Promise<boolean>;
  /** Remove a deployment-owned curated descriptor by provider id. */
  deleteCurated(provider: UserIntegrationProvider): Promise<boolean>;
  /**
   * Atomically apply deployment intent for a curated seed. A disabled directive
   * is a durable tombstone: it hides the curated descriptor without deleting it
   * or any user integration credentials. Revisions are monotonic across replicas.
   */
  reconcileCuratedSeed(directive: CuratedIntegrationSeedDirective): Promise<CuratedIntegrationSeedResult>;
  upsert(
    input: IntegrationDescriptorCreateInput,
    options?: IntegrationDescriptorUpsertOptions,
  ): Promise<IntegrationDescriptorRecord>;
}

/**
 * Verify that a retained-revision write changes deployment-owned OAuth
 * credentials only. Seed-owned routing, presentation, and promotion fields
 * remain protected by the monotonic curated revision.
 */
export function isRetainedSeedCredentialRefresh(
  current: IntegrationDescriptorRecord,
  input: IntegrationDescriptorCreateInput,
): boolean {
  if (current.authStrategy !== 'oauth2_authorization_code'
      || input.authStrategy !== 'oauth2_authorization_code'
      || !current.oauth
      || !input.oauth) return false;
  const { clientId: currentClientId, ...currentOAuthSeedFields } = current.oauth;
  const { clientId: inputClientId, ...inputOAuthSeedFields } = input.oauth;
  return input.provider === current.provider
    && input.ownership === current.ownership
    && input.ownerUserId === current.ownerUserId
    && input.displayName === current.displayName
    && input.category === current.category
    && isDeepStrictEqual(input.apiHosts, current.apiHosts)
    && isDeepStrictEqual(inputOAuthSeedFields, currentOAuthSeedFields)
    && inputClientId === currentClientId
    && (input.clientSecretRevision ?? null) === (current.clientSecretRevision ?? null)
    && isDeepStrictEqual(input.staticApiKey ?? null, current.staticApiKey)
    && (input.curatedSeedRevision ?? null) === (current.curatedSeedRevision ?? null)
    && isDeepStrictEqual(input.operationPromotion ?? {}, current.operationPromotion)
    && input.createdAt.getTime() === current.createdAt.getTime();
}

export function resolveDescriptorPageLimit(limit: number | undefined): number {
  if (limit === undefined) return INTEGRATION_DESCRIPTOR_PAGE_MAX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > INTEGRATION_DESCRIPTOR_PAGE_MAX_LIMIT) {
    throw new ConsoleStoreValidationError(
      `limit must be an integer between 1 and ${INTEGRATION_DESCRIPTOR_PAGE_MAX_LIMIT}`,
    );
  }
  return limit;
}

export function encodeDescriptorPageCursor(record: IntegrationDescriptorRecord): string {
  return `${record.provider}:${record.id}`;
}

export function decodeDescriptorPageCursor(cursor: string): {
  readonly provider: UserIntegrationProvider;
  readonly id: string;
} {
  const separator = cursor.indexOf(':');
  if (separator < 1) {
    throw new ConsoleStoreValidationError('cursor is invalid');
  }
  const provider = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  assertUserIntegrationProvider(provider);
  assertUuid(id, 'cursor id');
  return { provider, id };
}

/**
 * Total order over (provider, id) by code-point comparison. This MUST be the
 * ordering the in-memory store sorts by, because the keyset cursor filter
 * (`isAfterDescriptorPageCursor`) uses the same `<`/`>` comparison — a
 * divergent sort (e.g. `localeCompare`, which orders `_`/`-` differently from
 * code points for the `[a-z0-9_-]` charset) would silently drop rows from
 * later pages. PostgreSQL is internally consistent (one collation drives both
 * ORDER BY and the keyset predicate); this keeps the in-memory backend paired.
 */
export function compareDescriptorPageOrder(
  left: Pick<IntegrationDescriptorRecord, 'provider' | 'id'>,
  right: Pick<IntegrationDescriptorRecord, 'provider' | 'id'>,
): number {
  if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * (provider, id) keyset comparison matching the page ordering. UUID string
 * comparison agrees with PostgreSQL's byte-wise uuid ordering because the
 * canonical form is fixed-width lowercase hex.
 */
export function isAfterDescriptorPageCursor(
  record: IntegrationDescriptorRecord,
  cursor: { readonly provider: string; readonly id: string },
): boolean {
  return record.provider > cursor.provider
    || (record.provider === cursor.provider && record.id > cursor.id);
}

export function validateIntegrationDescriptorRecord(record: IntegrationDescriptorRecord): void {
  assertUuid(record.id, 'id');
  // Rows written before #2494 may contain private suffixes that were valid at
  // the time. Keep them readable so one row cannot break list/provider reads;
  // runtime allowlist checks still reject egress and every new write is strict.
  validateIntegrationDescriptorShape(record, true);
}

export function validateIntegrationDescriptorInput(input: IntegrationDescriptorCreateInput): void {
  validateIntegrationDescriptorShape({
    id: '00000000-0000-4000-8000-000000000000',
    provider: input.provider,
    ownership: input.ownership,
    ownerUserId: input.ownerUserId,
    displayName: input.displayName,
    category: input.category,
    authStrategy: input.authStrategy,
    apiHosts: input.apiHosts,
    oauth: input.oauth ?? null,
    staticApiKey: input.staticApiKey ?? null,
    clientSecretCiphertext: input.clientSecretCiphertext ?? null,
    clientSecretRevision: input.clientSecretRevision ?? null,
    credentialKeyVersion: input.credentialKeyVersion ?? null,
    curatedSeedRevision: input.curatedSeedRevision ?? null,
    operationPromotion: input.operationPromotion ?? {},
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  }, false);
}

export function cloneIntegrationDescriptorRecord(
  record: IntegrationDescriptorRecord,
): IntegrationDescriptorRecord {
  return {
    ...record,
    apiHosts: [...record.apiHosts],
    oauth: record.oauth ? cloneOAuth(record.oauth) : null,
    staticApiKey: record.staticApiKey ? {
      injection: { ...record.staticApiKey.injection },
    } : null,
    clientSecretCiphertext: record.clientSecretCiphertext ? cloneBuffer(record.clientSecretCiphertext) : null,
    operationPromotion: cloneJsonRecord(record.operationPromotion),
    createdAt: cloneDate(record.createdAt) ?? new Date(record.createdAt),
    updatedAt: cloneDate(record.updatedAt) ?? new Date(record.updatedAt),
  };
}

/**
 * Provider ids a descriptor must never claim:
 * - `descriptors` collides with the fixed authoring route segment;
 * - `github` is a bespoke registry-only provider whose credential is stored
 *   under the same provider-keyed context the gateway injects, so a BYO
 *   `github` descriptor could route the deployment-brokered GitHub token to a
 *   descriptor-chosen host. Bespoke/registry-only provider ids are reserved
 *   here as the store-boundary belt; the authoring service additionally
 *   rejects every id present in the boot provider registry.
 */
const RESERVED_DESCRIPTOR_PROVIDER_IDS = new Set(['descriptors', 'github']);

function validateIntegrationDescriptorShape(
  record: Omit<IntegrationDescriptorRecord, 'id'> & { readonly id?: string },
  allowLegacyPrivateSuffixes: boolean,
): void {
  assertUserIntegrationProvider(record.provider);
  if (RESERVED_DESCRIPTOR_PROVIDER_IDS.has(record.provider)) {
    throw new ConsoleStoreValidationError(`provider id '${record.provider}' is reserved`);
  }
  const ownership: string = record.ownership;
  if (ownership !== 'curated' && ownership !== 'byo') {
    throw new ConsoleStoreValidationError('descriptor ownership must be curated or byo');
  }
  if (record.ownership === 'curated' && record.ownerUserId !== null) {
    throw new ConsoleStoreValidationError('curated descriptor must not have ownerUserId');
  }
  if (record.ownership === 'byo') {
    if (record.ownerUserId === null) {
      throw new ConsoleStoreValidationError('byo descriptor requires ownerUserId');
    }
    assertUuid(record.ownerUserId, 'ownerUserId');
  }
  assertDisplayString(record.displayName, 'displayName', 120);
  assertDisplayString(record.category, 'category', 80);
  validateAuthStrategy(record, allowLegacyPrivateSuffixes);
  validateApiHosts(record.apiHosts, allowLegacyPrivateSuffixes);
  validateOptionalCredential(
    record.clientSecretCiphertext,
    record.clientSecretRevision,
    record.credentialKeyVersion,
  );
  validateCuratedSeedRevision(record.ownership, record.curatedSeedRevision ?? null);
  validateJsonRecord(record.operationPromotion, 'operationPromotion', 8192);
  if (record.updatedAt < record.createdAt) {
    throw new ConsoleStoreValidationError('updatedAt must be at or after createdAt');
  }
}

function validateCuratedSeedRevision(
  ownership: IntegrationDescriptorOwnership,
  revision: number | null,
): void {
  if (revision === null) return;
  if (ownership !== 'curated') {
    throw new ConsoleStoreValidationError('curatedSeedRevision is only valid for curated descriptors');
  }
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647) {
    throw new ConsoleStoreValidationError('curatedSeedRevision must be a positive 32-bit integer');
  }
}

function validateAuthStrategy(record: Pick<
  IntegrationDescriptorRecord,
  'authStrategy' | 'oauth' | 'staticApiKey' | 'clientSecretCiphertext'
>, allowLegacyPrivateSuffixes: boolean): void {
  switch (record.authStrategy) {
    case 'oauth2_authorization_code':
      if (!record.oauth) throw new ConsoleStoreValidationError('oauth descriptor is required');
      if (record.staticApiKey) throw new ConsoleStoreValidationError('oauth descriptor cannot include staticApiKey');
      validateOAuthDescriptor(record.oauth, allowLegacyPrivateSuffixes);
      return;
    case 'static_api_key':
      if (!record.staticApiKey) throw new ConsoleStoreValidationError('staticApiKey descriptor is required');
      if (record.oauth) throw new ConsoleStoreValidationError('static_api_key descriptor cannot include oauth');
      validateStaticApiKeyDescriptor(record.staticApiKey);
      return;
    case 'coded':
      if (record.oauth || record.staticApiKey || record.clientSecretCiphertext) {
        throw new ConsoleStoreValidationError('coded descriptor cannot include descriptor-owned credentials');
      }
      return;
    default:
      throw new ConsoleStoreValidationError('unsupported authStrategy');
  }
}

function validateOAuthDescriptor(oauth: IntegrationOAuthDescriptor, allowLegacyPrivateSuffixes: boolean): void {
  assertDisplayString(oauth.clientId, 'oauth.clientId', 200);
  validatePublicHttpsUrl(oauth.authorizationUrl, 'oauth.authorizationUrl', allowLegacyPrivateSuffixes);
  validatePublicHttpsUrl(oauth.tokenUrl, 'oauth.tokenUrl', allowLegacyPrivateSuffixes);
  const pkce: string = oauth.pkce;
  if (pkce !== 'required' && pkce !== 'supported' && pkce !== 'unsupported') {
    throw new ConsoleStoreValidationError('oauth.pkce must be required, supported, or unsupported');
  }
  const refresh: string = oauth.refresh;
  if (refresh !== 'none' && refresh !== 'static' && refresh !== 'rotating') {
    throw new ConsoleStoreValidationError('oauth.refresh must be none, static, or rotating');
  }
  if (oauth.scopes.length > 100) throw new ConsoleStoreValidationError('oauth.scopes must contain at most 100 entries');
  for (const scope of oauth.scopes) assertDisplayString(scope, 'oauth.scopes entry', 200);
  validateJsonRecord(oauth.tokenExchange, 'oauth.tokenExchange', 4096);
  validateJsonRecord(oauth.accountLabel, 'oauth.accountLabel', 4096);
}

function validateStaticApiKeyDescriptor(staticApiKey: IntegrationStaticApiKeyDescriptor): void {
  const location: string = staticApiKey.injection.location;
  if (location !== 'header' && location !== 'query' && location !== 'basic') {
    throw new ConsoleStoreValidationError('staticApiKey.injection.location must be header, query, or basic');
  }
  if (location === 'basic') {
    // The Basic scheme owns the header and encoding; nothing is configurable.
    if (staticApiKey.injection.name !== 'Authorization') {
      throw new ConsoleStoreValidationError('basic injection name must be Authorization');
    }
    if (staticApiKey.injection.valuePrefix !== null) {
      throw new ConsoleStoreValidationError('basic injection must not declare a valuePrefix');
    }
    return;
  }
  assertDisplayString(staticApiKey.injection.name, 'staticApiKey.injection.name', 120);
  assertNullableDisplayString(staticApiKey.injection.valuePrefix, 'staticApiKey.injection.valuePrefix', 40);
  assertWellFormedUnicode(staticApiKey.injection.name, 'staticApiKey.injection.name');
  if (staticApiKey.injection.valuePrefix !== null) {
    assertWellFormedUnicode(staticApiKey.injection.valuePrefix, 'staticApiKey.injection.valuePrefix');
  }
  const lower = staticApiKey.injection.name.toLowerCase();
  if (['cookie', 'set-cookie'].includes(lower)) {
    throw new ConsoleStoreValidationError('staticApiKey injection name is reserved');
  }
}

function validateApiHosts(hosts: readonly string[], allowLegacyPrivateSuffixes: boolean): void {
  try {
    const canonical = canonicalizeIntegrationApiHosts(hosts, 'apiHosts', { allowLegacyPrivateSuffixes });
    if (canonical.length !== hosts.length || canonical.some((host, index) => host !== hosts[index])) {
      throw new ConsoleStoreValidationError('apiHosts must contain unique canonical hostnames');
    }
  } catch (error) {
    if (error instanceof ConsoleStoreValidationError) throw error;
    if (error instanceof IntegrationApiHostValidationError) {
      throw new ConsoleStoreValidationError(error.message);
    }
    throw error;
  }
}

function validateOptionalCredential(
  ciphertext: Buffer | null,
  revision: string | null,
  keyVersion: string | null,
): void {
  if (ciphertext) assertNonEmptyBuffer(ciphertext, 'clientSecretCiphertext');
  if (revision !== null) assertUuid(revision, 'clientSecretRevision');
  assertNullableDisplayString(keyVersion, 'credentialKeyVersion', 128);
  if (!ciphertext && (revision || keyVersion)) {
    throw new ConsoleStoreValidationError(
      'clientSecretRevision and credentialKeyVersion require clientSecretCiphertext',
    );
  }
}

function validatePublicHttpsUrl(value: string, name: string, allowLegacyPrivateSuffixes: boolean): void {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConsoleStoreValidationError(`${name} must be a valid HTTPS URL`);
  }
  if (url.protocol !== 'https:') throw new ConsoleStoreValidationError(`${name} must use HTTPS`);
  if (url.username || url.password || url.hash) {
    throw new ConsoleStoreValidationError(`${name} must not include credentials or fragments`);
  }
  validatePublicDnsHost(url.hostname, name, allowLegacyPrivateSuffixes);
}

function validatePublicDnsHost(host: string, name: string, allowLegacyPrivateSuffixes: boolean): void {
  try {
    const canonical = canonicalizeIntegrationApiHost(host, name, { allowLegacyPrivateSuffixes });
    if (host !== canonical) {
      throw new ConsoleStoreValidationError(`${name} must use its canonical hostname`);
    }
  } catch (error) {
    if (error instanceof ConsoleStoreValidationError) throw error;
    if (error instanceof IntegrationApiHostValidationError) {
      throw new ConsoleStoreValidationError(error.message);
    }
    throw error;
  }
}

function validateJsonRecord(value: unknown, name: string, maxBytes: number): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConsoleStoreValidationError(`${name} must be a JSON object`);
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) {
    throw new ConsoleStoreValidationError(`${name} is too large`);
  }
}

function cloneOAuth(oauth: IntegrationOAuthDescriptor): IntegrationOAuthDescriptor {
  return {
    ...oauth,
    scopes: [...oauth.scopes],
    tokenExchange: cloneJsonRecord(oauth.tokenExchange),
    accountLabel: cloneJsonRecord(oauth.accountLabel),
  };
}

function cloneJsonRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return structuredClone(value) as Record<string, unknown>;
}
