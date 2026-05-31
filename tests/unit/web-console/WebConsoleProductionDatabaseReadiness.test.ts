import { describe, expect, it, jest } from '@jest/globals';

import type { DatabaseInstance } from '../../../src/database/connection.js';
import {
  WEB_CONSOLE_PRODUCTION_REQUIRED_TABLES,
  createPostgresProductionDatabaseReadiness,
  resolveWebConsoleProductionDatabaseVerificationFromEnv,
} from '../../../src/web-console/index.js';

const CUSTOM_REQUIRED_TABLE = 'custom_console_table';

function dbWithRows(...rows: readonly unknown[][]): DatabaseInstance {
  return {
    execute: jest.fn()
      .mockResolvedValueOnce(rows[0])
      .mockResolvedValueOnce(rows[1]),
  } as unknown as DatabaseInstance;
}

function identityRow(overrides: Partial<{ databaseName: string; currentUser: string }> = {}) {
  return {
    databaseName: 'dollhouse_prod',
    currentUser: 'dollhouse_app',
    ...overrides,
  };
}

function tableRows(missing: readonly string[] = [], tableNames = WEB_CONSOLE_PRODUCTION_REQUIRED_TABLES) {
  const missingSet = new Set(missing);
  return tableNames.filter(tableName => !missingSet.has(tableName)).map(tableName => ({
    tableName,
  }));
}

describe('PostgresProductionDatabaseReadiness', () => {
  it('is ready when database identity and required migration tables match', async () => {
    const db = dbWithRows([identityRow()], tableRows());
    const readiness = createPostgresProductionDatabaseReadiness({
      db,
      expectedDatabaseName: 'dollhouse_prod',
      expectedCurrentUser: 'dollhouse_app',
    });

    await expect(readiness.getReadiness()).resolves.toEqual({
      ready: true,
      failureCodes: [],
    });
  });

  it('reports identity and migration failures without exposing connection details', async () => {
    const db = dbWithRows(
      [identityRow({ databaseName: 'dollhouse_dev', currentUser: 'dev_user' })],
      tableRows(['console_sessions', 'security_invalidation_events']),
    );
    const readiness = createPostgresProductionDatabaseReadiness({
      db,
      expectedDatabaseName: 'dollhouse_prod',
      expectedCurrentUser: 'dollhouse_app',
    });

    await expect(readiness.getReadiness()).resolves.toEqual({
      ready: false,
      failureCodes: [
        'production_database_identity_mismatch',
        'production_database_user_mismatch',
        'production_database_migrations_incomplete',
      ],
      detail: 'database identity did not match the configured production expectation; missing required tables: console_sessions, security_invalidation_events',
    });
  });

  it('fails closed when the verification query fails', async () => {
    const db = {
      execute: jest.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as DatabaseInstance;
    const readiness = createPostgresProductionDatabaseReadiness({
      db,
      expectedDatabaseName: 'dollhouse_prod',
    });

    await expect(readiness.getReadiness()).resolves.toEqual({
      ready: false,
      failureCodes: ['production_database_check_failed'],
      detail: 'Production database readiness check failed.',
    });
  });

  it('honors a custom required table set from discovered public tables', async () => {
    const db = dbWithRows([identityRow()], tableRows([], [CUSTOM_REQUIRED_TABLE]));
    const readiness = createPostgresProductionDatabaseReadiness({
      db,
      expectedDatabaseName: 'dollhouse_prod',
      requiredTables: [CUSTOM_REQUIRED_TABLE],
    });

    await expect(readiness.getReadiness()).resolves.toEqual({
      ready: true,
      failureCodes: [],
    });
  });
});

describe('resolveWebConsoleProductionDatabaseVerificationFromEnv', () => {
  it('returns no verification config until the expected database name is configured', () => {
    expect(resolveWebConsoleProductionDatabaseVerificationFromEnv({})).toBeUndefined();
    expect(resolveWebConsoleProductionDatabaseVerificationFromEnv({
      DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_USER: 'dollhouse_admin',
    })).toBeUndefined();
  });

  it('derives database identity verification from typed deployment env', () => {
    expect(resolveWebConsoleProductionDatabaseVerificationFromEnv({
      DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_NAME: 'dollhouse_prod',
      DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_USER: 'dollhouse_admin',
    })).toEqual({
      expectedDatabaseName: 'dollhouse_prod',
      expectedCurrentUser: 'dollhouse_admin',
    });
  });
});
