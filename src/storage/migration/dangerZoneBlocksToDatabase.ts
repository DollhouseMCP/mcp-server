import { BlockStateValidationError } from '../../security/BlockStateValidationError.js';
import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseInstance } from '../../database/connection.js';
import { withSystemContext } from '../../database/admin.js';
import { users } from '../../database/schema/users.js';
import { isInternalUserId } from '../../database/internalUsers.js';
import type { LegacyDetectingPathResolver } from '../../paths/LegacyDetectingPathResolver.js';
import { DatabaseDangerZoneBlockStore } from '../../state/DatabaseDangerZoneBlockStore.js';
import { MAX_BLOCK_SNAPSHOT_BYTES, readDangerZoneBlockSnapshot } from '../../state/readDangerZoneBlockSnapshot.js';
import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { and, eq, sql } from 'drizzle-orm';
import { withUserContext } from '../../database/rls.js';
import { dangerZoneBlockEvidence } from '../../database/schema/dangerZoneBlocks.js';
import { BlockImportValidationError, reportBlockMigrationFailure, type BlockImportFailureContext } from './DangerZoneBlockMigrationError.js';
export { DangerZoneBlockMigrationError } from './DangerZoneBlockMigrationError.js';

export interface DangerZoneBlockMigrationOptions {
  database: DatabaseInstance;
  systemDatabase: DatabaseInstance;
  userId: string;
  pathResolver: Pick<LegacyDetectingPathResolver, 'getLayout' | 'getAnchorRoot' | 'getUserSecurityDir'>;
  /** Historical beta root; override only for isolated migration tests. */
  legacyRoot?: string;
}
interface Source { filename: string; userId?: string }
const source = 'dangerZoneBlocksToDatabase';
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** Shared files have an owner only when there is exactly one possible writer. */
function sharedFileOwner(userIds: readonly string[], bootstrapUser: string): string | undefined {
  const writers = userIds.filter(id => !isInternalUserId(id));
  return writers.length === 1 && writers[0] === bootstrapUser ? bootstrapUser : undefined;
}

async function discoverBlockSources(options: DangerZoneBlockMigrationOptions, userIds: string[], failure: BlockImportFailureContext): Promise<Source[]> {
  const root = path.join(options.legacyRoot ?? path.join(os.homedir(), '.dollhouse'), 'security', 'blocked-agents.json');
  const owner = sharedFileOwner(userIds, options.userId);
  const sources: Source[] = [{ filename: root, userId: owner }];
  const resolver = options.pathResolver;
  if (resolver.getLayout() === 'flat') {
    const flat = path.join(resolver.getUserSecurityDir(options.userId), 'blocked-agents.json');
    if (path.resolve(flat) !== path.resolve(root)) sources.push({ filename: flat, userId: owner });
    return sources;
  }
  const directory = path.join(resolver.getAnchorRoot(), 'users');
  failure.stage = 'directory';
  failure.sourcePath = directory;
  const entries = await fs.readdir(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  for (const name of entries) {
    if (!UUID.test(name) || !userIds.includes(name)) {
      logger.warn('Legacy block directory has no known user', { directory: path.join(directory, name) });
      continue;
    }
    sources.push({ filename: path.join(directory, name, 'security', 'blocked-agents.json'), userId: name });
  }
  return sources;
}

async function inspectSource(filename: string): Promise<Stats | undefined> {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await fs.realpath(filename) !== path.join(await fs.realpath(path.dirname(filename)), path.basename(filename))) {
      throw new BlockImportValidationError('file is not a regular, singly linked file');
    }
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function snapshotValidationReason(cause: unknown): string {
  if (cause instanceof SyntaxError) return ': invalid JSON';
  return cause instanceof BlockStateValidationError ? `: ${cause.message}` : '';
}

async function readImportSnapshot(filename: string, identity: Stats): Promise<{ blocks: Record<string, unknown>; digest: string }> {
  let digest = '';
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== identity.dev || opened.ino !== identity.ino || opened.nlink !== 1) throw new BlockImportValidationError('file changed during import');
    const result = await readDangerZoneBlockSnapshot(async () => {
      const bytes = Buffer.alloc(MAX_BLOCK_SNAPSHOT_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const content = bytes.subarray(0, offset);
      digest = createHash('sha256').update(content).digest('hex');
      return content.toString('utf8');
    }, () => handle.stat());
    if (result.status === 'unreadable') throw result.cause;
    if (result.status !== 'loaded') {
      const cause = 'cause' in result ? result.cause : undefined;
      throw new BlockImportValidationError(`file is not valid block state (${result.status}${snapshotValidationReason(cause)})`, { cause });
    }
    return { blocks: result.value, digest };
  } finally { await handle.close(); }
}

/** Called only after a committed receipt, or for an unattributed source with no import. */
async function retainSource(filename: string, identity: Stats, label: 'imported' | 'unattributed', failure: BlockImportFailureContext): Promise<string | undefined> {
  try {
    failure.stage = 'retention';
    const current = await fs.lstat(filename);
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.nlink !== 1 || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs) {
      throw new BlockImportValidationError('file changed during import');
    }
    const evidence = `${filename}.${label}-${randomUUID()}`;
    failure.stage = 'chmod';
    await fs.chmod(filename, 0o600);
    failure.stage = 'rename';
    await fs.rename(filename, evidence);
    return evidence;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readExistingSnapshot(filename: string, identity: Stats) {
  try { return await readImportSnapshot(filename, identity); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !await inspectSource(filename)) return undefined;
    throw error;
  }
}

async function migrateBlockSource(options: DangerZoneBlockMigrationOptions, candidate: Source, writerCount: number, failure: BlockImportFailureContext): Promise<{ wroteReceipt: boolean; agentNames: string[] } | undefined> {
  const identity = await inspectSource(candidate.filename);
  if (!identity) return undefined;
  if (!candidate.userId) {
    const evidence = await retainSource(candidate.filename, identity, 'unattributed', failure);
    if (!evidence) return undefined;
    const details = 'Legacy block file retained without user attribution';
    logger.warn(details, { writerCount, evidence });
    SecurityMonitor.logSecurityEvent({ type: 'DANGER_ZONE_OPERATION', severity: 'HIGH', source, details,
      additionalData: { writerCount, evidence } });
    return undefined;
  }
  failure.stage = 'read';
  const snapshot = await readExistingSnapshot(candidate.filename, identity);
  if (!snapshot) return undefined;
  const { blocks, digest } = snapshot;
  const userId = candidate.userId;
  failure.stage = 'database';
  const wroteReceipt = await options.database.transaction(async transaction => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('legacy-agent-block-import', 0))`);
    return withUserContext(transaction as unknown as DatabaseInstance, userId, async tx => {
      const receipts = await tx.select({ id: dangerZoneBlockEvidence.id }).from(dangerZoneBlockEvidence).where(and(
        eq(dangerZoneBlockEvidence.userId, userId),
        sql`${dangerZoneBlockEvidence.snapshot}->>'kind' = 'legacy-agent-block-import'`,
        sql`${dangerZoneBlockEvidence.snapshot}->>'source' = ${candidate.filename}`,
        sql`${dangerZoneBlockEvidence.snapshot}->>'sha256' = ${digest}`,
      )).limit(1);
      if (receipts.length) return false;
      const store = new DatabaseDangerZoneBlockStore(tx as unknown as DatabaseInstance, userId);
      await Object.entries(blocks).reduce(async (previous, [name, block]) => {
        await previous;
        await store.apply({ kind: 'put', name, block });
      }, Promise.resolve());
      await tx.insert(dangerZoneBlockEvidence).values({ userId,
        snapshot: { kind: 'legacy-agent-block-import', source: candidate.filename, sha256: digest, blocks } });
      return true;
    });
  });
  failure.importRecorded = true;
  await retainSource(candidate.filename, identity, 'imported', failure);
  return { wroteReceipt, agentNames: Object.keys(blocks) };
}

/** Complete legacy imports before any database-backed enforcer is initialized. */
export async function runDangerZoneBlocksToDatabaseMigration(options: DangerZoneBlockMigrationOptions): Promise<void> {
  const failure: BlockImportFailureContext = { stage: 'users' };
  try {
    const rows = await withSystemContext(options.systemDatabase, tx => tx.select({ id: users.id }).from(users));
    const userIds = rows.map(row => row.id);
    const writerCount = userIds.filter(id => !isInternalUserId(id)).length;
    failure.stage = 'discovery';
    const candidates = await discoverBlockSources(options, userIds, failure);
    await candidates.reduce(async (previous, candidate) => {
      await previous;
      Object.assign(failure, { stage: 'inspect', sourcePath: candidate.filename, userId: candidate.userId, importRecorded: false });
      const result = await migrateBlockSource(options, candidate, writerCount, failure);
      if (!result?.wroteReceipt) return;
      const details = 'Legacy block state imported';
      const additionalData = { userId: candidate.userId, sourcePath: candidate.filename,
        count: result.agentNames.length, agentNames: result.agentNames };
      logger.info(details, additionalData);
      SecurityMonitor.logSecurityEvent({ type: 'DANGER_ZONE_OPERATION', severity: 'MEDIUM', source, details, additionalData });
    }, Promise.resolve());
  } catch (cause) {
    throw reportBlockMigrationFailure(failure, cause);
  }
}
