import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { syncFilesystemDirectory } from './durableFileOperations.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 10;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const OWNER_MARKER_RE = new RegExp(`^owner-(${UUID_PATTERN})\\.json$`, 'iu');
const CLAIMED_MARKER_RE = new RegExp(`^\\.claim-(${UUID_PATTERN})$`, 'iu');
const RECLAIMER_MARKER_RE = new RegExp(
  `^\\.reclaim-(${UUID_PATTERN})-([1-9][0-9]*)-([0-9a-f]{64}|unknown)-(${UUID_PATTERN})$`,
  'iu',
);

export interface FilesystemProcessIncarnation {
  readonly source: 'linux-proc' | 'darwin-ps';
  readonly bootId: string;
  readonly processStartId: string;
}

interface FilesystemGuardOwner {
  readonly version: 1;
  readonly ownerToken: string;
  readonly host: string;
  readonly pid: number;
  readonly createdAt: number;
  readonly incarnation: FilesystemProcessIncarnation | null;
}

interface GuardActor {
  readonly ownerToken: string;
  readonly pid: number;
  readonly incarnation: FilesystemProcessIncarnation | null;
}

/** @internal Test-only seams for deterministic crash/reclaimer interleavings. */
export interface FilesystemInterprocessGuardTestHooks {
  readonly processIncarnationProvider?: (
    pid: number,
  ) => Promise<FilesystemProcessIncarnation | null>;
  readonly beforeReclaimerMarkerClaim?: (observedMarkerName: string) => Promise<void>;
}

export interface FilesystemInterprocessGuardOptions {
  readonly timeoutMs?: number;
  readonly retryMs?: number;
  readonly testHooks?: FilesystemInterprocessGuardTestHooks;
}

/**
 * Serialize a short filesystem operation across processes.
 *
 * The owner directory is prepared under a unique name and atomically published
 * at `guardPath`, so an observable guard always contains verifiable ownership.
 * Same-host dead process incarnations can be reclaimed; foreign, malformed, or
 * unverifiable live-PID owners fail closed. Every release/reclaimer first claims
 * the exact observed marker before moving the directory, so it cannot touch a
 * successor guard.
 */
export async function withFilesystemInterprocessGuard<T>(
  guardPath: string,
  operation: () => Promise<T>,
  options: FilesystemInterprocessGuardOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  const ownerToken = randomUUID();
  const ownerMarkerName = `owner-${ownerToken}.json`;
  const identityProvider = options.testHooks?.processIncarnationProvider ?? readFilesystemProcessIncarnation;
  const incarnation = await identityProvider(process.pid).catch(() => null);
  const owner: FilesystemGuardOwner = {
    version: 1,
    ownerToken,
    host: hostname(),
    pid: process.pid,
    createdAt: Date.now(),
    incarnation,
  };
  const actor: GuardActor = { ownerToken, pid: process.pid, incarnation };

  await fs.mkdir(path.dirname(guardPath), { recursive: true, mode: 0o700 });
  while (true) {
    const published = await publishGuard(guardPath, ownerMarkerName, owner);
    if (published) break;
    if (await reclaimDeadSameHostOwner(
      guardPath,
      actor,
      identityProvider,
      options.testHooks,
    )) continue;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out acquiring filesystem interprocess guard '${guardPath}'`);
    }
    await new Promise(resolve => setTimeout(resolve, retryMs));
  }

  const ownerPath = path.join(guardPath, ownerMarkerName);
  try {
    return await operation();
  } finally {
    await removeGuardOwnedByMarker(guardPath, ownerPath, ownerToken, 'released');
  }
}

async function publishGuard(
  guardPath: string,
  ownerMarkerName: string,
  owner: FilesystemGuardOwner,
): Promise<boolean> {
  const parentPath = path.dirname(guardPath);
  const candidatePath = `${guardPath}.${owner.ownerToken}.candidate`;
  const candidateOwnerPath = path.join(candidatePath, ownerMarkerName);
  await fs.mkdir(candidatePath, { mode: 0o700 });
  try {
    const ownerHandle = await fs.open(candidateOwnerPath, 'wx', 0o600);
    try {
      await ownerHandle.writeFile(JSON.stringify(owner), 'utf8');
      await ownerHandle.sync();
    } finally {
      await ownerHandle.close();
    }
    await syncFilesystemDirectory(candidatePath);
    await syncFilesystemDirectory(parentPath);
    try {
      await fs.rename(candidatePath, guardPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') return false;
      throw error;
    }
    await syncFilesystemDirectory(parentPath);
    return true;
  } finally {
    await fs.rm(candidatePath, { recursive: true, force: true });
  }
}

async function reclaimDeadSameHostOwner(
  guardPath: string,
  reclaimer: GuardActor,
  identityProvider: (pid: number) => Promise<FilesystemProcessIncarnation | null>,
  hooks?: FilesystemInterprocessGuardTestHooks,
): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(guardPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (entries.length !== 1) return false;
  const markerName = entries[0];
  const ownerMatch = OWNER_MARKER_RE.exec(markerName);
  const claimedMatch = CLAIMED_MARKER_RE.exec(markerName);
  const reclaimerMatch = RECLAIMER_MARKER_RE.exec(markerName);
  const originalOwnerToken = ownerMatch?.[1] ?? claimedMatch?.[1] ?? reclaimerMatch?.[1];
  if (!originalOwnerToken) return false;

  const markerPath = path.join(guardPath, markerName);
  const owner = await readGuardOwner(markerPath);
  if (!owner || owner.ownerToken !== originalOwnerToken || owner.host !== hostname() ||
      await isRecordedProcessAlive(owner.pid, owner.incarnation, identityProvider)) {
    return false;
  }

  if (ownerMatch) {
    return removeGuardOwnedByMarker(
      guardPath,
      markerPath,
      owner.ownerToken,
      'abandoned',
    );
  }

  if (reclaimerMatch) {
    const previousReclaimerPid = Number.parseInt(reclaimerMatch[2], 10);
    const previousIncarnationDigest = reclaimerMatch[3].toLowerCase();
    if (await isRecordedDigestAlive(
      previousReclaimerPid,
      previousIncarnationDigest,
      identityProvider,
    )) return false;
  }

  return claimAndRemoveAbandonedGuard(
    guardPath,
    markerName,
    originalOwnerToken,
    reclaimer,
    hooks,
  );
}

async function readGuardOwner(ownerPath: string): Promise<FilesystemGuardOwner | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as Partial<FilesystemGuardOwner>;
    const incarnation = parseFilesystemProcessIncarnation(parsed.incarnation);
    if (parsed.version !== 1 || typeof parsed.ownerToken !== 'string' ||
        typeof parsed.host !== 'string' || parsed.host.length === 0 ||
        typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
        typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt) ||
        incarnation === undefined) {
      return null;
    }
    return {
      version: 1,
      ownerToken: parsed.ownerToken,
      host: parsed.host,
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      incarnation,
    };
  } catch {
    return null;
  }
}

export function parseFilesystemProcessIncarnation(
  value: unknown,
): FilesystemProcessIncarnation | null | undefined {
  // Accept pre-incarnation markers conservatively for rolling upgrades. They
  // can be reclaimed only after their PID is observably absent.
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return undefined;
  const candidate = value as Partial<FilesystemProcessIncarnation>;
  if ((candidate.source !== 'linux-proc' && candidate.source !== 'darwin-ps') ||
      typeof candidate.bootId !== 'string' || candidate.bootId.length === 0 ||
      typeof candidate.processStartId !== 'string' || candidate.processStartId.length === 0) {
    return undefined;
  }
  return candidate as FilesystemProcessIncarnation;
}

async function isRecordedProcessAlive(
  pid: number,
  recorded: FilesystemProcessIncarnation | null,
  identityProvider: (pid: number) => Promise<FilesystemProcessIncarnation | null>,
): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  if (!recorded) return true;
  const current = await identityProvider(pid).catch(() => null);
  if (!current) return true;
  return sameFilesystemProcessIncarnation(recorded, current);
}

async function isRecordedDigestAlive(
  pid: number,
  recordedDigest: string,
  identityProvider: (pid: number) => Promise<FilesystemProcessIncarnation | null>,
): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  if (recordedDigest === 'unknown') return true;
  const current = await identityProvider(pid).catch(() => null);
  if (!current) return true;
  return processIncarnationDigest(current) === recordedDigest;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function sameFilesystemProcessIncarnation(
  left: FilesystemProcessIncarnation,
  right: FilesystemProcessIncarnation,
): boolean {
  return left.source === right.source && left.bootId === right.bootId &&
    left.processStartId === right.processStartId;
}

function processIncarnationDigest(incarnation: FilesystemProcessIncarnation | null): string {
  if (!incarnation) return 'unknown';
  return createHash('sha256').update(JSON.stringify([
    incarnation.source,
    incarnation.bootId,
    incarnation.processStartId,
  ])).digest('hex');
}

function reclaimerMarkerName(originalOwnerToken: string, reclaimer: GuardActor): string {
  return `.reclaim-${originalOwnerToken}-${reclaimer.pid}-${
    processIncarnationDigest(reclaimer.incarnation)
  }-${reclaimer.ownerToken}`;
}

async function removeGuardOwnedByMarker(
  guardPath: string,
  ownerPath: string,
  ownerToken: string,
  suffix: 'released' | 'abandoned',
): Promise<boolean> {
  const claimedMarker = path.join(guardPath, `.claim-${ownerToken}`);
  try {
    await fs.rename(ownerPath, claimedMarker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  const quarantinedGuard = `${guardPath}.${ownerToken}.${suffix}`;
  try {
    await fs.rename(guardPath, quarantinedGuard);
  } catch (error) {
    await fs.rename(claimedMarker, ownerPath).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  await syncFilesystemDirectory(path.dirname(guardPath));
  await fs.rm(quarantinedGuard, { recursive: true, force: true });
  await syncFilesystemDirectory(path.dirname(guardPath));
  return true;
}

async function claimAndRemoveAbandonedGuard(
  guardPath: string,
  observedMarkerName: string,
  originalOwnerToken: string,
  reclaimer: GuardActor,
  hooks?: FilesystemInterprocessGuardTestHooks,
): Promise<boolean> {
  await hooks?.beforeReclaimerMarkerClaim?.(observedMarkerName);
  const observedMarker = path.join(guardPath, observedMarkerName);
  const claimedMarkerName = reclaimerMarkerName(originalOwnerToken, reclaimer);
  const claimedMarker = path.join(guardPath, claimedMarkerName);
  try {
    await fs.rename(observedMarker, claimedMarker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  const quarantinedGuard = `${guardPath}.${originalOwnerToken}.${reclaimer.ownerToken}.abandoned`;
  try {
    await fs.rename(guardPath, quarantinedGuard);
  } catch (error) {
    await fs.rename(claimedMarker, observedMarker).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  await syncFilesystemDirectory(path.dirname(guardPath));
  await fs.rm(quarantinedGuard, { recursive: true, force: true });
  await syncFilesystemDirectory(path.dirname(guardPath));
  return true;
}

export async function readFilesystemProcessIncarnation(
  pid: number,
): Promise<FilesystemProcessIncarnation | null> {
  if (process.platform === 'linux') {
    try {
      const [bootId, stat] = await Promise.all([
        fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        fs.readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      const closingParen = stat.lastIndexOf(')');
      if (closingParen < 0) return null;
      const fieldsAfterCommand = stat.slice(closingParen + 1).trim().split(/\s+/u);
      const processStartId = fieldsAfterCommand[19];
      if (!processStartId || !/^[0-9]+$/u.test(processStartId)) return null;
      return {
        source: 'linux-proc',
        bootId: bootId.trim(),
        processStartId,
      };
    } catch {
      return null;
    }
  }

  if (process.platform === 'darwin') {
    try {
      const [bootId, processStartId] = await Promise.all([
        execFileText('/usr/sbin/sysctl', ['-n', 'kern.boottime']),
        execFileText('/bin/ps', ['-p', String(pid), '-o', 'lstart=']),
      ]);
      const normalizedBootId = normalizeIdentityText(bootId);
      const normalizedProcessStartId = normalizeIdentityText(processStartId);
      if (!normalizedBootId || !normalizedProcessStartId) return null;
      return {
        source: 'darwin-ps',
        bootId: normalizedBootId,
        processStartId: normalizedProcessStartId,
      };
    } catch {
      return null;
    }
  }
  return null;
}

function execFileText(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function normalizeIdentityText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}
