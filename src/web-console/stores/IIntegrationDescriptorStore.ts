import { isIP } from 'node:net';

import {
  ConsoleStoreValidationError,
  assertDisplayString,
  assertNullableDisplayString,
  assertNonEmptyBuffer,
  assertUuid,
  cloneBuffer,
  cloneDate,
} from './ConsoleStoreValidation.js';
import {
  assertUserIntegrationProvider,
  type UserIntegrationProvider,
} from './IUserIntegrationStore.js';

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
  readonly credentialKeyVersion: string | null;
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
    readonly location: 'header' | 'query';
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
  readonly credentialKeyVersion?: string | null;
  readonly operationPromotion?: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IIntegrationDescriptorStore {
  listVisible(userId: string): Promise<readonly IntegrationDescriptorRecord[]>;
  findVisibleByProvider(userId: string, provider: UserIntegrationProvider): Promise<IntegrationDescriptorRecord | null>;
  upsert(input: IntegrationDescriptorCreateInput): Promise<IntegrationDescriptorRecord>;
}

export function validateIntegrationDescriptorRecord(record: IntegrationDescriptorRecord): void {
  assertUuid(record.id, 'id');
  validateIntegrationDescriptorShape(record);
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
    credentialKeyVersion: input.credentialKeyVersion ?? null,
    operationPromotion: input.operationPromotion ?? {},
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
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

function validateIntegrationDescriptorShape(
  record: Omit<IntegrationDescriptorRecord, 'id'> & { readonly id?: string },
): void {
  assertUserIntegrationProvider(record.provider);
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
  validateAuthStrategy(record);
  validateApiHosts(record.apiHosts);
  validateOptionalCredential(record.clientSecretCiphertext, record.credentialKeyVersion);
  validateJsonRecord(record.operationPromotion, 'operationPromotion', 8192);
  if (record.updatedAt < record.createdAt) {
    throw new ConsoleStoreValidationError('updatedAt must be at or after createdAt');
  }
}

function validateAuthStrategy(record: Pick<
  IntegrationDescriptorRecord,
  'authStrategy' | 'oauth' | 'staticApiKey' | 'clientSecretCiphertext'
>): void {
  switch (record.authStrategy) {
    case 'oauth2_authorization_code':
      if (!record.oauth) throw new ConsoleStoreValidationError('oauth descriptor is required');
      if (record.staticApiKey) throw new ConsoleStoreValidationError('oauth descriptor cannot include staticApiKey');
      validateOAuthDescriptor(record.oauth);
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

function validateOAuthDescriptor(oauth: IntegrationOAuthDescriptor): void {
  assertDisplayString(oauth.clientId, 'oauth.clientId', 200);
  validatePublicHttpsUrl(oauth.authorizationUrl, 'oauth.authorizationUrl');
  validatePublicHttpsUrl(oauth.tokenUrl, 'oauth.tokenUrl');
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
  if (location !== 'header' && location !== 'query') {
    throw new ConsoleStoreValidationError('staticApiKey.injection.location must be header or query');
  }
  assertDisplayString(staticApiKey.injection.name, 'staticApiKey.injection.name', 120);
  assertNullableDisplayString(staticApiKey.injection.valuePrefix, 'staticApiKey.injection.valuePrefix', 40);
  const lower = staticApiKey.injection.name.toLowerCase();
  if (['cookie', 'set-cookie'].includes(lower)) {
    throw new ConsoleStoreValidationError('staticApiKey injection name is reserved');
  }
}

function validateApiHosts(hosts: readonly string[]): void {
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > 25) {
    throw new ConsoleStoreValidationError('apiHosts must contain 1-25 hosts');
  }
  const seen = new Set<string>();
  for (const host of hosts) {
    validatePublicDnsHost(host, 'apiHosts entry');
    if (seen.has(host)) throw new ConsoleStoreValidationError('apiHosts must not contain duplicates');
    seen.add(host);
  }
}

function validateOptionalCredential(ciphertext: Buffer | null, keyVersion: string | null): void {
  if (ciphertext) assertNonEmptyBuffer(ciphertext, 'clientSecretCiphertext');
  assertNullableDisplayString(keyVersion, 'credentialKeyVersion', 128);
  if (!ciphertext && keyVersion) {
    throw new ConsoleStoreValidationError('credentialKeyVersion requires clientSecretCiphertext');
  }
}

function validatePublicHttpsUrl(value: string, name: string): void {
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
  validatePublicDnsHost(url.hostname, name);
}

function validatePublicDnsHost(host: string, name: string): void {
  const normalized = host.toLowerCase();
  if (host !== normalized) throw new ConsoleStoreValidationError(`${name} must be lowercase`);
  assertDisplayString(normalized, name, 253);
  if (!normalized.includes('.') ||
      normalized === 'localhost' ||
      normalized.endsWith('.localhost') ||
      normalized.endsWith('.local') ||
      normalized.endsWith('.internal') ||
      isIP(normalized) !== 0) {
    throw new ConsoleStoreValidationError(`${name} must be a public DNS hostname`);
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new ConsoleStoreValidationError(`${name} must be a valid DNS hostname`);
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
