/**
 * Dynamic port allocation and port file discovery for the web console.
 *
 * When multiple DollhouseMCP sessions run simultaneously (e.g., multiple
 * Claude Code windows, IDE instances, or agent sessions), each needs its
 * own web console port. This module handles:
 *
 * 1. Finding an available port starting from the default (3939)
 * 2. Writing port discovery files so external tools know which port to use
 * 3. Cleaning up port files on process exit
 *
 * Port files are written to ~/.dollhouse/run/:
 * - permission-server-{pid}.port — per-process file (cleaned on exit)
 * - permission-server.port — latest port (convenience for scripts)
 */

import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { logger } from '../utils/logger.js';

const MAX_PORT_ATTEMPTS = 10;

/** Directory for runtime state files (port discovery, PID files) */
const RUN_DIR = join(homedir(), '.dollhouse', 'run');

/** Track port file path for cleanup */
let portFilePath: string | null = null;

/**
 * Find an available port starting from the given port.
 * Tries sequential ports up to MAX_PORT_ATTEMPTS to avoid conflicts
 * when multiple DollhouseMCP sessions run simultaneously.
 *
 * @param startPort - Port to try first (default: 3939)
 * @returns The first available port found
 * @throws If no port is available within MAX_PORT_ATTEMPTS
 */
export function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function tryPort(port: number) {
      const server = createServer();
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS) {
          attempt++;
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port, '127.0.0.1');
    }
    tryPort(startPort);
  });
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
}

/**
 * Start the web server with port discovery.
 *
 * Finds an available port, starts the server, writes port discovery files,
 * and registers cleanup handlers. This is the recommended way to start the
 * web console when concurrent sessions are possible.
 *
 * @param defaultPort - Port to try first (default: 3939)
 * @returns The port the server bound to, or undefined if startup failed
 */
export async function discoverAndBindPort(defaultPort: number = 3939): Promise<number | undefined> {
  try {
    const port = await findAvailablePort(defaultPort);

    if (port !== defaultPort) {
      logger.info(`[WebUI] Port ${defaultPort} in use, bound to ${port} instead`);
    }

    await writePortFile(port);
    registerPortCleanup();

    return port;
  } catch (err) {
    logger.warn('[WebUI] Port discovery failed:', err);
    return undefined;
  }
}
