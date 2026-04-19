/**
 * auto-dollhouse#5: Dynamic port allocation and port file discovery.
 *
 * Extracted from server.ts. Handles finding available ports when multiple
 * DollhouseMCP sessions run simultaneously, and writing port discovery
 * files so PreToolUse hook scripts know which port to curl.
 */

import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, unlink } from 'node:fs/promises';

const MAX_PORT_ATTEMPTS = 10;

/**
 * Resolve the runtime-state directory (port files, PID files).
 *
 * Reads the DOLLHOUSE_RUN_DIR env var on each call so tests and deployments
 * can override without restarting the process. Falls back to the legacy
 * `~/.dollhouse/run/` location. When Step 4.5's `resolveDataDirectory()`
 * lands, this becomes a thin wrapper over `resolveDataDirectory('run')`.
 */
function getRunDir(): string {
  return process.env.DOLLHOUSE_RUN_DIR || join(homedir(), '.dollhouse', 'run');
}

/** Track port file path for cleanup */
let portFilePath: string | null = null;

/**
 * Find an available port starting from the given port.
 * Tries sequential ports up to MAX_PORT_ATTEMPTS to avoid conflicts
 * when multiple DollhouseMCP sessions run simultaneously.
 */
function tryBindPort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => reject(err));
    server.once('listening', () => server.close(() => resolve(port)));
    server.listen(port, '127.0.0.1');
  });
}

export async function findAvailablePort(startPort: number): Promise<number> {
  for (let attempt = 0; attempt <= MAX_PORT_ATTEMPTS; attempt++) {
    try {
      return await tryBindPort(startPort + attempt);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === MAX_PORT_ATTEMPTS) {
        throw err;
      }
    }
  }
  throw new Error(`No available port found after ${MAX_PORT_ATTEMPTS} attempts from ${startPort}`);
}

/**
 * Write the active server port to a discoverable file.
 * PreToolUse hook scripts read this to know which port to curl.
 * Each process writes its own PID-keyed file for cleanup.
 */
export async function writePortFile(port: number): Promise<string> {
  const runDir = getRunDir();
  await mkdir(runDir, { recursive: true });
  const pidFile = join(runDir, `permission-server-${process.pid}.port`);
  const latestFile = join(runDir, 'permission-server.port');
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
 */
export function registerPortCleanup(): void {
  const exitCleanup = () => { cleanupPortFile().catch(() => {}); };
  process.once('exit', exitCleanup);
  process.once('SIGTERM', exitCleanup);
  process.once('SIGINT', exitCleanup);
}
