import { eq } from 'drizzle-orm';

import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import { authAccounts } from '../../../database/schema/index.js';
import { assertUuid } from '../../stores/ConsoleStoreValidation.js';
import type { ConsoleOAuthSubjectResolver } from './IConsoleOAuthGrantRevocationService.js';

export class PostgresConsoleOAuthSubjectResolver implements ConsoleOAuthSubjectResolver {
  constructor(private readonly db: DatabaseInstance) {}

  async listLinkedSubjects(userId: string): Promise<readonly string[]> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select({ sub: authAccounts.sub })
        .from(authAccounts)
        .where(eq(authAccounts.userId, userId))
        .orderBy(authAccounts.sub),
    );
    return rows.map(row => row.sub);
  }
}
