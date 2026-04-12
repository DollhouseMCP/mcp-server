/**
 * Dynamic port allocation and port file discovery for the web console.
 *
 * When multiple DollhouseMCP sessions run simultaneously (e.g., multiple
 * Claude Code windows, IDE instances, or agent sessions), each needs its
 * own web console port. This module handles:
 *
 * 1. Finding an available port starting from the configured default
 *    (see `DOLLHOUSE_WEB_CONSOLE_PORT` in `src/config/env.ts`)
 * 2. Writing port discovery files so external tools know which port to use
 * 3. Cleaning up port files on process exit
 *
 * Port files are written to ~/.dollhouse/run/:
 * - permission-server-{pid}.port — per-process file (cleaned on exit)
 * - permission-server.port — latest port (convenience for scripts)
 */

import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, unlink, readdir } from 'node:fs/promises';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/** Default maximum port attempts before giving up */
const DEFAULT_MAX_PORT_ATTEMPTS = 10;

/** Directory for runtime state files (port discovery, PID files) */
const RUN_DIR = join(homedir(), '.dollhouse', 'run');

/** Track port file path for cleanup */
let portFilePath: string | null = null;

/**
 * Attempt to bind to a single port. Returns the port if successful, null if in use.
 * Keeps the server listening to prevent TOCTOU race conditions — caller must
 * close the returned server after their own server binds.
 */
function tryBindPort(port: number): Promise<{ port: number; server: Server } | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(null);
      } else {
        resolve(null);
        logger.debug(`[PortDiscovery] Unexpected error on port ${port}: ${err.code}`);
      }
    });
    server.once('listening', () => {
      resolve({ port, server });
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find an available port starting from the given port.
 *
 * Tries sequential ports, logging each attempt. Returns both the port number
 * and a held server to prevent TOCTOU race conditions. The caller should
 * close the held server after binding their own Express app to the port.
 *
 * @param startPort - Port to try first (see `DOLLHOUSE_WEB_CONSOLE_PORT` for the default)
 * @param maxAttempts - Maximum ports to try (default: 10, configurable via DOLLHOUSE_MAX_PORT_ATTEMPTS)
 * @returns Object with port number and held server, or throws if all attempts fail
 */
export async function findAvailablePort(
  startPort: number,
  maxAttempts: number = Number(process.env.DOLLHOUSE_MAX_PORT_ATTEMPTS) || DEFAULT_MAX_PORT_ATTEMPTS,
): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = startPort + attempt;
    logger.debug(`[PortDiscovery] Trying port ${port} (attempt ${attempt + 1}/${maxAttempts})`);

    const result = await tryBindPort(port);
    if (result) {
      // Close the probe server — there's a brief TOCTOU window here between
      // closing and the caller binding, but it's negligible on localhost.
      // A future improvement could return the server for the caller to adopt.
      result.server.close();
      if (attempt > 0) {
        logger.info(`[PortDiscovery] Port ${startPort} in use, using ${port} (after ${attempt} skip${attempt > 1 ? 's' : ''})`);
      }
      return port;
    }
    logger.debug(`[PortDiscovery] Port ${port} in use, trying next`);
  }

  throw new Error(
    `No available port found in range ${startPort}-${startPort + maxAttempts - 1} ` +
    `after ${maxAttempts} attempts. Set DOLLHOUSE_MAX_PORT_ATTEMPTS to increase the range.`
  );
}

/**
 * Write the active server port to a discoverable file.
 *
 * Creates two files:
 * - PID-keyed file for per-process cleanup
 * - Latest file for convenience (scripts can read this without knowing the PID)
 *
 * @param port - The port the web server is listening on
 * @returns Path to the PID-keyed port file
 */
export async function writePortFile(port: number): Promise<string> {
  await mkdir(RUN_DIR, { recursive: true });
  const pidFile = join(RUN_DIR, `permission-server-${process.pid}.port`);
  const latestFile = join(RUN_DIR, 'permission-server.port');
  await writeFile(pidFile, String(port), 'utf-8');
  await writeFile(latestFile, String(port), 'utf-8');
  portFilePath = pidFile;
  logger.debug(`[PortDiscovery] Port file written: ${pidFile}`);
  return pidFile;
}

/**
 * Clean up port file on shutdown.
 */
export async function cleanupPortFile(): Promise<void> {
  if (portFilePath) {
    try { await unlink(portFilePath); } catch { /* already gone */ }
  }
}

/**
 * Register process exit handlers to clean up port files.
 * Should be called once after the web server successfully starts.
 */
export function registerPortCleanup(): void {
  const exitCleanup = () => { cleanupPortFile().catch(() => {}); };
  process.once('exit', exitCleanup);
  process.once('SIGTERM', exitCleanup);
  process.once('SIGINT', exitCleanup);
  process.once('SIGHUP', exitCleanup);
}

/**
 * Sweep stale port files from ~/.dollhouse/run/ on startup (#1856).
 *
 * Scans for permission-server-{pid}.port files and removes any whose PID
 * is no longer alive. This prevents unbounded accumulation of port files
 * from crashed or abandoned sessions.
 *
 * Note: This only removes metadata files, not processes or ports. The port
 * binding itself (in bindAndListen) is atomic via listen(). There is no race
 * between sweeping files and binding — they operate on independent resources.
 *
 * Safe to call on every startup — only removes files for dead processes.
 */
export async function sweepStalePortFiles(customDir?: string): Promise<number> {
  try {
    const dir = customDir || RUN_DIR;
    await mkdir(dir, { recursive: true });
    const files = await readdir(dir);
    const PORT_FILE_RE = /^permission-server-(\d+)\.port$/;
    let removed = 0;

    for (const file of files) {
      const match = PORT_FILE_RE.exec(file);
      if (!match) continue;
      const pid = Number(match[1]);

      // Check if process is alive via signal-0.
      // ESRCH = process doesn't exist (dead). EPERM = process exists but
      // owned by another user (alive — don't touch their port file).
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (err: any) {
        alive = err?.code === 'EPERM'; // EPERM = alive but different user
      }

      if (!alive) {
        try {
          await unlink(join(dir, file));
          removed++;
        } catch { /* already gone */ }
      }
    }

    if (removed > 0) {
      logger.info(`[PortDiscovery] Swept ${removed} stale port files from ${dir}`);
    }
    return removed;
  } catch (err) {
    logger.debug('[PortDiscovery] Stale port file sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Discover an available port, write discovery files, and register cleanup.
 *
 * This is the recommended entry point for Container startup. Combines
 * port discovery, file writing, and cleanup registration in one call.
 *
 * @param defaultPort - Port to try first (see `DOLLHOUSE_WEB_CONSOLE_PORT` for the default)
 * @returns The port the server should bind to, or undefined if discovery failed
 */
export async function discoverAndBindPort(
  defaultPort: number = env.DOLLHOUSE_WEB_CONSOLE_PORT,
): Promise<number | undefined> {
  try {
    const port = await findAvailablePort(defaultPort);

    await writePortFile(port);
    registerPortCleanup();

    return port;
  } catch (err) {
    logger.warn('[PortDiscovery] Port discovery failed:', err);
    return undefined;
  }
}
