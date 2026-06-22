/**
 * configToDatabase
 *
 * One-shot migration: legacy `~/.dollhouse/config.yml` + JWKS keyfile +
 * cookie-secret keyfile → the Phase 4.5 DB-backed stores. Runs on first
 * DB-mode startup when a legacy filesystem state is detected, OR via the
 * operator CLI `scripts/migrate-config-to-database.ts`.
 *
 * **Idempotence:** marker file `<configRoot>/.migrated-to-db` records
 * completion. The migration short-circuits when present.
 *
 * **Failure mode:** any error inside the migration throws — the caller
 * (Container.preparePortfolio in DB mode) halts startup with the error
 * surfaced to the operator. Half-migrated state never reaches consumers.
 *
 * **JWKS preservation:** when the legacy keyfile contains a valid
 * keypair, it's rotated into the store with its original `kid`. This
 * preserves currently-issued tokens — operators get a clean cutover
 * without surprise re-auth. Cookie secret is similar (preserves the
 * existing bytes under a new opaque kid).
 *
 * @module storage/migration/configToDatabase
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { logger } from '../../utils/logger.js';
import type { IOperatorConfigStore, OperatorConfig } from '../operatorConfig/IOperatorConfigStore.js';
import type { IUserConfigStore, UserConfig } from '../userConfig/IUserConfigStore.js';
import type { ISigningKeyStore } from '../signingKeys/ISigningKeyStore.js';

const MARKER_FILENAME = '.migrated-to-db';
const MARKER_VERSION = 1;

export interface MigrationOptions {
  operatorStore: IOperatorConfigStore;
  userStore: IUserConfigStore;
  signingKeyStore: ISigningKeyStore;
  /**
   * UUID of the user who owns the per-user config slice. In DB mode
   * this should be the bootstrapped OS-user (`BootstrappedUserId` from
   * the DI container). The migration writes the entire `~/.dollhouse/config.yml`
   * `user.*` + sync/autoload/etc. sections under this userId.
   */
  userId: string;
  /** Override the legacy config root for testing. Defaults to `~/.dollhouse`. */
  legacyConfigRoot?: string;
  /** Override the legacy run dir (where keyfiles live). Defaults to `<configRoot>/run`. */
  legacyRunRoot?: string;
  /** When true, plan but don't write. Used by the CLI's `preview` mode. */
  dryRun?: boolean;
}

export interface MigrationResult {
  status: 'skipped-already-migrated' | 'skipped-no-legacy-state' | 'migrated' | 'preview';
  configMigrated: boolean;
  jwksMigrated: boolean;
  cookieSecretMigrated: boolean;
  /** Filesystem path of the marker file written (or that would be written in dry-run). */
  markerPath: string;
  /** Detailed plan for preview mode (also populated on actual migration). */
  plan: {
    configYamlPath: string;
    configYamlExists: boolean;
    jwksKeyPath: string;
    jwksKeyExists: boolean;
    cookieSecretPath: string;
    cookieSecretExists: boolean;
    operatorSectionsToWrite: string[];
    userSectionsToWrite: string[];
    userId: string;
  };
}

type MigrationPlan = MigrationResult['plan'];

interface MigrationPaths {
  configRoot: string;
  configYamlPath: string;
  jwksKeyPath: string;
  cookieSecretPath: string;
  markerPath: string;
}

interface PlannedMigration {
  plan: MigrationPlan;
  operatorPayload: Omit<OperatorConfig, 'updatedAt'>;
  userPayload: Omit<UserConfig, 'updatedAt'>;
}

/**
 * Read the marker file (if present) and return its contents. Returns
 * null when the marker is absent. Used by `runMigration()` to decide
 * idempotently whether to proceed, and by the `status` CLI subcommand.
 */
export async function readMarker(configRoot?: string): Promise<{ migratedAt: number; version: number } | null> {
  const root = configRoot ?? path.join(os.homedir(), '.dollhouse');
  try {
    const raw = await fs.readFile(path.join(root, MARKER_FILENAME), 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null
      && typeof parsed.migratedAt === 'number'
      && typeof parsed.version === 'number') {
      return parsed;
    }
    logger.warn('[configToDatabase] marker file has unexpected shape; treating as not-migrated', { raw });
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Run the migration. Idempotent — short-circuits if the marker file
 * already exists. Throws on any per-section failure so the caller can
 * halt cleanly; partial state never reaches consumers.
 */
export async function runConfigToDatabaseMigration(
  options: MigrationOptions,
): Promise<MigrationResult> {
  const paths = resolveMigrationPaths(options);

  // 1. Idempotence check
  const existingMarker = await readMarker(paths.configRoot);
  if (existingMarker && !options.dryRun) {
    return buildSkippedResult('skipped-already-migrated', paths, options.userId);
  }

  const planned = await planMigration(paths, options.userId);
  const { plan } = planned;
  if (!hasLegacyState(plan)) return buildSkippedResult('skipped-no-legacy-state', paths, options.userId, plan);

  if (options.dryRun) {
    return buildResult({
      status: 'preview',
      configMigrated: plan.configYamlExists,
      jwksMigrated: plan.jwksKeyExists,
      cookieSecretMigrated: plan.cookieSecretExists,
      markerPath: paths.markerPath,
      plan,
    });
  }

  // 4. Execute writes — config first (idempotent upsert), keys second.
  await migrateConfigYaml(options, planned);
  await migrateJwksKeyfile(options.signingKeyStore, paths.jwksKeyPath, plan.jwksKeyExists);
  await migrateCookieSecret(options.signingKeyStore, paths.cookieSecretPath, plan.cookieSecretExists);

  // 7. Write marker
  await writeMigrationMarker(paths.markerPath, plan);

  logger.info('[configToDatabase] migration complete', {
    markerPath: paths.markerPath,
    configMigrated: plan.configYamlExists,
    jwksMigrated: plan.jwksKeyExists,
    cookieSecretMigrated: plan.cookieSecretExists,
  });

  return buildResult({
    status: 'migrated',
    configMigrated: plan.configYamlExists,
    jwksMigrated: plan.jwksKeyExists,
    cookieSecretMigrated: plan.cookieSecretExists,
    markerPath: paths.markerPath,
    plan,
  });
}

function resolveMigrationPaths(options: MigrationOptions): MigrationPaths {
  const configRoot = options.legacyConfigRoot ?? path.join(os.homedir(), '.dollhouse');
  const runRoot = options.legacyRunRoot ?? path.join(configRoot, 'run');
  return {
    configRoot,
    configYamlPath: path.join(configRoot, 'config.yml'),
    jwksKeyPath: path.join(runRoot, 'oauth-signing-key.json'),
    cookieSecretPath: path.join(runRoot, 'cookie-signing-secret.bin'),
    markerPath: path.join(configRoot, MARKER_FILENAME),
  };
}

function buildSkippedResult(
  status: 'skipped-already-migrated' | 'skipped-no-legacy-state',
  paths: MigrationPaths,
  userId: string,
  plan?: MigrationPlan,
): MigrationResult {
  return buildResult({
    status,
    configMigrated: false,
    jwksMigrated: false,
    cookieSecretMigrated: false,
    markerPath: paths.markerPath,
    plan: plan ?? emptyPlan(paths, userId),
  });
}

function emptyPlan(paths: MigrationPaths, userId: string): MigrationPlan {
  return {
    configYamlPath: paths.configYamlPath,
    configYamlExists: false,
    jwksKeyPath: paths.jwksKeyPath,
    jwksKeyExists: false,
    cookieSecretPath: paths.cookieSecretPath,
    cookieSecretExists: false,
    operatorSectionsToWrite: [],
    userSectionsToWrite: [],
    userId,
  };
}

async function planMigration(paths: MigrationPaths, userId: string): Promise<PlannedMigration> {
  const [configYamlExists, jwksKeyExists, cookieSecretExists] = await Promise.all([
    fileExists(paths.configYamlPath),
    fileExists(paths.jwksKeyPath),
    fileExists(paths.cookieSecretPath),
  ]);
  const parsedConfig = configYamlExists ? await loadLegacyConfig(paths.configYamlPath) : {};
  const { operatorPayload, userPayload, operatorSections, userSections } = splitLegacyConfig(parsedConfig);

  return {
    operatorPayload,
    userPayload,
    plan: {
      configYamlPath: paths.configYamlPath,
      configYamlExists,
      jwksKeyPath: paths.jwksKeyPath,
      jwksKeyExists,
      cookieSecretPath: paths.cookieSecretPath,
      cookieSecretExists,
      operatorSectionsToWrite: operatorSections,
      userSectionsToWrite: userSections,
      userId,
    },
  };
}

function hasLegacyState(plan: MigrationPlan): boolean {
  return plan.configYamlExists || plan.jwksKeyExists || plan.cookieSecretExists;
}

async function loadLegacyConfig(configYamlPath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(configYamlPath, 'utf-8');
  const parsed = yaml.load(raw, { schema: yaml.FAILSAFE_SCHEMA });
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Legacy config at ${configYamlPath} is not a valid YAML object`);
  }
  return parsed as Record<string, unknown>;
}

async function migrateConfigYaml(options: MigrationOptions, planned: PlannedMigration): Promise<void> {
  if (!planned.plan.configYamlExists) return;

  await options.operatorStore.save(planned.operatorPayload);
  await options.userStore.save(options.userId, planned.userPayload);
  logger.info('[configToDatabase] migrated config.yml', {
    operatorSections: planned.plan.operatorSectionsToWrite.length,
    userSections: planned.plan.userSectionsToWrite.length,
    userId: options.userId,
  });
}

async function migrateJwksKeyfile(
  signingKeyStore: ISigningKeyStore,
  jwksKeyPath: string,
  jwksKeyExists: boolean,
): Promise<void> {
  if (!jwksKeyExists) return;

  const existingActive = await signingKeyStore.getActive('jwks');
  if (existingActive) {
    logger.info('[configToDatabase] active JWKS already in store; skipping keyfile import', {
      existingKid: existingActive.kid,
    });
    return;
  }

  const raw = await fs.readFile(jwksKeyPath, 'utf-8');
  const parsed = JSON.parse(raw) as { kid?: string; privateKey?: unknown; publicKey?: unknown; generatedAt?: string };
  if (typeof parsed.kid !== 'string' || !parsed.privateKey || !parsed.publicKey) {
    throw new Error(`Legacy JWKS keyfile at ${jwksKeyPath} is malformed (missing kid / privateKey / publicKey)`);
  }
  await signingKeyStore.rotate({
    kid: parsed.kid,
    kind: 'jwks',
    payload: parsed as unknown as Record<string, unknown>,
  });
  logger.info('[configToDatabase] migrated JWKS keyfile', { kid: parsed.kid });
}

async function migrateCookieSecret(
  signingKeyStore: ISigningKeyStore,
  cookieSecretPath: string,
  cookieSecretExists: boolean,
): Promise<void> {
  if (!cookieSecretExists) return;

  const existingActive = await signingKeyStore.getActive('cookie');
  if (existingActive) {
    logger.info('[configToDatabase] active cookie key already in store; skipping keyfile import');
    return;
  }

  const buf = await fs.readFile(cookieSecretPath);
  if (buf.length < 32) {
    throw new Error(`Legacy cookie-signing-secret.bin at ${cookieSecretPath} is shorter than 32 bytes (${buf.length})`);
  }
  const { randomUUID } = await import('node:crypto');
  await signingKeyStore.rotate({
    kid: `cookie-migrated-${randomUUID()}`,
    kind: 'cookie',
    payload: { secret: buf.toString('base64'), length: buf.length },
  });
  logger.info('[configToDatabase] migrated cookie secret', { bytes: buf.length });
}

async function writeMigrationMarker(markerPath: string, plan: MigrationPlan): Promise<void> {
  const marker = {
    migratedAt: Date.now(),
    version: MARKER_VERSION,
    fromConfig: plan.configYamlExists,
    fromJwks: plan.jwksKeyExists,
    fromCookieSecret: plan.cookieSecretExists,
  };
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), { mode: 0o600 });
}

/**
 * Split a parsed legacy config.yml into per-host (operator) and per-user
 * payloads. Mirrors the per-user / per-host classification used in
 * ConfigManager.splitForStores, but operates on the raw YAML object
 * shape (the legacy file format) rather than the in-memory DollhouseConfig.
 */
function splitLegacyConfig(legacy: Record<string, unknown>): {
  operatorPayload: Omit<OperatorConfig, 'updatedAt'>;
  userPayload: Omit<UserConfig, 'updatedAt'>;
  operatorSections: string[];
  userSections: string[];
} {
  const operatorSections: string[] = [];
  const userSections: string[] = [];

  // Operator (per-host)
  const elementsRaw = (legacy.elements as Record<string, unknown> | undefined) ?? {};
  const enhancedIndexConfig = (elementsRaw.enhanced_index as Record<string, unknown> | undefined) ?? {};
  const consoleConfig = (legacy.console as Record<string, unknown> | undefined) ?? {};
  const licenseConfig = (legacy.license as Record<string, unknown> | undefined) ?? {};
  const defaultsConfig: Record<string, unknown> = {};
  if (legacy.version !== undefined) defaultsConfig.version = legacy.version;
  if (elementsRaw.default_element_dir !== undefined) defaultsConfig.default_element_dir = elementsRaw.default_element_dir;

  if (Object.keys(enhancedIndexConfig).length > 0) operatorSections.push('elements.enhanced_index');
  if (Object.keys(consoleConfig).length > 0) operatorSections.push('console');
  if (Object.keys(licenseConfig).length > 0) operatorSections.push('license');
  if (Object.keys(defaultsConfig).length > 0) operatorSections.push('version+defaults');

  const operatorPayload: Omit<OperatorConfig, 'updatedAt'> = {
    enhancedIndexConfig, consoleConfig, licenseConfig, defaultsConfig, configVersion: 1,
  };

  // User (per-user)
  const userIdentityConfig = (legacy.user as Record<string, unknown> | undefined) ?? {};
  const githubConfig = (legacy.github as Record<string, unknown> | undefined) ?? {};
  const syncConfig = (legacy.sync as Record<string, unknown> | undefined) ?? {};
  const autoloadConfig = (legacy.autoLoad as Record<string, unknown> | undefined) ?? {};
  const retentionConfig = (legacy.retentionPolicy as Record<string, unknown> | undefined) ?? {};
  const wizardConfig = (legacy.wizard as Record<string, unknown> | undefined) ?? {};
  const displayConfig = (legacy.display as Record<string, unknown> | undefined) ?? {};
  const collectionConfig = (legacy.collection as Record<string, unknown> | undefined) ?? {};
  const autoActivateConfig = (elementsRaw.auto_activate as Record<string, unknown> | undefined) ?? {};
  const sourcePriorityConfig = (legacy.source_priority as Record<string, unknown> | undefined) ?? {};

  for (const [name, obj] of Object.entries({
    user: userIdentityConfig, github: githubConfig, sync: syncConfig, autoLoad: autoloadConfig,
    retentionPolicy: retentionConfig, wizard: wizardConfig, display: displayConfig,
    collection: collectionConfig, 'elements.auto_activate': autoActivateConfig,
    source_priority: sourcePriorityConfig,
  })) {
    if (Object.keys(obj).length > 0) userSections.push(name);
  }

  const userPayload: Omit<UserConfig, 'updatedAt'> = {
    githubConfig, syncConfig, autoloadConfig, retentionConfig, wizardConfig,
    displayConfig, collectionConfig, autoActivateConfig, sourcePriorityConfig,
    userIdentityConfig, configVersion: 1,
  };

  return { operatorPayload, userPayload, operatorSections, userSections };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function buildResult(r: MigrationResult): MigrationResult {
  return r;
}
