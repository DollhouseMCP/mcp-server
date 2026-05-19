/**
 * PostgresOperatorConfigStore
 *
 * Database-backed `IOperatorConfigStore` using Drizzle against the
 * `operator_settings` singleton table (migration 0012). All operations
 * run inside `withSystemContext` — operator config is system-level
 * state, not per-user tenant data, so RLS context is cleared.
 *
 * Atomicity: `save()` issues a single `INSERT ... ON CONFLICT (id) DO
 * UPDATE` statement. Two concurrent writers cannot create duplicate
 * rows (the singleton constraint plus the conflict target serializes
 * them at the database level).
 *
 * @module storage/operatorConfig/PostgresOperatorConfigStore
 */

import { eq } from 'drizzle-orm';

import type { DatabaseInstance } from '../../database/connection.js';
import { withSystemContext } from '../../database/admin.js';
import { operatorSettings } from '../../database/schema/index.js';
import type { IOperatorConfigStore, OperatorConfig } from './IOperatorConfigStore.js';
import { DEFAULT_OPERATOR_CONFIG } from './IOperatorConfigStore.js';

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
    const rows = await withSystemContext(this.db, (tx) =>
      tx.select().from(operatorSettings).where(eq(operatorSettings.id, 1)).limit(1),
    );
    if (rows.length === 0) return cloneDefault();
    return rowToConfig(rows[0] as OperatorSettingsRow);
  }

  async save(config: Omit<OperatorConfig, 'updatedAt'> & { updatedAt?: number }): Promise<void> {
    const now = new Date();
    const writeRow = {
      id: 1,
      enhancedIndexConfig: config.enhancedIndexConfig,
      consoleConfig: config.consoleConfig,
      licenseConfig: config.licenseConfig,
      defaultsConfig: config.defaultsConfig,
      configVersion: config.configVersion,
      updatedAt: now,
    };

    await withSystemContext(this.db, async (tx) => {
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
    });
  }
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
