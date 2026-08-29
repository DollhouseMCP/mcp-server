import { randomUUID } from 'node:crypto';

import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import { SecurityMonitor } from '../../../security/securityMonitor.js';
import { containsUnsafeDisplayUnicode } from '../../../security/validators/displayText.js';
import type {
  ConsoleHandlerResult,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import {
  canonicalizeIntegrationApiHosts,
  IntegrationApiHostValidationError,
} from '../../security/IntegrationApiHosts.js';
import {
  ConsoleStoreValidationError,
  isUniqueViolation,
  isValidDisplayString,
  isWellFormedUnicode,
} from '../../stores/ConsoleStoreValidation.js';
import type {
  IIntegrationDescriptorStore,
  IntegrationDescriptorCreateInput,
  IntegrationDescriptorRecord,
  IntegrationOAuthDescriptor,
  IntegrationStaticApiKeyDescriptor,
} from '../../stores/IIntegrationDescriptorStore.js';
import type { IIntegrationOpenApiSpecStore } from '../../stores/IIntegrationOpenApiSpecStore.js';
import type {
  IUserIntegrationStore,
  UserIntegrationProvider,
} from '../../stores/IUserIntegrationStore.js';
import { hasIntegrationCredentials } from '../../stores/IUserIntegrationStore.js';
import { safeIntegrationAuditProvider } from './IntegrationSecurityAudit.js';
import {
  serializeIntegrationDescriptor,
  serializeIntegrationDescriptorList,
  serializeIntegrationOpenApiSpecMetadata,
  serializeIntegrationSpecOperations,
} from './IntegrationDtos.js';
import {
  countSpecOperations,
  deriveSpecOperationSummaries,
  IntegrationOperationCatalogError,
  prepareOpenApiSpecForDescriptor,
} from './IntegrationOperationCatalog.js';
import { integrationDescriptorClientSecretContext } from './IntegrationSecretContext.js';

const MAX_CLIENT_SECRET_BYTES = 8192;
const PROBLEM_TYPE_BLANK = 'about:blank';
const UNRESOLVED_AUDIT_PROVIDER = '<unresolved>';

/**
 * Self-service BYO descriptor authoring (issue #2321, Group 10 Scope 2).
 *
 * Every operation is owner-scoped: ownership is forced to `byo` with the
 * caller as owner on create, and reads/updates/deletes go through the
 * store's owner-scoped `findById`/`delete`, so curated descriptors and other
 * users' descriptors are unreachable (404) from this surface. The OAuth
 * client secret is accepted write-only, encrypted immediately, and never
 * serialized back.
 */
export class IntegrationDescriptorAuthoringService {
  constructor(private readonly options: {
    readonly descriptorStore: IIntegrationDescriptorStore;
    readonly specStore: IIntegrationOpenApiSpecStore;
    readonly integrationStore: IUserIntegrationStore;
    readonly secretEncryption?: ISecretEncryptionService | null;
    /**
     * Provider ids owned by the boot-time registry (bespoke providers like
     * `github` + curated seeds). A BYO descriptor must never claim one:
     * `github`'s credential is stored under the same provider-keyed context
     * the gateway injects, so a BYO `github` would route the deployment token
     * to a user-chosen host; curated ids must not be shadowed. Checked in
     * addition to the store's own reserved-id belt.
     */
    readonly reservedProviderIds?: ReadonlySet<string>;
    readonly now?: () => Date;
  }) {}

  async list(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const limit = parseLimit(req.query.limit);
    if (limit === INVALID) return unprocessable('limit must be a positive integer');
    const cursor = singleQueryValue(req.query.cursor);
    try {
      const page = await this.options.descriptorStore.listVisiblePage(auth.userId, {
        ...(limit === undefined ? {} : { limit }),
        cursor,
      });
      return {
        status: 200,
        body: serializeIntegrationDescriptorList(page.items, page.nextCursor),
      };
    } catch (error) {
      if (error instanceof ConsoleStoreValidationError) return unprocessable(error.message);
      throw error;
    }
  }

  async create(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    let parsed: ParsedDescriptorBody;
    try {
      parsed = parseDescriptorBody(req.body, 'create');
    } catch (error) {
      if (error instanceof DescriptorBodyError) {
        auditDescriptorDecision(UNRESOLVED_AUDIT_PROVIDER, 'created', 'denied_invalid');
        return unprocessable(error.message);
      }
      auditDescriptorDecision(UNRESOLVED_AUDIT_PROVIDER, 'created', 'failed');
      throw error;
    }
    if (!parsed.provider) {
      auditDescriptorDecision(UNRESOLVED_AUDIT_PROVIDER, 'created', 'denied_invalid');
      return unprocessable('provider is required');
    }
    // A boot-registry provider id (bespoke `github` or a curated seed) must
    // not be claimed by a BYO descriptor — it would shadow that provider's
    // routing while the gateway still injects the registry provider's stored
    // credential (deployment-token exfiltration for `github`).
    try {
      if (this.options.reservedProviderIds?.has(parsed.provider)) {
        auditDescriptorDecision(parsed.provider, 'created', 'denied_reserved');
        return conflict(`provider '${parsed.provider}' is reserved by a built-in or curated provider`);
      }
      // A provider id shared with ANY visible descriptor (curated or own BYO)
      // would make provider-keyed resolution ambiguous for this user.
      const collision = await this.options.descriptorStore.findVisibleByProvider(
        auth.userId,
        parsed.provider as UserIntegrationProvider,
      );
      if (collision) {
        auditDescriptorDecision(parsed.provider, 'created', 'denied_conflict');
        return conflict(`provider '${parsed.provider}' already has a visible descriptor`);
      }

      const secret = this.encryptClientSecret(parsed, auth.userId, null);
      if (secret === ENCRYPTION_UNAVAILABLE) {
        auditDescriptorDecision(parsed.provider, 'created', 'unavailable');
        return encryptionUnavailable();
      }
      const now = this.now();
      const record = await this.options.descriptorStore.upsert(buildCreateInput(
        parsed,
        auth.userId,
        secret,
        clientSecretRevision(parsed, null),
        now,
        now,
      ));
      auditDescriptorDecision(record.provider, 'created', 'allowed');
      return { status: 201, body: serializeIntegrationDescriptor(record) };
    } catch (error) {
      if (error instanceof ConsoleStoreValidationError) {
        auditDescriptorDecision(parsed.provider, 'created', 'denied_invalid');
        return unprocessable(error.message);
      }
      // Two concurrent creates for the same (provider, owner) both pass the
      // pre-check under READ COMMITTED; the loser trips the unique constraint.
      // Surface it as the same 409 the pre-check returns, not a 500.
      if (isUniqueViolation(error)) {
        auditDescriptorDecision(parsed.provider, 'created', 'denied_conflict');
        return conflict(`provider '${parsed.provider}' already has a visible descriptor`);
      }
      auditDescriptorDecision(parsed.provider, 'created', 'failed');
      throw error;
    }
  }

  async get(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const record = await this.findOwned(singleParamValue(req.params.id), auth.userId);
    if (!record) return notFound();
    return { status: 200, body: serializeIntegrationDescriptor(record) };
  }

  async update(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const existing = await this.findOwnedForMutation(singleParamValue(req.params.id), auth.userId, 'updated');
    if (!existing) {
      auditDescriptorDecision(UNRESOLVED_AUDIT_PROVIDER, 'updated', 'denied_not_found');
      return notFound();
    }
    let parsed: ParsedDescriptorBody;
    try {
      parsed = parseDescriptorBody(req.body, 'patch');
    } catch (error) {
      if (error instanceof DescriptorBodyError) {
        auditDescriptorDecision(existing.provider, 'updated', 'denied_invalid');
        return unprocessable(error.message);
      }
      auditDescriptorDecision(existing.provider, 'updated', 'failed');
      throw error;
    }
    if (parsed.provider !== undefined && parsed.provider !== existing.provider) {
      // The store's upsert identity is (provider, ownership, owner); renaming
      // would strand the old row. Delete + recreate instead.
      auditDescriptorDecision(existing.provider, 'updated', 'denied_invalid');
      return unprocessable('provider cannot be changed; delete and recreate the descriptor');
    }

    try {
      const merged = mergeDescriptor(existing, parsed);
      if (hasCredentialRoutingChanges(parsed)) {
        const active = await this.options.integrationStore.findByProvider(auth.userId, existing.provider);
        if (hasIntegrationCredentials(active)) {
          auditDescriptorDecision(existing.provider, 'updated', 'blocked_connected');
          return connectedDescriptorConflict('updated');
        }
      }
      // Use `merged` (not `parsed`): it carries `mergedProvider = existing.provider`
      // so encryptClientSecret's provider guard never misfires and the AAD binds
      // to the real provider. Passing `parsed` here dropped a rotated secret when
      // the PATCH body omitted `provider`.
      const secret = this.encryptClientSecret(merged, auth.userId, preservedSecret(existing, merged));
      if (secret === ENCRYPTION_UNAVAILABLE) {
        auditDescriptorDecision(existing.provider, 'updated', 'unavailable');
        return encryptionUnavailable();
      }
      const record = await this.options.descriptorStore.upsert(
        buildCreateInput(
          merged,
          auth.userId,
          secret,
          clientSecretRevision(merged, existing),
          existing.createdAt,
          this.now(),
        ),
      );
      auditDescriptorDecision(record.provider, 'updated', 'allowed');
      return { status: 200, body: serializeIntegrationDescriptor(record) };
    } catch (error) {
      if (error instanceof ConsoleStoreValidationError) {
        auditDescriptorDecision(existing.provider, 'updated', 'denied_invalid');
        return unprocessable(error.message);
      }
      auditDescriptorDecision(existing.provider, 'updated', 'failed');
      throw error;
    }
  }

  async remove(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const id = singleParamValue(req.params.id);
    if (!isUuidShaped(id)) {
      auditDescriptorDecision(UNRESOLVED_AUDIT_PROVIDER, 'deleted', 'denied_not_found');
      return notFound();
    }
    const existing = await this.findOwnedForMutation(id, auth.userId, 'deleted');
    if (!existing) {
      auditDescriptorDecision(UNRESOLVED_AUDIT_PROVIDER, 'deleted', 'denied_not_found');
      return notFound();
    }
    try {
      const active = await this.options.integrationStore.findByProvider(auth.userId, existing.provider);
      if (hasIntegrationCredentials(active)) {
        auditDescriptorDecision(existing.provider, 'deleted', 'blocked_connected');
        return connectedDescriptorConflict('deleted');
      }
      const deleted = await this.options.descriptorStore.delete(id, auth.userId);
      if (!deleted) {
        auditDescriptorDecision(existing.provider, 'deleted', 'failed');
        return notFound();
      }
      // Postgres cascades via FK; this keeps in-memory backends equivalent.
      await this.options.specStore.deleteByDescriptorId(id);
      auditDescriptorDecision(existing.provider, 'deleted', 'allowed');
      return { status: 204 };
    } catch (error) {
      auditDescriptorDecision(existing.provider, 'deleted', 'failed');
      throw error;
    }
  }

  async putSpec(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const descriptor = await this.findOwnedForMutation(
      singleParamValue(req.params.id),
      auth.userId,
      'spec_updated',
    );
    if (!descriptor) {
      auditDescriptorDecision(UNRESOLVED_AUDIT_PROVIDER, 'spec_updated', 'denied_not_found');
      return notFound();
    }
    try {
      const input = asRecord(req.body);
      if (!input.spec || typeof input.spec !== 'object' || Array.isArray(input.spec)) {
        auditDescriptorDecision(descriptor.provider, 'spec_updated', 'denied_invalid');
        return unprocessable('spec must be a JSON object');
      }
      const sourceUrl = input.source_url;
      if (sourceUrl !== undefined && sourceUrl !== null && typeof sourceUrl !== 'string') {
        auditDescriptorDecision(descriptor.provider, 'spec_updated', 'denied_invalid');
        return unprocessable('source_url must be a string or null');
      }
      const prepared = prepareOpenApiSpecForDescriptor(input.spec, descriptor);
      const now = this.now();
      const record = await this.options.specStore.upsert({
        descriptorId: descriptor.id,
        spec: prepared.normalizedSpec,
        sourceUrl: sourceUrl ?? null,
        specHash: prepared.specHash,
        createdAt: now,
        updatedAt: now,
      });
      auditDescriptorDecision(descriptor.provider, 'spec_updated', 'allowed');
      return {
        status: 200,
        body: serializeIntegrationOpenApiSpecMetadata({
          descriptorId: record.descriptorId,
          provider: descriptor.provider,
          specHash: record.specHash,
          sourceUrl: record.sourceUrl,
          operationCount: countSpecOperations(descriptor, record.spec),
          spec: record.spec,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }),
      };
    } catch (error) {
      if (error instanceof IntegrationOperationCatalogError) {
        auditDescriptorDecision(descriptor.provider, 'spec_updated', 'denied_invalid');
        return catalogError(error);
      }
      if (error instanceof ConsoleStoreValidationError) {
        auditDescriptorDecision(descriptor.provider, 'spec_updated', 'denied_invalid');
        return unprocessable(error.message);
      }
      auditDescriptorDecision(descriptor.provider, 'spec_updated', 'failed');
      throw error;
    }
  }

  async getSpec(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const descriptor = await this.findOwned(singleParamValue(req.params.id), auth.userId);
    if (!descriptor) return notFound();
    const record = await this.options.specStore.findByDescriptorId(descriptor.id);
    if (!record) return specNotFound();
    return {
      status: 200,
      body: serializeIntegrationOpenApiSpecMetadata({
        descriptorId: record.descriptorId,
        provider: descriptor.provider,
        specHash: record.specHash,
        sourceUrl: record.sourceUrl,
        operationCount: countSpecOperations(descriptor, record.spec),
        spec: record.spec,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }),
    };
  }

  async listSpecOperations(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const descriptor = await this.findOwned(singleParamValue(req.params.id), auth.userId);
    if (!descriptor) return notFound();
    const record = await this.options.specStore.findByDescriptorId(descriptor.id);
    if (!record) return specNotFound();
    return {
      status: 200,
      body: serializeIntegrationSpecOperations({
        descriptorId: record.descriptorId,
        specHash: record.specHash,
        operations: deriveSpecOperationSummaries(descriptor, record.spec),
      }),
    };
  }

  private async findOwned(id: string | undefined, userId: string): Promise<IntegrationDescriptorRecord | null> {
    if (!isUuidShaped(id)) return null;
    return this.options.descriptorStore.findById(id, userId);
  }

  private async findOwnedForMutation(
    id: string | undefined,
    userId: string,
    action: 'updated' | 'deleted' | 'spec_updated',
  ): Promise<IntegrationDescriptorRecord | null> {
    try {
      return await this.findOwned(id, userId);
    } catch (error) {
      auditDescriptorDecision(UNRESOLVED_AUDIT_PROVIDER, action, 'failed');
      throw error;
    }
  }

  private encryptClientSecret(
    parsed: ParsedDescriptorBody,
    ownerUserId: string,
    preserved: Buffer | null,
  ): Buffer | null | typeof ENCRYPTION_UNAVAILABLE {
    if (parsed.clientSecret === undefined) return preserved;
    if (parsed.clientSecret === null) return null;
    if (!this.options.secretEncryption) return ENCRYPTION_UNAVAILABLE;
    if (!parsed.provider && !parsed.mergedProvider) return null;
    return this.options.secretEncryption.encrypt(
      Buffer.from(parsed.clientSecret, 'utf8'),
      integrationDescriptorClientSecretContext({
        provider: parsed.mergedProvider ?? parsed.provider ?? '',
        ownerUserId,
      }),
    );
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

const ENCRYPTION_UNAVAILABLE: unique symbol = Symbol('encryption_unavailable');
const INVALID: unique symbol = Symbol('invalid');

class DescriptorBodyError extends Error {}

interface ParsedDescriptorBody {
  provider?: string;
  /** Set during merge so secret AAD always binds to the effective provider. */
  mergedProvider?: string;
  displayName?: string;
  category?: string;
  authStrategy?: string;
  apiHosts?: readonly string[];
  oauth?: IntegrationOAuthDescriptor | null;
  staticApiKey?: IntegrationStaticApiKeyDescriptor | null;
  operationPromotion?: Readonly<Record<string, unknown>>;
  /** undefined = untouched; null = explicit removal; string = set/replace. */
  clientSecret?: string | null;
}

function parseDescriptorBody(body: unknown, mode: 'create' | 'patch'): ParsedDescriptorBody {
  const input = asRecord(body);
  const parsed: ParsedDescriptorBody = {};
  if (mode === 'create' || input.provider !== undefined) {
    parsed.provider = requireString(input.provider, 'provider');
  }
  if (mode === 'create' || input.display_name !== undefined) {
    parsed.displayName = requireDisplayString(input.display_name, 'display_name', 120);
  }
  if (mode === 'create' || input.category !== undefined) {
    parsed.category = requireDisplayString(input.category, 'category', 80);
  }
  if (mode === 'create' || input.auth_strategy !== undefined) {
    parsed.authStrategy = requireString(input.auth_strategy, 'auth_strategy');
    if (parsed.authStrategy === 'coded') {
      throw new DescriptorBodyError("auth_strategy 'coded' is not available for self-service descriptors");
    }
  }
  if (mode === 'create' || input.api_hosts !== undefined) {
    parsed.apiHosts = parseApiHosts(input.api_hosts);
  }
  if (input.oauth !== undefined) {
    const { oauth, clientSecret } = parseOAuthBody(input.oauth);
    parsed.oauth = oauth;
    if (clientSecret !== undefined) parsed.clientSecret = clientSecret;
  }
  if (input.static_api_key !== undefined) {
    parsed.staticApiKey = parseStaticApiKeyBody(input.static_api_key);
  }
  if (input.operation_promotion !== undefined) {
    parsed.operationPromotion = requireRecord(input.operation_promotion, 'operation_promotion');
  }
  return parsed;
}

function parseApiHosts(value: unknown): readonly string[] {
  const hosts = requireStringArray(value, 'api_hosts');
  try {
    return canonicalizeIntegrationApiHosts(hosts, 'api_hosts');
  } catch (error) {
    if (error instanceof IntegrationApiHostValidationError) {
      throw new DescriptorBodyError(error.message);
    }
    throw error;
  }
}

function parseOAuthBody(value: unknown): {
  readonly oauth: IntegrationOAuthDescriptor | null;
  readonly clientSecret?: string | null;
} {
  if (value === null) return { oauth: null, clientSecret: null };
  const input = requireRecord(value, 'oauth');
  const clientSecret = parseClientSecret(input.client_secret);
  return {
    oauth: {
      clientId: requireString(input.client_id, 'oauth.client_id'),
      authorizationUrl: requireString(input.authorization_url, 'oauth.authorization_url'),
      tokenUrl: requireString(input.token_url, 'oauth.token_url'),
      scopes: input.scopes === undefined ? [] : requireStringArray(input.scopes, 'oauth.scopes'),
      pkce: parsePkce(input.pkce),
      refresh: parseRefresh(input.refresh),
      tokenExchange: input.token_exchange === undefined ? {} : requireRecord(input.token_exchange, 'oauth.token_exchange'),
      accountLabel: input.account_label === undefined ? {} : requireRecord(input.account_label, 'oauth.account_label'),
    },
    ...(clientSecret === undefined ? {} : { clientSecret }),
  };
}

function parseClientSecret(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DescriptorBodyError('oauth.client_secret must be a non-empty string or null');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_CLIENT_SECRET_BYTES) {
    throw new DescriptorBodyError('oauth.client_secret is too large');
  }
  return value;
}

function parseStaticApiKeyBody(value: unknown): IntegrationStaticApiKeyDescriptor | null {
  if (value === null) return null;
  const input = requireRecord(value, 'static_api_key');
  const injection = requireRecord(input.injection, 'static_api_key.injection');
  const location = injection.location;
  if (location !== 'header' && location !== 'query' && location !== 'basic') {
    throw new DescriptorBodyError('static_api_key.injection.location must be header, query, or basic');
  }
  const valuePrefix = injection.value_prefix;
  if (valuePrefix !== undefined && valuePrefix !== null && typeof valuePrefix !== 'string') {
    throw new DescriptorBodyError('static_api_key.injection.value_prefix must be a string or null');
  }
  if (typeof valuePrefix === 'string' && !isWellFormedUnicode(valuePrefix)) {
    throw new DescriptorBodyError('static_api_key.injection.value_prefix must contain well-formed Unicode');
  }
  // Basic owns its header: the name defaults to Authorization and any other
  // supplied value is rejected here (rather than deferring to a store 422).
  let name: string;
  if (location === 'basic') {
    if (injection.name !== undefined && injection.name !== 'Authorization') {
      throw new DescriptorBodyError('basic injection name must be Authorization');
    }
    name = 'Authorization';
  } else {
    name = requireString(injection.name, 'static_api_key.injection.name');
    if (!isWellFormedUnicode(name)) {
      throw new DescriptorBodyError('static_api_key.injection.name must contain well-formed Unicode');
    }
  }
  return {
    injection: {
      location,
      name,
      valuePrefix: typeof valuePrefix === 'string' ? valuePrefix : null,
    },
  };
}

function parsePkce(value: unknown): IntegrationOAuthDescriptor['pkce'] {
  if (value === undefined) return 'required';
  if (value === 'required' || value === 'supported' || value === 'unsupported') return value;
  throw new DescriptorBodyError('oauth.pkce must be required, supported, or unsupported');
}

function parseRefresh(value: unknown): IntegrationOAuthDescriptor['refresh'] {
  if (value === undefined) return 'none';
  if (value === 'none' || value === 'static' || value === 'rotating') return value;
  throw new DescriptorBodyError('oauth.refresh must be none, static, or rotating');
}

function mergeDescriptor(
  existing: IntegrationDescriptorRecord,
  parsed: ParsedDescriptorBody,
): ParsedDescriptorBody {
  const authStrategy = parsed.authStrategy ?? existing.authStrategy;
  // Strategy objects replace wholesale; switching strategy drops the other
  // side rather than carrying stale config into a shape the store rejects.
  const strategyChanged = authStrategy !== existing.authStrategy;
  const inheritedOAuth = strategyChanged ? null : existing.oauth;
  const inheritedStaticApiKey = strategyChanged ? null : existing.staticApiKey;
  return {
    provider: existing.provider,
    mergedProvider: existing.provider,
    displayName: parsed.displayName ?? existing.displayName,
    category: parsed.category ?? existing.category,
    authStrategy,
    apiHosts: parsed.apiHosts ?? existing.apiHosts,
    oauth: parsed.oauth === undefined ? inheritedOAuth : parsed.oauth,
    staticApiKey: parsed.staticApiKey === undefined ? inheritedStaticApiKey : parsed.staticApiKey,
    operationPromotion: parsed.operationPromotion ?? existing.operationPromotion,
    ...(parsed.clientSecret === undefined ? {} : { clientSecret: parsed.clientSecret }),
  };
}

function hasCredentialRoutingChanges(parsed: ParsedDescriptorBody): boolean {
  // Promotion selects which remote operations receive the stored credential,
  // so changing it is a routing change even though the credential is unchanged.
  return parsed.authStrategy !== undefined
    || parsed.apiHosts !== undefined
    || parsed.oauth !== undefined
    || parsed.staticApiKey !== undefined
    || parsed.operationPromotion !== undefined
    || parsed.clientSecret !== undefined;
}

/** A stored secret survives a PATCH only while the descriptor stays OAuth. */
function preservedSecret(existing: IntegrationDescriptorRecord, merged: ParsedDescriptorBody): Buffer | null {
  if (merged.authStrategy !== 'oauth2_authorization_code') return null;
  return existing.clientSecretCiphertext;
}

function buildCreateInput(
  parsed: ParsedDescriptorBody,
  ownerUserId: string,
  clientSecretCiphertext: Buffer | null,
  clientSecretRevisionValue: string | null,
  createdAt: Date,
  updatedAt: Date,
): IntegrationDescriptorCreateInput {
  return {
    provider: (parsed.mergedProvider ?? parsed.provider ?? '') as UserIntegrationProvider,
    ownership: 'byo',
    ownerUserId,
    displayName: parsed.displayName ?? '',
    category: parsed.category ?? '',
    authStrategy: (parsed.authStrategy ?? '') as IntegrationDescriptorCreateInput['authStrategy'],
    apiHosts: parsed.apiHosts ?? [],
    oauth: parsed.oauth ?? null,
    staticApiKey: parsed.staticApiKey ?? null,
    clientSecretCiphertext,
    clientSecretRevision: clientSecretRevisionValue,
    credentialKeyVersion: null,
    operationPromotion: parsed.operationPromotion ?? {},
    createdAt,
    updatedAt,
  };
}

function clientSecretRevision(
  parsed: ParsedDescriptorBody,
  existing: IntegrationDescriptorRecord | null,
): string | null {
  if (parsed.authStrategy !== 'oauth2_authorization_code') return null;
  if (parsed.clientSecret === undefined) return existing?.clientSecretRevision ?? null;
  if (parsed.clientSecret === null) return null;
  return randomUUID();
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DescriptorBodyError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireDisplayString(value: unknown, name: string, maxLength: number): string {
  const normalized = requireString(value, name).normalize('NFC');
  if (!isValidDisplayString(normalized, maxLength) || containsUnsafeDisplayUnicode(normalized)) {
    throw new DescriptorBodyError(
      `${name} must be a printable non-empty string up to ${maxLength} characters without directional or zero-width characters`,
    );
  }
  return normalized;
}

function requireStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new DescriptorBodyError(`${name} must be an array of strings`);
  }
  return value as string[];
}

function requireRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DescriptorBodyError(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseLimit(value: unknown): number | undefined | typeof INVALID {
  const raw = singleQueryValue(value);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : INVALID;
}

function singleQueryValue(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

function singleParamValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isUuidShaped(value: string | undefined): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function consoleProblem(
  status: number,
  title: string,
  code: string,
  detail: string,
): ConsoleHandlerResult {
  return {
    status,
    body: { type: PROBLEM_TYPE_BLANK, title, status, code, detail },
  };
}

function notFound(): ConsoleHandlerResult {
  return consoleProblem(404, 'Not found', 'integration_descriptor_not_found', 'Integration descriptor was not found.');
}

function specNotFound(): ConsoleHandlerResult {
  return consoleProblem(404, 'Not found', 'integration_spec_not_found', 'No OpenAPI spec is stored for this descriptor.');
}

function catalogError(error: IntegrationOperationCatalogError): ConsoleHandlerResult {
  return consoleProblem(error.status, 'Invalid OpenAPI spec', error.code, error.message);
}

function conflict(detail: string): ConsoleHandlerResult {
  return consoleProblem(409, 'Conflict', 'integration_descriptor_conflict', detail);
}

function connectedDescriptorConflict(action: 'updated' | 'deleted'): ConsoleHandlerResult {
  return conflict(`descriptor cannot be ${action} while its integration is connected; disconnect it first`);
}

type DescriptorAuditOutcome =
  | 'allowed'
  | 'blocked_connected'
  | 'denied_conflict'
  | 'denied_invalid'
  | 'denied_not_found'
  | 'denied_reserved'
  | 'failed'
  | 'unavailable';

function auditDescriptorDecision(provider: string, action: string, outcome: DescriptorAuditOutcome): void {
  SecurityMonitor.logSecurityEvent({
    type: 'INTEGRATION_SECURITY_DECISION',
    severity: outcome === 'allowed' ? 'LOW' : 'MEDIUM',
    source: 'IntegrationDescriptorAuthoringService',
    details: `Integration descriptor ${action} ${outcome} for provider ${safeIntegrationAuditProvider(provider)}`,
  });
}

function unprocessable(detail: string): ConsoleHandlerResult {
  return consoleProblem(422, 'Unprocessable content', 'invalid_integration_descriptor', detail);
}

function encryptionUnavailable(): ConsoleHandlerResult {
  return consoleProblem(503, 'Service unavailable', 'service_unavailable', 'Descriptor secret encryption is not configured.');
}
