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

  // Try lsof first (macOS + most Linux), fall back to fuser (minimal Linux/Docker)
  for (const cmd of [
    { bin: 'lsof', args: ['-ti', `:${port}`] },
    { bin: 'fuser', args: [`${port}/tcp`] },
  ]) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd.bin, cmd.args, { timeout: 1000 });
      // fuser outputs to stderr on some systems
      const output = (stdout || stderr || '').trim();
      const pids = output.split(/\s+/).map(Number).filter(n => !Number.isNaN(n) && n > 0);
      const otherPid = pids.find(p => p !== process.pid);
      if (otherPid) return otherPid;
    } catch {
      continue; // command not found or no results — try next
    }
  }
  return null;
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

  // Security verification flow — three checks must pass before we kill:
  // 1. Process must be owned by the current OS user (prevents cross-user kills)
  // 2. Command line must match a DollhouseMCP binary path (prevents killing other services)
  // 3. If both fail or ps can't run, we refuse — safe default is to not kill
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'user=,command='], { timeout: 1000 });

    // Check 1: User ownership — only kill our own processes
    const currentUser = (await import('node:os')).userInfo().username;
    if (!stdout.trim().startsWith(currentUser)) {
      await logger.warn(`[WebUI] Port ${port} held by different user (pid ${pid}) — not killing`);
      return false;
    }

    // Check 2: Binary identity — must be .bin/mcp-server, .bin/dollhousemcp,
    // /bin/dollhousemcp (global install), or dist/index.js (direct node execution).
    // NOT just 'mcp-server' anywhere in the path — that would match Jest workers
    // running from within the mcp-server project directory.
    const cmdLine = stdout.trim();
    const isDollhouseBin = /(?:^|\/)dollhousemcp(?:\s|$)/.test(cmdLine) ||
      cmdLine.includes('.bin/dollhousemcp');
    const isMcpServerBin = cmdLine.includes('.bin/mcp-server') ||
      cmdLine.includes('dist/index.js');
    if (!isDollhouseBin && !isMcpServerBin) {
      await logger.warn(`[WebUI] Port ${port} held by non-DollhouseMCP process (pid ${pid}) — not killing`, { cmdLine });
      return false;
    }
    await logger.debug(`[WebUI] Verified stale process ${pid} is DollhouseMCP`, { cmdLine });
  } catch (err: any) {
    // Check 3: If we can't verify, don't kill — safe default.
    // Differentiate: ENOENT = ps not found, ESRCH = process died between find and verify.
    const code = err?.code || err?.status;
    const reason = code === 'ENOENT' ? 'ps command not found'
      : code === 'ESRCH' ? 'process died during verification'
      : err instanceof Error ? err.message : String(err);
    await logger.debug(`[WebUI] Cannot verify process ${pid} — skipping kill (${reason})`);
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

  // Check the lock file to see if this PID is a legitimate leader.
  // TOCTOU mitigation: a new process may have JUST bound the port but not yet
  // written its lock file. We read the lock, pause 500ms, then re-read. If the
  // second read now matches the port holder, it's a fresh leader — don't kill.
  const { readLeaderLock } = await import('./LeaderElection.js');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lock = await readLeaderLock();
      if (lock?.pid === stalePid && lock?.port === port && lock.pid !== process.pid) {
        await logger.warn(`[WebUI] Port ${port} held by legitimate leader (pid ${stalePid}) — not killing`);
        return false;
      }
    } catch {
      // Can't read lock file — continue to next attempt or kill
    }
    if (attempt === 0) {
      // Brief pause to let a freshly-started process write its lock file
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const killed = await killStaleProcess(stalePid, port);
  if (killed) {
    logger.info(`[WebUI] Stale process ${stalePid} removed from port ${port}`);
    await new Promise(r => setTimeout(r, 500));
  }
  return killed;
}
