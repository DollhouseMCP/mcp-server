/**
 * Stale process detection and recovery (#1850).
 *
 * Finds and kills zombie DollhouseMCP processes that squat on the console
 * port after their session has ended. Used by bindAndListen in server.ts
 * when EADDRINUSE occurs.
 *
 * Extracted to a standalone module so it can be tested without importing
 * the full Express server and its dependency chain.
 */

// Use lazy import for logger to avoid pulling in the full env.ts/config chain
// at module load time. This keeps the module independently testable.
let _logger: typeof import('../../utils/logger.js').logger | null = null;
async function getLogger() {
  if (!_logger) {
    try { _logger = (await import('../../utils/logger.js')).logger; }
    catch { /* fallback below */ }
  }
  return _logger;
}
const logger = {
  warn: async (...args: unknown[]) => { const l = await getLogger(); l ? l.warn(args[0] as string, args[1]) : console.error('[WARN]', ...args); },
  info: async (...args: unknown[]) => { const l = await getLogger(); l ? l.info(args[0] as string, args[1]) : console.error('[INFO]', ...args); },
  debug: async (...args: unknown[]) => { const l = await getLogger(); l ? l.debug(args[0] as string, args[1]) : void 0; },
};

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
  try {
    const { stdout } = await execFileAsync('lsof', ['-ti', `:${port}`], { timeout: 1000 });
    const pids = stdout.trim().split('\n').map(Number).filter(n => !Number.isNaN(n) && n > 0);
    return pids.find(p => p !== process.pid) ?? null;
  } catch {
    return null;
  }
}

/**
 * Kill a stale process holding a port. Sends SIGTERM, waits briefly,
 * then SIGKILL if still alive. Only kills DollhouseMCP processes
 * (verified by checking the command line and user ownership).
 *
 * Timeout: 1s for ps verification. Kill wait: 300ms × 10 polls = 3s
 * before escalating to SIGKILL. Total worst case: ~4s.
 */
export async function killStaleProcess(pid: number, port: number): Promise<boolean> {
  const { execFile: execFileCb } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFileCb);

  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'user=,command='], { timeout: 1000 });
    const currentUser = (await import('node:os')).userInfo().username;
    if (!stdout.trim().startsWith(currentUser)) {
      logger.warn(`[WebUI] Port ${port} held by different user (pid ${pid}) — not killing`);
      return false;
    }
    const cmdLine = stdout.trim();
    // Check that the process is actually running a DollhouseMCP binary, not just
    // a process whose working directory contains 'mcp-server' (e.g., a test runner).
    // We look for the binary names in .bin/ paths or as standalone commands.
    const isDollhouseBin = /\bdollhousemcp\b/.test(cmdLine) && cmdLine.includes('.bin/dollhousemcp');
    const isMcpServerBin = /\bmcp-server\b/.test(cmdLine) && (
      cmdLine.includes('.bin/mcp-server') || cmdLine.includes('dist/index.js')
    );
    if (!isDollhouseBin && !isMcpServerBin) {
      await logger.warn(`[WebUI] Port ${port} held by non-DollhouseMCP process (pid ${pid}) — not killing`, { cmdLine });
      return false;
    }
    await logger.debug(`[WebUI] Verified stale process ${pid} is DollhouseMCP`, { cmdLine });
  } catch (err) {
    logger.debug(`[WebUI] Cannot verify process ${pid} — skipping kill`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
    logger.warn(`[WebUI] Sent SIGTERM to stale process ${pid} on port ${port}`);
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 300));
      try { process.kill(pid, 0); } catch { return true; }
    }
    process.kill(pid, 'SIGKILL');
    logger.warn(`[WebUI] Sent SIGKILL to stale process ${pid} on port ${port}`);
    await new Promise(r => setTimeout(r, 500));
    return true;
  } catch {
    return true; // process already dead
  }
}

/**
 * Detect and recover from a stale process squatting on the port.
 * Compares the port holder's PID against the leader lock file to determine
 * if it's a squatter. Returns true if the squatter was killed.
 *
 * Timeouts: lsof 1s, ps 1s, SIGTERM wait 3s — max ~5s total.
 */
export async function recoverStalePort(port: number): Promise<boolean> {
  const stalePid = await findPidOnPort(port);
  if (!stalePid) return false;

  try {
    const { readLeaderLock } = await import('./LeaderElection.js');
    const lock = await readLeaderLock();
    if (lock?.pid === stalePid && lock?.port === port && lock.pid !== process.pid) {
      logger.warn(`[WebUI] Port ${port} held by legitimate leader (pid ${stalePid}) — not killing`);
      return false;
    }
  } catch {
    // Can't read lock file — treat port holder as squatter
  }

  const killed = await killStaleProcess(stalePid, port);
  if (killed) {
    logger.info(`[WebUI] Stale process ${stalePid} removed from port ${port}`);
    await new Promise(r => setTimeout(r, 500));
  }
  return killed;
}
