/**
 * Non-destructive stale process inspection (#1850).
 *
 * Detects when another process is already holding the console port and
 * classifies whether it looks like DollhouseMCP. Startup recovery is
 * intentionally non-destructive for verified Dollhouse sessions: authority
 * issues should demote/follow existing sessions rather than killing them.
 * Operators can still explicitly dismiss true orphans from the web console.
 *
 * Extracted to a standalone module so it can be tested without importing
 * the full Express server and its dependency chain.
 */

import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';

// Use lazy import for logger to avoid pulling in the full env.ts/config chain
// at module load time. This keeps the module independently testable.
/** Timeout for lsof/fuser/ps system calls (ms) */
const COMMAND_TIMEOUT_MS = 1000;
/** Polling interval when waiting for SIGTERM to take effect (ms) */
const SIGTERM_POLL_MS = 300;
/** Number of polls before escalating to SIGKILL */
const KILL_POLL_COUNT = 10;
/** Wait after SIGKILL before returning (ms) */
const SIGKILL_WAIT_MS = 500;
/** Wait between lock file reads for TOCTOU mitigation (ms) */
const LOCK_RECHECK_DELAY_MS = 500;
/** Number of lock-file checks before deciding the port holder is not a fresh leader. */
const LOCK_RECHECK_ATTEMPTS = 2;
/** PID used by the OS init/launchd process; direct children are effectively orphaned. */
const ROOT_PARENT_PID = 1;
/** Number of `ps` columns requested by inspectProcess: user, pid, ppid, command. */
const PROCESS_INSPECTION_FIELD_COUNT = 4;

let _logger: typeof import('../../utils/logger.js').logger | null = null;
async function getLogger() {
  if (!_logger) {
    try { _logger = (await import('../../utils/logger.js')).logger; }
    catch { /* fallback below */ }
  }
  return _logger;
}
const logger = {
  warn: async (...args: unknown[]) => {
    const l = await getLogger();
    if (l) l.warn(args[0] as string, args[1]);
    else console.error('[WARN]', ...args);
  },
  info: async (...args: unknown[]) => {
    const l = await getLogger();
    if (l) l.info(args[0] as string, args[1]);
    else console.error('[INFO]', ...args);
  },
  debug: async (...args: unknown[]) => {
    const l = await getLogger();
    if (l) l.debug(args[0] as string, args[1]);
  },
};

const MCP_HOST_PARENT_PATTERNS = [
  /Claude\.app\/Contents\/Helpers\/disclaimer/i,
  /Codex\.app\/Contents\/Resources\/codex app-server/i,
  /Cursor\.app\//i,
  /Windsurf\.app\//i,
];

interface ProcessInspection {
  user: string;
  pid: number;
  parentPid: number;
  command: string;
}

export interface KillStaleProcessOutcome {
  killed: boolean;
  reason:
    | 'inspect_failed'
    | 'different_user'
    | 'not_dollhouse_process'
    | 'requires_orphan_proof'
    | 'active_host_parent'
    | 'terminated'
    | 'already_dead'
    | 'still_alive'
    | 'signal_failed';
  pid: number;
  parentPid?: number;
  command?: string;
  parentCommand?: string;
  detail?: string;
}

export interface KillStaleProcessOptions {
  allowVerifiedDollhouseKill?: boolean;
  allowActiveHostParent?: boolean;
}

export function isRecognizedMcpHostParent(command: string): boolean {
  const normalizedCommand = UnicodeValidator.normalize(command).normalizedContent;
  return MCP_HOST_PARENT_PATTERNS.some((pattern) => pattern.test(normalizedCommand));
}

function isDollhouseProcessCommand(cmdLine: string): boolean {
  const normalizedCommand = UnicodeValidator.normalize(cmdLine).normalizedContent;
  const isDollhouseBin = /(?:^|\/)dollhousemcp(?:\s|$)/.test(normalizedCommand) ||
    normalizedCommand.includes('.bin/dollhousemcp');
  const isMcpServerBin = normalizedCommand.includes('.bin/mcp-server') ||
    /(?:dollhousemcp|mcp-server)[/\\]dist[/\\]index\.js/.test(normalizedCommand);
  return isDollhouseBin || isMcpServerBin;
}

function parsePidToken(value: string): number | null {
  if (!value) return null;
  for (let i = 0; i < value.length; i++) {
    const codePoint = value.codePointAt(i);
    if (codePoint === undefined || codePoint < 48 || codePoint > 57) {
      return null;
    }
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < ROOT_PARENT_PID) {
    return null;
  }
  return parsed;
}

function isWhitespaceChar(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\n' || value === '\r' || value === '\f' || value === '\v';
}

function buildKillOutcome(
  killed: boolean,
  reason: KillStaleProcessOutcome['reason'],
  processInfo: ProcessInspection,
  parentCommand?: string,
  detail?: string,
): KillStaleProcessOutcome {
  return {
    killed,
    reason,
    pid: processInfo.pid,
    parentPid: processInfo.parentPid,
    command: processInfo.command,
    parentCommand,
    ...(detail ? { detail } : {}),
  };
}

async function getKillGuardFailure(
  processInfo: ProcessInspection,
  port: number,
  options: KillStaleProcessOptions = {},
): Promise<KillStaleProcessOutcome | null> {
  const currentUser = (await import('node:os')).userInfo().username;
  if (processInfo.user !== currentUser) {
    await logger.warn(`[WebUI] Port ${port} held by different user (pid ${processInfo.pid}) — not killing`);
    return buildKillOutcome(false, 'different_user', processInfo);
  }

  if (!isDollhouseProcessCommand(processInfo.command)) {
    await logger.warn(`[WebUI] Port ${port} held by non-DollhouseMCP process (pid ${processInfo.pid}) — not killing`, {
      cmdLine: processInfo.command,
    });
    return buildKillOutcome(false, 'not_dollhouse_process', processInfo);
  }

  const parentCommand = processInfo.parentPid > ROOT_PARENT_PID
    ? (await getProcessCommand(processInfo.parentPid)) ?? undefined
    : undefined;

  if (!options.allowVerifiedDollhouseKill) {
    await logger.warn(`[WebUI] Port ${port} held by another DollhouseMCP session (pid ${processInfo.pid}) — not auto-killing`, {
      cmdLine: processInfo.command,
      parentPid: processInfo.parentPid,
      parentCommand,
    });
    return buildKillOutcome(false, 'requires_orphan_proof', processInfo, parentCommand);
  }

  if (processInfo.parentPid <= ROOT_PARENT_PID || !isPidAlive(processInfo.parentPid)) {
    return null;
  }

  if (!options.allowActiveHostParent && parentCommand && isRecognizedMcpHostParent(parentCommand)) {
    await logger.warn(`[WebUI] Port ${port} held by active client-backed DollhouseMCP process (pid ${processInfo.pid}) — not killing`, {
      cmdLine: processInfo.command,
      parentPid: processInfo.parentPid,
      parentCommand,
    });
    return buildKillOutcome(false, 'active_host_parent', processInfo, parentCommand);
  }

  return null;
}

async function terminateProcess(
  processInfo: ProcessInspection,
  port: number,
  parentCommand?: string,
): Promise<KillStaleProcessOutcome> {
  process.kill(processInfo.pid, 'SIGTERM');
  logger.warn(`[WebUI] Sent SIGTERM to stale process ${processInfo.pid} on port ${port}`, {
    cmdLine: processInfo.command,
    parentPid: processInfo.parentPid,
    parentCommand,
  });

  for (let i = 0; i < KILL_POLL_COUNT; i++) {
    await new Promise(r => setTimeout(r, SIGTERM_POLL_MS));
    if (!isPidAlive(processInfo.pid)) {
      return buildKillOutcome(true, 'terminated', processInfo, parentCommand);
    }
  }

  process.kill(processInfo.pid, 'SIGKILL');
  logger.warn(`[WebUI] Sent SIGKILL to stale process ${processInfo.pid} on port ${port}`);
  await new Promise(r => setTimeout(r, SIGKILL_WAIT_MS));
  return isPidAlive(processInfo.pid)
    ? buildKillOutcome(false, 'still_alive', processInfo, parentCommand)
    : buildKillOutcome(true, 'terminated', processInfo, parentCommand);
}

function splitProcessInspectionFields(line: string): string[] | null {
  const fields: string[] = [];
  let index = 0;
  const normalizedLine = UnicodeValidator.normalize(line).normalizedContent.trim();

  while (index < normalizedLine.length && fields.length < PROCESS_INSPECTION_FIELD_COUNT - 1) {
    while (index < normalizedLine.length && isWhitespaceChar(normalizedLine[index])) {
      index++;
    }
    if (index >= normalizedLine.length) break;

    const fieldStart = index;
    while (index < normalizedLine.length && !isWhitespaceChar(normalizedLine[index])) {
      index++;
    }
    fields.push(normalizedLine.slice(fieldStart, index));
  }

  while (index < normalizedLine.length && isWhitespaceChar(normalizedLine[index])) {
    index++;
  }
  if (index < normalizedLine.length) {
    fields.push(normalizedLine.slice(index));
  }

  return fields.length === PROCESS_INSPECTION_FIELD_COUNT ? fields : null;
}

async function inspectProcess(pid: number): Promise<ProcessInspection | null> {
  const { execFile: execFileCb } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFileCb);

  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-p', String(pid), '-o', 'user=,pid=,ppid=,command='],
      { timeout: COMMAND_TIMEOUT_MS },
    );
    const fields = splitProcessInspectionFields(stdout);
    if (!fields) return null;
    const [user, pidToken, parentPidToken, command] = fields;
    const parsedPid = parsePidToken(pidToken);
    const parsedParentPid = parsePidToken(parentPidToken);
    if (parsedPid === null || parsedParentPid === null) return null;

    return {
      user: UnicodeValidator.normalize(user).normalizedContent,
      pid: parsedPid,
      parentPid: parsedParentPid,
      command: UnicodeValidator.normalize(command).normalizedContent,
    };
  } catch {
    return null;
  }
}

async function getProcessCommand(pid: number): Promise<string | null> {
  const { execFile: execFileCb } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFileCb);

  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: COMMAND_TIMEOUT_MS });
    const normalized = UnicodeValidator.normalize(stdout).normalizedContent.trim();
    return normalized || null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the PID of the process listening on a given port.
 * Uses lsof on macOS/Linux. Returns null if not found or on error.
 *
 * Timeout: 1s — lsof on localhost is typically <100ms. The 1s ceiling
 * handles slow NFS-mounted /dev/fd or overloaded CI runners without
 * delaying startup noticeably.
 */
export async function findPidOnPort(port: number): Promise<number | null> {
  const { execFile: execFileCb } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFileCb);

  // Query only LISTEN sockets so established client connections to the console
  // don't get mistaken for the owning leader process.
  for (const cmd of [
    { bin: 'lsof', args: ['-nP', '-iTCP:' + String(port), '-sTCP:LISTEN', '-t'] },
    { bin: 'ss', args: ['-ltnp', `sport = :${port}`] },
    { bin: 'fuser', args: ['-n', 'tcp', String(port)] },
  ]) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd.bin, cmd.args, { timeout: COMMAND_TIMEOUT_MS });
      const output = (stdout || stderr || '').trim();
      if (!output) {
        continue;
      }

      let pids: number[] = [];
      if (cmd.bin === 'ss') {
        pids = output
          .split('\n')
          .flatMap((line) => Array.from(line.matchAll(/pid=(\d+)/g), (match) => parsePidToken(match[1])))
          .filter((pid): pid is number => pid !== null);
      } else {
        // fuser outputs to stderr on some systems; lsof emits one PID per line.
        pids = output
          .split(/\s+/)
          .map((token) => parsePidToken(token))
          .filter((pid): pid is number => pid !== null);
      }

      const otherPid = pids.find(p => p !== process.pid);
      if (otherPid) return otherPid;
    } catch {
      continue; // command not found or no results — try next
    }
  }
  return null;
}

/**
 * Kill a process holding a port.
 *
 * This helper is intentionally conservative. By default it refuses to signal
 * verified DollhouseMCP sessions unless the caller opts in with explicit
 * orphan proof via `allowVerifiedDollhouseKill`.
 *
 * Timeout: 1s for ps verification. Kill wait: 300ms × 10 polls = 3s
 * before escalating to SIGKILL. Total worst case: ~4s.
 */
export async function killStaleProcess(pid: number, port: number): Promise<boolean> {
  const outcome = await killStaleProcessDetailed(pid, port);
  return outcome.killed;
}

export async function killStaleProcessDetailed(
  pid: number,
  port: number,
  options: KillStaleProcessOptions = {},
): Promise<KillStaleProcessOutcome> {
  const processInfo = await inspectProcess(pid);
  if (!processInfo) {
    await logger.debug(`[WebUI] Cannot verify process ${pid} — skipping kill`);
    return { killed: false, reason: 'inspect_failed', pid };
  }

  const guardFailure = await getKillGuardFailure(processInfo, port, options);
  if (guardFailure) {
    return guardFailure;
  }
  const parentCommand = processInfo.parentPid > ROOT_PARENT_PID
    ? (await getProcessCommand(processInfo.parentPid)) ?? undefined
    : undefined;

  await logger.debug(`[WebUI] Verified stale process ${pid} is DollhouseMCP`, { cmdLine: processInfo.command, parentPid: processInfo.parentPid, parentCommand });

  try {
    return await terminateProcess(processInfo, port, parentCommand);
  } catch (err) {
    if (!isPidAlive(pid)) {
      return buildKillOutcome(true, 'already_dead', processInfo, parentCommand);
    }
    return buildKillOutcome(false, 'signal_failed', processInfo, parentCommand, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Inspect the process squatting on the port.
 * Compares the port holder's PID against the leader lock file to determine
 * if it's a fresh leader, but refuses to auto-kill verified DollhouseMCP
 * sessions. Returns true only when a future caller provides orphan proof and
 * the occupant is actually terminated.
 *
 * Timeouts: lsof 1s, ps 1s, SIGTERM wait 3s — max ~5s total.
 */
export async function recoverStalePort(port: number): Promise<boolean> {
  const stalePid = await findPidOnPort(port);
  if (!stalePid) return false;

  // TOCTOU mitigation: a new process may have just bound the port but not yet
  // written its lock file. Read the lock, pause, re-read. If the second read
  // now matches the port holder, it's a fresh leader — don't kill.
  const { readLeaderLock } = await import('./LeaderElection.js');
  for (let check = 0; check < LOCK_RECHECK_ATTEMPTS; check++) {
    try {
      const lock = await readLeaderLock();
      if (lock?.pid === stalePid && lock?.port === port && lock.pid !== process.pid) {
        await logger.warn(`[WebUI] Port ${port} held by legitimate leader (pid ${stalePid}) — not killing`);
        return false;
      }
    } catch {
      // Can't read lock file — continue to next check or kill
    }
    if (check < LOCK_RECHECK_ATTEMPTS - 1) {
      await new Promise(r => setTimeout(r, LOCK_RECHECK_DELAY_MS));
    }
  }

  const outcome = await killStaleProcessDetailed(stalePid, port);
  if (outcome.killed) {
    logger.info(`[WebUI] Stale process ${stalePid} removed from port ${port}`);
    await new Promise(r => setTimeout(r, SIGKILL_WAIT_MS)); // brief pause for port release
  } else {
    await logger.debug(`[WebUI] Stale-port recovery skipped for pid ${stalePid}`, {
      reason: outcome.reason,
      parentPid: outcome.parentPid,
      parentCommand: outcome.parentCommand,
      detail: outcome.detail,
    });
  }
  return outcome.killed;
}
