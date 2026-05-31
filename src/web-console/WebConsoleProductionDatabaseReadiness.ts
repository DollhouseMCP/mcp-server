import { sql } from 'drizzle-orm';

import type { DatabaseInstance } from '../database/connection.js';

export interface WebConsoleProductionDatabaseReadinessSnapshot {
  readonly ready: boolean;
  readonly failureCodes: readonly string[];
  readonly detail?: string;
}

export interface IProductionDatabaseReadiness {
  getReadiness(): Promise<WebConsoleProductionDatabaseReadinessSnapshot>;
}

export class StaticProductionDatabaseReadiness implements IProductionDatabaseReadiness {
  constructor(private readonly snapshot: WebConsoleProductionDatabaseReadinessSnapshot) {}

  getReadiness(): Promise<WebConsoleProductionDatabaseReadinessSnapshot> {
    return Promise.resolve(this.snapshot);
  }
}

export function productionDatabaseReady(): IProductionDatabaseReadiness {
  return new StaticProductionDatabaseReadiness({
    ready: true,
    failureCodes: [],
  });
}

export interface PostgresProductionDatabaseReadinessOptions {
  readonly db: DatabaseInstance;
  readonly expectedDatabaseName: string;
  readonly expectedCurrentUser?: string;
  readonly requiredTables?: readonly string[];
}

interface DatabaseIdentityRow {
  readonly databaseName: string;
  readonly currentUser: string;
}

interface ExistingTableRow {
  readonly tableName: string;
}

export const WEB_CONSOLE_PRODUCTION_REQUIRED_TABLES = [
  'users',
  'auth_accounts',
  'user_settings',
  'operator_settings',
  'auth_signing_keys',
  'audit_hmac_keys',
  'rate_limit_state',
  'user_admin_roles',
  'account_allowlist_entries',
  'console_sessions',
  'console_auth_policy',
  'console_login_transactions',
  'idempotency_records',
  'account_factors',
  'account_factor_backup_codes',
  'security_invalidation_events',
  'security_invalidation_replica_cursors',
  'security_invalidation_replica_leases',
  'security_invalidation_acks',
  'runtime_session_presence',
  'runtime_control_commands',
  'runtime_control_acks',
  'admin_audit_chain_heads',
  'admin_audit_events',
  'user_integrations',
  'portfolio_sync_jobs',
] as const;

export class PostgresProductionDatabaseReadiness implements IProductionDatabaseReadiness {
  private readonly requiredTables: readonly string[];

  constructor(private readonly options: PostgresProductionDatabaseReadinessOptions) {
    this.requiredTables = options.requiredTables ?? WEB_CONSOLE_PRODUCTION_REQUIRED_TABLES;
  }

  async getReadiness(): Promise<WebConsoleProductionDatabaseReadinessSnapshot> {
    try {
      const identityFailures = await this.checkIdentity();
      const missingTables = await this.listMissingRequiredTables();
      const failures = [
        ...identityFailures,
        ...(missingTables.length > 0 ? ['production_database_migrations_incomplete'] : []),
      ];
      return failures.length === 0
        ? { ready: true, failureCodes: [] }
        : {
          ready: false,
          failureCodes: failures,
          detail: this.buildFailureDetail(identityFailures, missingTables),
        };
    } catch {
      return {
        ready: false,
        failureCodes: ['production_database_check_failed'],
        detail: 'Production database readiness check failed.',
      };
    }
  }

  private async checkIdentity(): Promise<string[]> {
    const rows = await this.options.db.execute(sql`
      SELECT current_database() AS "databaseName", current_user AS "currentUser"
    `) as unknown as DatabaseIdentityRow[];
    const row = rows.at(0);
    if (!row) return ['production_database_identity_unavailable'];
    const failures: string[] = [];
    if (row.databaseName !== this.options.expectedDatabaseName) {
      failures.push('production_database_identity_mismatch');
    }
    if (this.options.expectedCurrentUser && row.currentUser !== this.options.expectedCurrentUser) {
      failures.push('production_database_user_mismatch');
    }
    return failures;
  }

  private async listMissingRequiredTables(): Promise<readonly string[]> {
    const rows = await this.options.db.execute(sql`
      SELECT table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
    `) as unknown as ExistingTableRow[];
    const existingTables = new Set(rows.map(row => row.tableName));
    return this.requiredTables.filter(table => !existingTables.has(table));
  }

  private buildFailureDetail(
    identityFailures: readonly string[],
    missingTables: readonly string[],
  ): string {
    const details: string[] = [];
    if (identityFailures.length > 0) {
      details.push('database identity did not match the configured production expectation');
    }
    if (missingTables.length > 0) {
      details.push(`missing required tables: ${missingTables.join(', ')}`);
    }
    return details.join('; ');
  }
}

export function createPostgresProductionDatabaseReadiness(
  options: PostgresProductionDatabaseReadinessOptions,
): IProductionDatabaseReadiness {
  return new PostgresProductionDatabaseReadiness(options);
}

export function productionDatabaseNotVerified(detail = 'Production database and migration state have not been verified.'): IProductionDatabaseReadiness {
  return new StaticProductionDatabaseReadiness({
    ready: false,
    failureCodes: ['production_database_not_verified'],
    detail,
  });
}
