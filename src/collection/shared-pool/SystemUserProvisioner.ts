/**
 * SystemUserProvisioner
 *
 * Ensures the SYSTEM user row exists in the database. The migration
 * (0008) creates it, but this provisioner provides an idempotent
 * runtime check for scenarios where the migration hasn't run yet or
 * the row was manually deleted.
 *
 * The SYSTEM user is the owner of all shared-pool elements in DB mode.
 * It has no auth credentials, no settings, and no session — it exists
 * solely as the FK target for `elements.user_id` on shared rows.
 *
 * File mode does not use this — the `shared/` directory itself is the
 * trust boundary.
 *
 * @module collection/shared-pool/SystemUserProvisioner
 */

import { eq } from 'drizzle-orm';
import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { SYSTEM_USER_UUID, SYSTEM_USERNAME, SYSTEM_DISPLAY_NAME } from './SharedPoolConfig.js';
import type { DatabaseInstance } from '../../database/connection.js';

export class SystemUserProvisioner {
  constructor(private readonly db: DatabaseInstance) {}

  /**
   * Ensure the SYSTEM user row exists. Idempotent — safe to call on
   * every startup.
   *
   * Uses the admin connection (caller is responsible for providing a
   * DB instance that bypasses RLS on the `users` table). In practice,
   * the migration already created the row; this is a safety net.
   *
   * @returns `true` if the row was created, `false` if it already existed.
   */
  async ensure(): Promise<boolean> {
    const { users } = await import('../../database/schema/users.js');

    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, SYSTEM_USER_UUID))
      .limit(1);

    if (existing.length > 0) {
      logger.debug('[SystemUserProvisioner] SYSTEM user already exists', {
        userId: SYSTEM_USER_UUID,
      });
      return false;
    }

    await this.db
      .insert(users)
      .values({
        id: SYSTEM_USER_UUID,
        username: SYSTEM_USERNAME,
        displayName: SYSTEM_DISPLAY_NAME,
      })
      .onConflictDoNothing();

    logger.info('[SystemUserProvisioner] SYSTEM user provisioned', {
      userId: SYSTEM_USER_UUID,
      username: SYSTEM_USERNAME,
    });

    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_INITIALIZATION',
      severity: 'LOW',
      source: 'SystemUserProvisioner.ensure',
      details: `SYSTEM user provisioned for shared pool (${SYSTEM_USER_UUID})`,
    });

    return true;
  }
}
