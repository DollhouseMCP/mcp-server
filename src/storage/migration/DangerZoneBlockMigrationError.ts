import { constants } from 'node:os';
import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';

export type BlockImportStage = 'users' | 'discovery' | 'directory' | 'inspect' | 'read' | 'database' | 'retention' | 'chmod' | 'rename' | 'setup';
export interface BlockImportFailureContext {
  stage: BlockImportStage;
  sourcePath?: string;
  userId?: string;
  setupStep?: string;
  importRecorded?: boolean;
}

/** A reason assembled exclusively from fixed validation text, never raw file or SQL content. */
export class BlockImportValidationError extends Error {}

const reasons: Record<BlockImportStage, string> = {
  users: 'could not list users (database error)',
  discovery: 'could not discover legacy block files',
  directory: 'could not list the users directory',
  inspect: 'could not inspect the block-state file',
  read: 'could not read the block-state file',
  database: 'database error during import',
  retention: 'could not inspect the file before retention',
  chmod: 'could not set permissions on the retained file',
  rename: 'could not rename the retained file',
  setup: 'could not initialize the blocked-agent import',
};
const steps: Partial<Record<BlockImportStage, string>> = { users: 'listing users', directory: 'listing the users directory' };
const reference = 'See docs/security/architecture.md (Blocked-agent persistence).';

function migrationFailureCode(cause: unknown): string | undefined {
  let current = cause;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const error = current as { code?: unknown; cause?: unknown };
    if (typeof error.code === 'string' && (Object.hasOwn(constants.errno, error.code) || /^[0-9A-Z]{5}$/.test(error.code))) return error.code;
    current = error.cause;
  }
  return undefined;
}

function migrationRemedy(context: BlockImportFailureContext): string {
  if (context.importRecorded) return `The import itself was recorded. Preserve the file, fix permissions or the reported file condition, then restart to retry only the retention rename. ${reference}`;
  if (context.stage === 'retention' || context.stage === 'chmod' || context.stage === 'rename') return `Database-mode start-up could not set this file aside for review because it cannot be attributed to a single user. Preserve the file, check permissions on the security directory, then restart. ${reference}`;
  if (context.stage === 'users' || context.stage === 'database') return `Check database availability and migration permissions, then restart. Preserve any source file for review. ${reference}`;
  if (context.stage === 'setup' || context.stage === 'discovery') return `Check database-mode configuration and required services, then restart. ${reference}`;
  if (context.stage === 'directory') return `Check the users directory and its read permissions, then restart. ${reference}`;
  return `Database-mode start-up imports existing blocked-agent files and stopped because this file could not be imported. Fix or replace the file, or move it out of the security directory for review, then restart. ${reference}`;
}

/** Startup failures whose message remains actionable without printing their raw cause. */
export class DangerZoneBlockMigrationError extends Error {
  readonly reason: string;
  readonly code?: string;
  readonly sourcePath?: string;
  readonly userId?: string;
  readonly step: string;
  constructor(context: BlockImportFailureContext, cause: unknown) {
    const code = migrationFailureCode(cause);
    let reason = cause instanceof BlockImportValidationError ? cause.message : reasons[context.stage];
    if (context.stage === 'rename') reason = context.importRecorded ? 'could not rename the imported file' : 'could not rename the unattributed file';
    const step = context.stage === 'setup' ? `setup (${context.setupStep ?? 'initialization'})` : steps[context.stage] ?? context.stage;
    const location = context.sourcePath ?? step;
    const codeSuffix = code ? ` (${code})` : '';
    super(`Legacy blocked-agent state migration failed at ${location}: ${reason}${codeSuffix}. ${migrationRemedy(context)}`, { cause });
    this.name = 'DangerZoneBlockMigrationError';
    this.reason = reason;
    this.code = code;
    this.sourcePath = context.sourcePath;
    this.userId = context.userId;
    this.step = step;
  }
}

/** Called once at the runner or setup catch boundary; never serialize the raw cause. */
export function reportBlockMigrationFailure(context: BlockImportFailureContext, cause: unknown): DangerZoneBlockMigrationError {
  const error = new DangerZoneBlockMigrationError(context, cause);
  const fields = { sourcePath: error.sourcePath, userId: error.userId, step: error.step, reason: error.reason, code: error.code };
  logger.error('Legacy block state import failed', fields);
  SecurityMonitor.logSecurityEvent({ type: 'DANGER_ZONE_OPERATION', severity: 'HIGH', source: 'dangerZoneBlocksToDatabase',
    details: 'Legacy block state import failed', additionalData: fields });
  return error;
}
