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

import { randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { SecurityMonitor } from '../../../security/securityMonitor.js';
import { logger } from '../../../utils/logger.js';
import { canonicalizeIntegrationApiHosts } from '../../security/IntegrationApiHosts.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import {
  type IIntegrationDescriptorStore,
  type IntegrationDescriptorCreateInput,
  type IntegrationDescriptorRecord,
  type IntegrationPkceMode,
  type IntegrationRefreshMode,
  validateIntegrationDescriptorInput,
} from '../../stores/IIntegrationDescriptorStore.js';
import type { IUserIntegrationStore, UserIntegrationProvider } from '../../stores/IUserIntegrationStore.js';
import { integrationDescriptorClientSecretContext } from './IntegrationSecretContext.js';
import { safeIntegrationAuditProvider } from './IntegrationSecurityAudit.js';

const SEED_FILE_EXTENSION = '.json';

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

  constructor(
    private readonly seedDir: string,
    private readonly descriptorStore: IIntegrationDescriptorStore,
    private readonly secretEncryption: ISecretEncryptionService,
    private readonly resolveCredentials: IntegrationDescriptorSeedCredentialResolver,
    options: IntegrationDescriptorSeedLoaderOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.integrationStore = options.integrationStore;
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
    const input = this.toDescriptorInput(seed, provider, curated);
    if (!input) {
      // Provider ids are shared by curated and user-owned descriptors. Curated
      // records win runtime resolution, so their active provider credentials
      // must be revoked before removal or they could become usable under a
      // newly revealed same-name BYO route. Without a persisted curated record,
      // however, the credentials belong to the BYO route and stay untouched.
      if (!curated) return null;

      const revoked = await this.integrationStore.revokeAllByDescriptor(
        curated.id,
        this.now(),
      );
      const removed = await this.descriptorStore.deleteCurated(curated.provider);
      if (!removed) {
        throw new Error('curated integration descriptor disappeared during credential withdrawal');
      }
      SecurityMonitor.logSecurityEvent({
        type: 'INTEGRATION_SECURITY_DECISION',
        severity: 'MEDIUM',
        source: 'IntegrationDescriptorSeedLoader.processSeedFile',
        details: `Curated integration disabled for provider ${safeIntegrationAuditProvider(curated.provider)}`,
      });
      logger.info(`[IntegrationDescriptorSeedLoader] Disabled curated provider '${safeIntegrationAuditProvider(curated.provider)}' because deployment credentials are unavailable`, {
        revokedIntegrations: revoked,
      });
      return null;
    }

    validateIntegrationDescriptorInput(input);
    const record = await this.descriptorStore.upsert(input);
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
  ): IntegrationDescriptorCreateInput | null {
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
      };
    }

    if (authStrategy === 'static_api_key') {
      const staticSeed = readRecord(seed, 'staticApiKey');
      const injection = readRecord(staticSeed, 'injection');
      return {
        ...base,
        authStrategy: 'static_api_key',
        staticApiKey: {
          injection: {
            location: readStringField(injection, 'location') as 'header' | 'query',
            name: readStringField(injection, 'name'),
            valuePrefix: readNullableStringField(injection, 'valuePrefix'),
          },
        },
      };
    }

    // Unknown/coded strategies are assembled as-is and rejected by validation if invalid.
    return { ...base, authStrategy: authStrategy as IntegrationDescriptorCreateInput['authStrategy'] };
  }

  private resolveClientSecret(
    provider: string,
    configuredSecret: string,
    existing: IntegrationDescriptorRecord | null,
  ): {
    readonly ciphertext: Buffer;
    readonly revision: string | null;
    readonly keyVersion: string | null;
  } {
    const context = integrationDescriptorClientSecretContext({ provider, ownerUserId: null });
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
            revision: existing.clientSecretRevision,
            keyVersion: null,
          };
        }
        try {
          if (existingPlaintext.length === configuredPlaintext.length
              && timingSafeEqual(existingPlaintext, configuredPlaintext)) {
            return {
              ciphertext: Buffer.from(existing.clientSecretCiphertext),
              revision: existing.clientSecretRevision,
              keyVersion: existing.credentialKeyVersion,
            };
          }
        } finally {
          existingPlaintext?.fill(0);
        }

        return {
          ciphertext: this.secretEncryption.encrypt(configuredPlaintext, context),
          revision: randomUUID(),
          keyVersion: null,
        };
      }

      return {
        ciphertext: this.secretEncryption.encrypt(configuredPlaintext, context),
        revision: randomUUID(),
        keyVersion: null,
      };
    } finally {
      configuredPlaintext.fill(0);
    }
  }
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
