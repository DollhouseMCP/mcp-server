/**
 * Database Persistence Utilities
 *
 * Shared helpers for database-backed state stores. Provides upsert,
 * fire-and-forget persist with retry, and initialization error handling
 * for DatabaseActivationStateStore, DatabaseConfirmationStore, and
 * DatabaseChallengeStore.
 *
 * All queries run inside RLS-scoped transactions via withUserContext /
 * withUserRead so that PostgreSQL enforces row-level isolation even if
 * application code omits a WHERE clause.
 *
 * @since v2.2.0 — Phase 4, Step 4.2
 */

import { eq, sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext, withUserRead } from '../database/rls.js';
import { sessions } from '../database/schema/sessions.js';

// ── Validation ──────────────────────────────────────────────────────

/** UUID v4 format (lowercase hex) */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Session ID: alphanumeric prefix + alphanumeric/hyphens/underscores, 1-64 chars.
 *
 * More permissive than FileActivationStateStore's equivalent pattern (which
 * requires a leading letter for filename safety). DB storage has no filename
 * concern, and HTTP sessions use `randomUUID()` — roughly 62% of v4 UUIDs
 * start with a digit (`0-9`). A letter-prefix rule would deterministically
 * reject those and manifest as an "Internal server error" at session init.
 */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Validate that a value is a UUID v4.
 * Used by storage layers and stores that receive userId from the DI container.
 */
export function validateUserId(userId: string): void {
  if (!UUID_PATTERN.test(userId)) {
    throw new Error(`[db-persistence-utils] Invalid userId — expected UUID v4, got '${userId.slice(0, 40)}'`);
  }
}

/**
 * Validate userId and sessionId for database store construction.
 * Throws on invalid input to fail early rather than producing confusing DB errors.
 */
export function validateDbStoreParams(userId: string, sessionId: string): void {
  validateUserId(userId);
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`[db-persistence-utils] Invalid sessionId — must match [a-zA-Z][a-zA-Z0-9_-]{0,63}, got '${sessionId.slice(0, 40)}'`);
  }
}

// ── Retry / Fire-and-Forget ─────────────────────────────────────────

/** Maximum number of retry attempts for transient DB failures. */
export const DB_PERSIST_MAX_RETRIES = 2;

/**
 * Delay between retry attempts in milliseconds.
 * Higher than the file-store default (100ms) to accommodate connection
 * pool recovery and network latency on transient PostgreSQL errors.
 */
export const DB_PERSIST_RETRY_DELAY_MS = 150;

// fireAndForgetDbPersist has been replaced by PersistQueue, which provides
// serialized writes with coalescing. See PersistQueue.ts.

/**
 * Standard error handler for database store initialization.
 */
export function handleDbInitializeError(
  error: unknown,
  storeName: string,
  stateType: string,
  sessionId: string,
): void {
  logger.warn(
    `[${storeName}] Failed to load ${stateType} from database for session '${sessionId}', starting fresh`,
    { error },
  );

  SecurityMonitor.logSecurityEvent({
    type: 'OPERATION_FAILED',
    severity: 'MEDIUM',
    source: `${storeName}.initialize`,
    details: `Failed to load ${stateType} from database for session '${sessionId}' — starting fresh`,
    additionalData: { error: String(error), sessionId },
  });
}

// ── Session Row Operations ──────────────────────────────────────────
// All operations run inside RLS-scoped transactions. The userId is set
// via SET LOCAL app.current_user_id so PostgreSQL RLS policies enforce
// row isolation at the database level.

/**
 * Load the sessions row for a given userId + sessionId.
 * Runs inside a read-only RLS-scoped transaction.
 * Returns null if no row exists (or is not visible to this user).
 */
export async function loadSessionRow(
  db: DatabaseInstance,
  userId: string,
  sessionId: string,
): Promise<typeof sessions.$inferSelect | null> {
  return withUserRead(db, userId, async (tx) => {
    const rows = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1);

    return rows[0] ?? null;
  });
}

/**
 * Ensure a sessions row exists for the given userId + sessionId.
 * Uses INSERT ... ON CONFLICT DO UPDATE (touch lastActive) + RETURNING
 * inside an RLS-scoped transaction to eliminate TOCTOU races.
 * Returns the row's primary key (id).
 */
export async function ensureSessionRow(
  db: DatabaseInstance,
  userId: string,
  sessionId: string,
): Promise<string> {
  return withUserContext(db, userId, async (tx) => {
    const rows = await tx
      .insert(sessions)
      .values({
        userId,
        sessionId,
        activations: {},
        confirmations: [],
        cliApprovals: [],
        cliSessionApprovals: [],
        challenges: [],
        permissionPromptActive: false,
      })
      .onConflictDoUpdate({
        target: [sessions.userId, sessions.sessionId],
        set: { lastActive: sql`NOW()` },
      })
      .returning({ id: sessions.id });

    const row = rows[0];
    if (!row) {
      throw new Error('[db-persistence-utils] Upsert returned no row — possible FK violation (user may not exist)');
    }
    return row.id;
  });
}

/**
 * Update specific JSONB columns on the sessions row.
 * Runs inside an RLS-scoped transaction.
 * Warns if no row was matched (session row may have been deleted or not yet created).
 */
export async function updateSessionColumns(
  db: DatabaseInstance,
  userId: string,
  sessionId: string,
  updates: Partial<{
    activations: unknown;
    confirmations: unknown;
    cliApprovals: unknown;
    cliSessionApprovals: unknown;
    permissionPromptActive: boolean;
    challenges: unknown;
  }>,
): Promise<void> {
  const dataKeys = Object.keys(updates).filter(k => updates[k as keyof typeof updates] !== undefined);
  if (dataKeys.length === 0) return;

  await withUserContext(db, userId, async (tx) => {
    const result = await tx
      .update(sessions)
      .set({
        ...updates,
        updatedAt: sql`NOW()`,
        lastActive: sql`NOW()`,
      })
      .where(eq(sessions.sessionId, sessionId))
      .returning({ id: sessions.id });

    if (result.length === 0) {
      logger.warn('[db-persistence-utils] updateSessionColumns matched no rows — session may not exist', {
        sessionId,
        columns: dataKeys,
      });
    }
  });
}

/**
 * Query sessions rows for the current user (RLS-scoped).
 * Used by listPersistedActivationStates for cross-session reporting.
 */
export async function queryUserSessions(
  db: DatabaseInstance,
  userId: string,
  sessionId?: string,
  limit: number = 100,
): Promise<Array<typeof sessions.$inferSelect>> {
  return withUserRead(db, userId, async (tx) => {
    const query = sessionId
      ? tx.select().from(sessions)
          .where(eq(sessions.sessionId, sessionId))
          .limit(limit)
      : tx.select().from(sessions)
          .limit(limit);

    return query;
  });
}
