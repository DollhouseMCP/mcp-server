/**
 * PostgresOperatorConfigStore
 *
 * Database-backed `IOperatorConfigStore` using Drizzle against the
 * `operator_settings` singleton table (migration 0012). All operations
 * run inside `withSystemContext` — operator config is system-level
 * state, not per-user tenant data, so RLS context is cleared.
 *
 * Atomicity: unconditional saves use `INSERT ... ON CONFLICT (id) DO UPDATE`.
 * Compare-and-swap saves first materialize and lock the singleton row so two
 * first writers cannot both compare against a shared synthetic default.
 *
 * @module storage/operatorConfig/PostgresOperatorConfigStore
 */

import { eq } from 'drizzle-orm';

import type { DatabaseInstance } from '../../database/connection.js';
import type { DrizzleTx } from '../../database/db-utils.js';
import { withSystemContext } from '../../database/admin.js';
import { operatorSettings } from '../../database/schema/index.js';
import type { IOperatorConfigStore, OperatorConfig } from './IOperatorConfigStore.js';
import { DEFAULT_OPERATOR_CONFIG, OperatorConfigConflictError } from './IOperatorConfigStore.js';

export interface PostgresOperatorConfigStoreOptions {
  /** Drizzle DB instance. Pass the same instance the rest of the app uses. */
  db: DatabaseInstance;
}

// The schema's jsonb columns deserialize to `unknown`; this row alias
// narrows them to the same Record shape the interface uses.
interface OperatorSettingsRow {
  id: number;
  enhancedIndexConfig: unknown;
  consoleConfig: unknown;
  licenseConfig: unknown;
  defaultsConfig: unknown;
  configVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export class PostgresOperatorConfigStore implements IOperatorConfigStore {
  private readonly db: DatabaseInstance;

  constructor(options: PostgresOperatorConfigStoreOptions) {
    this.db = options.db;
  }

  async load(): Promise<OperatorConfig> {
    return withSystemContext(this.db, loadOperatorConfigWithTx);
  }

  async save(
    config: Omit<OperatorConfig, 'updatedAt'> & { updatedAt?: number },
    options: { readonly expectedUpdatedAt?: number } = {},
  ): Promise<void> {
    await withSystemContext(this.db, tx => saveOperatorConfigWithTx(tx, config, options));
  }
}

export async function loadOperatorConfigWithTx(tx: DrizzleTx): Promise<OperatorConfig> {
  const rows = await tx.select().from(operatorSettings).where(eq(operatorSettings.id, 1)).limit(1);
  const row = rows.at(0);
  return row ? rowToConfig(row) : cloneDefault();
}

export async function saveOperatorConfigWithTx(
  tx: DrizzleTx,
  config: Omit<OperatorConfig, 'updatedAt'> & { updatedAt?: number },
  options: { readonly expectedUpdatedAt?: number } = {},
): Promise<void> {
    const expectedUpdatedAt = options.expectedUpdatedAt;
    const initialNow = new Date();
    const writeRow = {
      id: 1,
      enhancedIndexConfig: config.enhancedIndexConfig,
      consoleConfig: config.consoleConfig,
      licenseConfig: config.licenseConfig,
      defaultsConfig: config.defaultsConfig,
      configVersion: config.configVersion,
      updatedAt: initialNow,
    };

    // Materialize and lock the singleton for every write. This makes the
    // timestamp an actual revision token even for concurrent unconditional
    // writes; without the lock, two writers can publish different documents
    // with the same millisecond value and defeat a later CAS.
    await tx
      .insert(operatorSettings)
      .values({
        id: 1,
        enhancedIndexConfig: DEFAULT_OPERATOR_CONFIG.enhancedIndexConfig,
        consoleConfig: DEFAULT_OPERATOR_CONFIG.consoleConfig,
        licenseConfig: DEFAULT_OPERATOR_CONFIG.licenseConfig,
        defaultsConfig: DEFAULT_OPERATOR_CONFIG.defaultsConfig,
        configVersion: DEFAULT_OPERATOR_CONFIG.configVersion,
        updatedAt: new Date(DEFAULT_OPERATOR_CONFIG.updatedAt),
      })
      .onConflictDoNothing();
    const lockedRows = await tx
      .select({ updatedAt: operatorSettings.updatedAt })
      .from(operatorSettings)
      .where(eq(operatorSettings.id, 1))
      .for('update');
    const currentUpdatedAt = lockedRows.at(0)?.updatedAt.getTime() ?? DEFAULT_OPERATOR_CONFIG.updatedAt;
    if (expectedUpdatedAt !== undefined && currentUpdatedAt !== expectedUpdatedAt) {
      throw new OperatorConfigConflictError();
    }
    writeRow.updatedAt = new Date(Math.max(Date.now(), currentUpdatedAt + 1));
      await tx
        .insert(operatorSettings)
        .values(writeRow)
        .onConflictDoUpdate({
          target: operatorSettings.id,
          set: {
            enhancedIndexConfig: writeRow.enhancedIndexConfig,
            consoleConfig: writeRow.consoleConfig,
            licenseConfig: writeRow.licenseConfig,
            defaultsConfig: writeRow.defaultsConfig,
            configVersion: writeRow.configVersion,
            updatedAt: writeRow.updatedAt,
          },
        });
}

function cloneDefault(): OperatorConfig {
  return {
    enhancedIndexConfig: { ...DEFAULT_OPERATOR_CONFIG.enhancedIndexConfig },
    consoleConfig: { ...DEFAULT_OPERATOR_CONFIG.consoleConfig },
    licenseConfig: { ...DEFAULT_OPERATOR_CONFIG.licenseConfig },
    defaultsConfig: { ...DEFAULT_OPERATOR_CONFIG.defaultsConfig },
    configVersion: DEFAULT_OPERATOR_CONFIG.configVersion,
    updatedAt: DEFAULT_OPERATOR_CONFIG.updatedAt,
  };
}

function rowToConfig(row: OperatorSettingsRow): OperatorConfig {
  return {
    enhancedIndexConfig: coerceObject(row.enhancedIndexConfig),
    consoleConfig: coerceObject(row.consoleConfig),
    licenseConfig: coerceObject(row.licenseConfig),
    defaultsConfig: coerceObject(row.defaultsConfig),
    configVersion: row.configVersion,
    updatedAt: row.updatedAt.getTime(),
  };
}

function coerceObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  // Defensive: schema NOT NULL DEFAULT '{}'::jsonb guarantees an object,
  // but if some out-of-band write put a non-object in the column, recover.
  return {};
}
