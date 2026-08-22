/**
 * IntegrationDescriptorSeedLoader
 *
 * Loads curated integration descriptors from deployment-shipped data files at
 * startup, modelled on `collection/shared-pool/DeploymentSeedLoader`. Curated
 * providers are DATA, not code: a deployment drops a descriptor `*.json` file in
 * the seed directory and the loader validates it and upserts it into the
 * descriptor store. Per-provider OAuth client identity/secret are NOT in the
 * file — they are injected from deployment credentials (env) at load time and the
 * secret is encrypted before storage, so the data file never carries a secret.
 *
 * Scope: this loader only gets descriptors INTO the store. Building providers
 * from them and wiring routes is a separate composition step.
 *
 * Idempotent: `descriptorStore.upsert` is keyed by provider, so re-running on
 * every boot refreshes curated descriptors in place. Per-file failures are
 * non-fatal — a bad file is logged and skipped, never aborting startup.
 *
 * @module web-console/modules/integrations/IntegrationDescriptorSeedLoader
 */

import { timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { SecurityMonitor } from '../../../security/securityMonitor.js';
import { logger } from '../../../utils/logger.js';
import { canonicalizeIntegrationApiHosts } from '../../security/IntegrationApiHosts.js';
import type { IConsoleOpaqueValueService } from '../../security/ConsoleOpaqueValues.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import {
  type IIntegrationDescriptorStore,
  type CuratedIntegrationSeedDirective,
  type IntegrationDescriptorCreateInput,
  type IntegrationDescriptorRecord,
  type IntegrationDescriptorUpsertOptions,
  type IntegrationPkceMode,
  type IntegrationRefreshMode,
  IntegrationDescriptorMutationBusyError,
  validateIntegrationDescriptorInput,
} from '../../stores/IIntegrationDescriptorStore.js';
import type { IUserIntegrationStore, UserIntegrationProvider } from '../../stores/IUserIntegrationStore.js';
import { deriveIntegrationClientSecretRevision } from './IntegrationClientSecretRevision.js';
import { integrationDescriptorClientSecretContext } from './IntegrationSecretContext.js';
import { safeIntegrationAuditProvider } from './IntegrationSecurityAudit.js';

const SEED_FILE_EXTENSION = '.json';
const SEED_BUSY_RETRY_DELAYS_MS = [10, 20, 40] as const;

/** `github` is owned by the built-in legacy provider; a curated seed must not shadow it. */
const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set(['github']);

/** Deployment-owned OAuth client identity for a curated provider (from env, never the data file). */
export interface IntegrationDescriptorSeedCredentials {
  readonly clientId: string | null;
  readonly clientSecret: string | null;
}

/**
 * Resolves a curated provider's deployment OAuth credentials by provider id.
 * The concrete implementation (reads env) is supplied at composition; injecting
 * it keeps the loader pure and unit-testable.
 */
export type IntegrationDescriptorSeedCredentialResolver = (
  providerId: string,
) => IntegrationDescriptorSeedCredentials;

export interface IntegrationDescriptorSeedLoaderOptions {
  readonly now?: () => Date;
  readonly integrationStore: IUserIntegrationStore;
  readonly secretRevisionHasher: Pick<IConsoleOpaqueValueService, 'hashOpaqueValue'>;
}

interface PreparedDescriptorInput {
  readonly input: IntegrationDescriptorCreateInput;
  readonly upsertOptions?: IntegrationDescriptorUpsertOptions;
}

export interface IntegrationDescriptorSeedResult {
  readonly loaded: number;
  readonly skipped: number;
  readonly failed: number;
  /** The descriptor records upserted this run, so composition can build providers without re-querying. */
  readonly descriptors: readonly IntegrationDescriptorRecord[];
}

export class IntegrationDescriptorSeedLoader {
  private readonly now: () => Date;
  private readonly integrationStore: IUserIntegrationStore;
  private readonly secretRevisionHasher: Pick<IConsoleOpaqueValueService, 'hashOpaqueValue'>;

  constructor(
    private readonly seedDir: string,
    private readonly descriptorStore: IIntegrationDescriptorStore,
    private readonly secretEncryption: ISecretEncryptionService,
    private readonly resolveCredentials: IntegrationDescriptorSeedCredentialResolver,
    options: IntegrationDescriptorSeedLoaderOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.integrationStore = options.integrationStore;
    this.secretRevisionHasher = options.secretRevisionHasher;
  }

  /**
   * Scan the seed directory and upsert every curated descriptor file. Safe to
   * call on every startup; never throws on a bad file.
   */
  async loadSeeds(): Promise<IntegrationDescriptorSeedResult> {
    const descriptors: IntegrationDescriptorRecord[] = [];
    let skipped = 0;
    let failed = 0;

    const files = await this.scanSeedFiles();
    if (files.length === 0) {
      logger.debug('[IntegrationDescriptorSeedLoader] No descriptor seed files found', {
        seedDir: this.seedDir,
      });
      return { loaded: 0, skipped, failed, descriptors };
    }

    for (const file of files) {
      try {
        const record = await this.processSeedFile(file);
        if (record) descriptors.push(record);
        else skipped++;
      } catch (err) {
        failed++;
        SecurityMonitor.logSecurityEvent({
          type: 'INTEGRATION_SECURITY_DECISION',
          severity: 'MEDIUM',
          source: 'IntegrationDescriptorSeedLoader.loadSeeds',
          details: `Integration descriptor seed rejected for provider ${safeIntegrationAuditProvider(path.parse(file).name)}`,
        });
        logger.error(`[IntegrationDescriptorSeedLoader] Failed to load descriptor seed: ${path.basename(file)}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('[IntegrationDescriptorSeedLoader] Descriptor seed loading complete', {
      loaded: descriptors.length,
      skipped,
      failed,
    });
    return { loaded: descriptors.length, skipped, failed, descriptors };
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async scanSeedFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.seedDir);
    } catch {
      // Missing/unreadable seed dir is the common no-op case.
      return [];
    }
    return entries
      .filter(entry => path.extname(entry).toLowerCase() === SEED_FILE_EXTENSION)
      .map(entry => path.join(this.seedDir, entry))
      .sort((a, b) => a.localeCompare(b));
  }

  private async processSeedFile(file: string): Promise<IntegrationDescriptorRecord | null> {
    const raw = await fs.readFile(file, 'utf8');
    const seed: unknown = JSON.parse(raw);
    const provider = readString(seed, 'provider');
    if (!provider) {
      throw new Error('descriptor seed is missing a string "provider"');
    }
    if (RESERVED_PROVIDER_IDS.has(provider)) {
      SecurityMonitor.logSecurityEvent({
        type: 'INTEGRATION_SECURITY_DECISION',
        severity: 'MEDIUM',
        source: 'IntegrationDescriptorSeedLoader.processSeedFile',
        details: `Integration descriptor seed denied_reserved for provider ${safeIntegrationAuditProvider(provider)}`,
      });
      logger.warn(`[IntegrationDescriptorSeedLoader] Skipping reserved provider id '${safeIntegrationAuditProvider(provider)}'`, {
        file: path.basename(file),
      });
      return null;
    }

    const curated = await this.descriptorStore.findCuratedByProvider(
      provider as UserIntegrationProvider,
    );
    const seedRevision = readSeedRevision(seed);
    const enabled = readSeedEnabled(seed);
    if (!enabled) {
      if (seedRevision === null) {
        throw new Error("disabled descriptor seed requires a positive integer 'revision'");
      }
      const disabled = await this.reconcileWithBusyRetry({
        provider: provider as UserIntegrationProvider,
        seedRevision,
        enabled: false,
        updatedAt: this.now(),
      });
      const outcome = disabled.enabled ? 'ignored stale disable for' : 'globally disabled';
      SecurityMonitor.logSecurityEvent({
        type: 'INTEGRATION_SECURITY_DECISION',
        severity: 'MEDIUM',
        source: 'IntegrationDescriptorSeedLoader.processSeedFile',
        details: `Curated integration ${outcome} provider ${safeIntegrationAuditProvider(provider)}`,
      });
      logger.info(`[IntegrationDescriptorSeedLoader] Curated provider '${safeIntegrationAuditProvider(provider)}' disable directive processed`, {
        seedRevision: disabled.seedRevision,
        applied: disabled.applied,
        enabled: disabled.enabled,
      });
      return null;
    }
    const retainsRevision = retainsCurrentSeedRevision(curated, seedRevision);
    const prepared = retainsRevision
      ? this.toRetainedRevisionInput(provider, curated)
      : this.toDescriptorInput(seed, provider, curated);
    if (!prepared) {
      // Deployment credentials are replica-local. A replica that lacks them
      // must not withdraw shared descriptors or user credentials that another
      // healthy replica is serving.
      SecurityMonitor.logSecurityEvent({
        type: 'INTEGRATION_SECURITY_DECISION',
        severity: 'MEDIUM',
        source: 'IntegrationDescriptorSeedLoader.processSeedFile',
        details: `Curated integration unavailable on this replica for provider ${safeIntegrationAuditProvider(provider)}`,
      });
      logger.warn(`[IntegrationDescriptorSeedLoader] Curated provider '${safeIntegrationAuditProvider(provider)}' is unavailable on this replica because deployment credentials are absent`, {
        descriptorPresent: curated !== null,
      });
      return null;
    }

    const { input, upsertOptions } = prepared;
    validateIntegrationDescriptorInput(input);
    let record: IntegrationDescriptorRecord | null;
    try {
      const reconciled = await this.reconcileWithBusyRetry({
        provider: input.provider,
        seedRevision,
        enabled: true,
        descriptor: input,
        upsertOptions,
        updatedAt: input.updatedAt,
      });
      record = reconciled.descriptor;
    } catch (error) {
      if (error instanceof IntegrationDescriptorMutationBusyError) {
        SecurityMonitor.logSecurityEvent({
          type: 'INTEGRATION_SECURITY_DECISION',
          severity: 'MEDIUM',
          source: 'IntegrationDescriptorSeedLoader.processSeedFile',
          details: `Curated integration descriptor mutation remained busy for provider ${safeIntegrationAuditProvider(provider)}`,
        });
      }
      throw error;
    }
    if (!record) {
      logger.warn(`[IntegrationDescriptorSeedLoader] Ignored stale enable seed for globally disabled provider '${safeIntegrationAuditProvider(provider)}'`, {
        seedRevision,
      });
      return null;
    }
    if (retainsRevision) {
      auditRetainedSeedRevision(provider, seedRevision, curated.curatedSeedRevision as number);
    }
    SecurityMonitor.logSecurityEvent({
      type: 'INTEGRATION_SECURITY_DECISION',
      severity: 'LOW',
      source: 'IntegrationDescriptorSeedLoader.processSeedFile',
      details: `Curated integration descriptor loaded for provider ${safeIntegrationAuditProvider(provider)}`,
    });
    logger.debug(`[IntegrationDescriptorSeedLoader] Loaded curated descriptor '${safeIntegrationAuditProvider(provider)}'`, {
      file: path.basename(file),
      authStrategy: input.authStrategy,
    });
    return record;
  }

  private toRetainedRevisionInput(
    provider: string,
    existing: IntegrationDescriptorRecord,
  ): PreparedDescriptorInput | null {
    if (existing.authStrategy !== 'oauth2_authorization_code' || !existing.oauth) {
      return { input: descriptorRecordAsInput(existing, this.now()) };
    }
    const credentials = this.resolveCredentials(provider);
    if (!credentials.clientId || !credentials.clientSecret) return null;
    const encryptedSecret = this.resolveClientSecret(provider, credentials.clientSecret, existing);
    const sameClientId = credentials.clientId === existing.oauth.clientId;
    const sameLogicalSecret = existing.clientSecretRevision !== null
      ? encryptedSecret.revision === existing.clientSecretRevision
      : encryptedSecret.initializeRevision;
    if (!sameClientId || !sameLogicalSecret) {
      throw new Error(
        `curated provider '${provider}' changes deployment OAuth credentials without a newer explicit seed revision`,
      );
    }
    return {
      input: {
        ...descriptorRecordAsInput(existing, this.now()),
        oauth: existing.oauth,
        clientSecretCiphertext: existing.clientSecretRevision === null
          ? existing.clientSecretCiphertext
          : encryptedSecret.ciphertext,
        clientSecretRevision: existing.clientSecretRevision,
        credentialKeyVersion: existing.clientSecretRevision === null
          ? existing.credentialKeyVersion
          : encryptedSecret.keyVersion,
      },
      upsertOptions: { refreshDeploymentCredentialsAtRetainedSeedRevision: true },
    };
  }

  private async reconcileWithBusyRetry(
    directive: CuratedIntegrationSeedDirective,
  ): ReturnType<IIntegrationDescriptorStore['reconcileCuratedSeed']> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.descriptorStore.reconcileCuratedSeed(directive);
      } catch (error) {
        if (!(error instanceof IntegrationDescriptorMutationBusyError)) throw error;
        const delay = SEED_BUSY_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw error;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Assemble a curated descriptor input from a seed object, injecting deployment
   * credentials. Returns null when the descriptor is intentionally skipped (e.g.
   * an OAuth provider whose deployment credentials are not configured). Shape
   * errors are left for `validateIntegrationDescriptorInput` to reject.
   */
  private toDescriptorInput(
    seed: unknown,
    provider: string,
    existing: IntegrationDescriptorRecord | null,
  ): PreparedDescriptorInput | null {
    const timestamp = this.now();
    const authStrategy = readString(seed, 'authStrategy') ?? '';
    const base = {
      provider: provider as UserIntegrationProvider,
      // Curated seeds are deployment-owned; ownership is forced, never read from the file.
      ownership: 'curated' as const,
      ownerUserId: null,
      displayName: readString(seed, 'displayName') ?? '',
      category: readString(seed, 'category') ?? '',
      apiHosts: canonicalizeIntegrationApiHosts(readStringArray(seed, 'apiHosts')),
      operationPromotion: readRecord(seed, 'operationPromotion'),
      curatedSeedRevision: readSeedRevision(seed),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    if (authStrategy === 'oauth2_authorization_code') {
      const credentials = this.resolveCredentials(provider);
      if (!credentials.clientId || !credentials.clientSecret) {
        logger.info(
          `[IntegrationDescriptorSeedLoader] Skipping curated OAuth provider '${safeIntegrationAuditProvider(provider)}' — deployment credentials not configured`,
        );
        return null;
      }
      const oauthSeed = readRecord(seed, 'oauth');
      const encryptedSecret = this.resolveClientSecret(
        provider,
        credentials.clientSecret,
        existing,
      );
      return {
        input: {
          ...base,
          authStrategy: 'oauth2_authorization_code',
          oauth: {
            // clientId is deployment identity (env), never the data file.
            clientId: credentials.clientId,
            authorizationUrl: readStringField(oauthSeed, 'authorizationUrl'),
            tokenUrl: readStringField(oauthSeed, 'tokenUrl'),
            scopes: readStringArrayField(oauthSeed, 'scopes'),
            pkce: readStringField(oauthSeed, 'pkce') as IntegrationPkceMode,
            refresh: readStringField(oauthSeed, 'refresh') as IntegrationRefreshMode,
            tokenExchange: readRecord(oauthSeed, 'tokenExchange'),
            accountLabel: readRecord(oauthSeed, 'accountLabel'),
          },
          clientSecretCiphertext: encryptedSecret.ciphertext,
          clientSecretRevision: encryptedSecret.revision,
          credentialKeyVersion: encryptedSecret.keyVersion,
        },
        ...(encryptedSecret.initializeRevision
          ? { upsertOptions: { initializeClientSecretRevision: true } }
          : {}),
      };
    }

    if (authStrategy === 'static_api_key') {
      const staticSeed = readRecord(seed, 'staticApiKey');
      const injection = readRecord(staticSeed, 'injection');
      return {
        input: {
          ...base,
          authStrategy: 'static_api_key',
          staticApiKey: {
            injection: {
              location: readStringField(injection, 'location') as 'header' | 'query',
              name: readStringField(injection, 'name'),
              valuePrefix: readNullableStringField(injection, 'valuePrefix'),
            },
          },
        },
      };
    }

    // Unknown/coded strategies are assembled as-is and rejected by validation if invalid.
    return {
      input: {
        ...base,
        authStrategy: authStrategy as IntegrationDescriptorCreateInput['authStrategy'],
      },
    };
  }

  private resolveClientSecret(
    provider: string,
    configuredSecret: string,
    existing: IntegrationDescriptorRecord | null,
  ): {
    readonly ciphertext: Buffer;
    readonly revision: string;
    readonly keyVersion: string | null;
    readonly initializeRevision: boolean;
  } {
    const context = integrationDescriptorClientSecretContext({ provider, ownerUserId: null });
    const revision = deriveIntegrationClientSecretRevision(
      this.secretRevisionHasher,
      provider,
      configuredSecret,
    );
    const configuredPlaintext = Buffer.from(configuredSecret, 'utf8');
    try {
      if (existing?.authStrategy === 'oauth2_authorization_code'
          && existing.clientSecretCiphertext) {
        let existingPlaintext: Buffer | null = null;
        try {
          existingPlaintext = this.secretEncryption.decrypt(existing.clientSecretCiphertext, context);
        } catch {
          // A retired or unavailable at-rest key makes the old envelope
          // unreadable. Rewrap the deployment credential, but retain the
          // logical revision: envelope rotation is not an OAuth secret change.
          SecurityMonitor.logSecurityEvent({
            type: 'INTEGRATION_SECURITY_DECISION',
            severity: 'MEDIUM',
            source: 'IntegrationDescriptorSeedLoader.resolveClientSecret',
            details: `Curated integration client secret rewrapped for provider ${safeIntegrationAuditProvider(provider)}`,
          });
          logger.warn(`[IntegrationDescriptorSeedLoader] Rewrapped unreadable client-secret envelope for provider '${safeIntegrationAuditProvider(provider)}'`);
          return {
            ciphertext: this.secretEncryption.encrypt(configuredPlaintext, context),
            revision,
            keyVersion: null,
            initializeRevision: false,
          };
        }
        try {
          if (existingPlaintext.length === configuredPlaintext.length
              && timingSafeEqual(existingPlaintext, configuredPlaintext)) {
            return {
              ciphertext: Buffer.from(existing.clientSecretCiphertext),
              // The opaque-value HMAC key has its own lifecycle. Once plaintext
              // equality is proven, preserve the logical secret revision so an
              // unrelated HMAC-key rotation cannot revoke user integrations.
              revision: existing.clientSecretRevision ?? revision,
              keyVersion: existing.credentialKeyVersion,
              initializeRevision: existing.clientSecretRevision === null,
            };
          }
        } finally {
          existingPlaintext?.fill(0);
        }

        return {
          ciphertext: this.secretEncryption.encrypt(configuredPlaintext, context),
          revision,
          keyVersion: null,
          initializeRevision: false,
        };
      }

      return {
        ciphertext: this.secretEncryption.encrypt(configuredPlaintext, context),
        revision,
        keyVersion: null,
        initializeRevision: false,
      };
    } finally {
      configuredPlaintext.fill(0);
    }
  }
}

function descriptorRecordAsInput(
  record: IntegrationDescriptorRecord,
  updatedAt: Date,
): IntegrationDescriptorCreateInput {
  return {
    provider: record.provider,
    ownership: record.ownership,
    ownerUserId: record.ownerUserId,
    displayName: record.displayName,
    category: record.category,
    authStrategy: record.authStrategy,
    apiHosts: [...record.apiHosts],
    oauth: record.oauth,
    staticApiKey: record.staticApiKey,
    clientSecretCiphertext: record.clientSecretCiphertext,
    clientSecretRevision: record.clientSecretRevision,
    credentialKeyVersion: record.credentialKeyVersion,
    curatedSeedRevision: record.curatedSeedRevision ?? null,
    operationPromotion: record.operationPromotion,
    createdAt: record.createdAt,
    updatedAt,
  };
}

// ── seed-object readers (defensive; validation does the real enforcement) ──

function readRecord(value: unknown, key: string): Readonly<Record<string, unknown>> {
  const record = asRecord(value)[key];
  return asRecord(record);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown, key: string): string | null {
  const field = asRecord(value)[key];
  return typeof field === 'string' ? field : null;
}

function readSeedRevision(value: unknown): number | null {
  const revision = asRecord(value).revision;
  if (revision === undefined || revision === null) return null;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1 || (revision as number) > 2_147_483_647) {
    throw new Error("descriptor seed field 'revision' must be a positive 32-bit integer");
  }
  return revision as number;
}

function readSeedEnabled(value: unknown): boolean {
  const enabled = asRecord(value).enabled;
  if (enabled === undefined) return true;
  if (typeof enabled !== 'boolean') {
    throw new Error("descriptor seed field 'enabled' must be a boolean");
  }
  return enabled;
}

function retainsCurrentSeedRevision(
  current: IntegrationDescriptorRecord | null,
  proposedRevision: number | null,
): current is IntegrationDescriptorRecord {
  const currentRevision = current?.curatedSeedRevision ?? null;
  return current !== null
    && currentRevision !== null
    && (proposedRevision === null || proposedRevision <= currentRevision);
}

function auditRetainedSeedRevision(
  provider: string,
  proposedRevision: number | null,
  currentRevision: number,
): void {
  SecurityMonitor.logSecurityEvent({
    type: 'INTEGRATION_SECURITY_DECISION',
    severity: 'MEDIUM',
    source: 'IntegrationDescriptorSeedLoader.processSeedFile',
    details: `Curated integration descriptor retained newer revision for provider ${safeIntegrationAuditProvider(provider)}`,
  });
  logger.warn(`[IntegrationDescriptorSeedLoader] Ignored stale descriptor seed for '${safeIntegrationAuditProvider(provider)}'`, {
    proposedRevision,
    currentRevision,
  });
}

function readStringField(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field : '';
}

function readNullableStringField(value: Readonly<Record<string, unknown>>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

function readStringArray(value: unknown, key: string): readonly string[] {
  return readStringArrayField(asRecord(value), key);
}

function readStringArrayField(value: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const field = value[key];
  if (!Array.isArray(field)) return [];
  if (field.some(entry => typeof entry !== 'string')) {
    throw new Error(`descriptor seed field '${key}' must contain only strings`);
  }
  return field as string[];
}
