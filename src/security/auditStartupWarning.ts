import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';

import type { DatabaseInstance } from '../database/connection.js';
import { withSystemContext } from '../database/admin.js';
import { resolveDataDirectory } from '../paths/resolveDataDirectory.js';
import { logger } from '../utils/logger.js';

let warned = false;

export async function warnAuditRawInputDefaultIfNeeded(options: {
  database?: DatabaseInstance;
  stateDir?: string;
} = {}): Promise<void> {
  if (warned) return;
  if (process.env.DOLLHOUSE_AUDIT_RETAIN_RAW_INPUT !== undefined) return;

  // Caller (SecurityServiceRegistrar.runPostDbWarnings) passes the explicit
  // state dir via PathService. Fallback to resolveDataDirectory for ad-hoc /
  // test invocations so the probe scans the platform-correct location.
  const hasExistingApprovals = options.database
    ? await hasDatabaseCliApprovals(options.database)
    : hasFileCliApprovals(options.stateDir ?? resolveDataDirectory('state'));
  if (!hasExistingApprovals) return;

  warned = true;
  logger.warn(
    '[Audit] DOLLHOUSE_AUDIT_RETAIN_RAW_INPUT is unset; defaulting to false. ' +
    'New CLI approval records will store a redacted digest + HMAC hash instead of raw tool inputs. ' +
    'Existing records retain their original shape and are upgraded on read. ' +
    'Set DOLLHOUSE_AUDIT_RETAIN_RAW_INPUT=true to preserve raw inputs in new writes.',
  );
}

async function hasDatabaseCliApprovals(database: DatabaseInstance): Promise<boolean> {
  // Intentionally uses withSystemContext (BYPASSRLS) — this is a
  // deployment-wide probe ("is there ANY approval anywhere?") that needs
  // to count rows across all users' sessions. withUserContext would
  // restrict to the current session's user and miss approvals from
  // other sessions, defeating the purpose of the warning.
  const rows = await withSystemContext(database, (tx) =>
    tx.execute(sql`
      SELECT 1
      FROM sessions
      WHERE jsonb_array_length(cli_approvals) > 0
      LIMIT 1
    `),
  ) as unknown[];
  return rows.length > 0;
}

function hasFileCliApprovals(stateDir: string): boolean {
  try {
    for (const name of fs.readdirSync(stateDir)) {
      if (!/^confirmations-.+\.json$/.test(name)) continue;
      const raw = fs.readFileSync(path.join(stateDir, name), 'utf8');
      const parsed = JSON.parse(raw) as { cliApprovals?: unknown[] };
      if (Array.isArray(parsed.cliApprovals) && parsed.cliApprovals.length > 0) return true;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    logger.warn('[Audit] Failed to inspect existing CLI approvals for raw-input retention warning', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return false;
}
