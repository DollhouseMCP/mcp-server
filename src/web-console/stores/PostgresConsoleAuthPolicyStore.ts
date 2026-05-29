import { eq } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { consoleAuthPolicy } from '../../database/schema/index.js';
import {
  cloneConsoleAuthPolicy,
  ConsoleAuthPolicyConflictError,
  DEFAULT_CONSOLE_AUTH_POLICY,
  type ConsoleAuthPolicy,
  type IConsoleAuthPolicyStore,
} from './IConsoleAuthPolicyStore.js';

export class PostgresConsoleAuthPolicyStore implements IConsoleAuthPolicyStore {
  constructor(private readonly db: DatabaseInstance) {}

  async load(): Promise<ConsoleAuthPolicy> {
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(consoleAuthPolicy).where(eq(consoleAuthPolicy.id, 1)).limit(1));
    const row = rows.at(0);
    if (!row) return cloneConsoleAuthPolicy(DEFAULT_CONSOLE_AUTH_POLICY);
    return {
      maxAdminElevationSeconds: row.maxAdminElevationSeconds,
      updatedAt: new Date(row.updatedAt.getTime()),
    };
  }

  async save(
    policy: Pick<ConsoleAuthPolicy, 'maxAdminElevationSeconds'>,
    options: { readonly expectedUpdatedAt?: Date } = {},
  ): Promise<ConsoleAuthPolicy> {
    return withSystemContext(this.db, async tx => {
      const rows = await tx
        .select({ updatedAt: consoleAuthPolicy.updatedAt })
        .from(consoleAuthPolicy)
        .where(eq(consoleAuthPolicy.id, 1))
        .for('update');
      const currentUpdatedAt = rows.at(0)?.updatedAt ?? DEFAULT_CONSOLE_AUTH_POLICY.updatedAt;
      if (options.expectedUpdatedAt && currentUpdatedAt.getTime() !== options.expectedUpdatedAt.getTime()) {
        throw new ConsoleAuthPolicyConflictError();
      }
      const updatedAt = new Date(Math.max(Date.now(), currentUpdatedAt.getTime() + 1));
      const values = {
        id: 1,
        maxAdminElevationSeconds: policy.maxAdminElevationSeconds,
        updatedAt,
      };
      const updatedRows = await tx
        .insert(consoleAuthPolicy)
        .values(values)
        .onConflictDoUpdate({
          target: consoleAuthPolicy.id,
          set: values,
        })
        .returning();
      const row = updatedRows.at(0);
      return row
        ? { maxAdminElevationSeconds: row.maxAdminElevationSeconds, updatedAt: row.updatedAt }
        : cloneConsoleAuthPolicy({ maxAdminElevationSeconds: policy.maxAdminElevationSeconds, updatedAt });
    });
  }
}
