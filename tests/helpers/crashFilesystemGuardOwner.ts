import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Acquire a production filesystem guard in a subprocess, then kill its owner. */
export async function crashFilesystemGuardOwner(guardPath: string): Promise<void> {
  const readyPath = `${guardPath}.owner-ready`;
  const moduleUrl = pathToFileURL(path.join(
    process.cwd(),
    'src/security/filesystemInterprocessGuard.ts',
  )).href;
  const childSource = `
    import fs from 'node:fs/promises';
    import { withFilesystemInterprocessGuard } from ${JSON.stringify(moduleUrl)};
    const input = JSON.parse(process.env.DOLLHOUSE_GUARD_CRASH_INPUT);
    await withFilesystemInterprocessGuard(input.guardPath, async () => {
      await fs.writeFile(input.readyPath, String(process.pid), { mode: 0o600 });
      await new Promise(() => { setInterval(() => {}, 1_000); });
    });
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', childSource],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DOLLHOUSE_GUARD_CRASH_INPUT: JSON.stringify({ guardPath, readyPath }),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    },
  );

  try {
    await waitForFileOrExit(readyPath, closed, stderr);
    if (!child.kill('SIGKILL')) {
      throw new Error('Failed to send SIGKILL to filesystem guard owner');
    }
    const result = await closed;
    if (result.signal !== 'SIGKILL') {
      throw new Error(
        `Filesystem guard owner exited unexpectedly (${result.code}/${result.signal}): ${stderr}`,
      );
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await fs.unlink(readyPath).catch(() => {});
  }
}

async function waitForFileOrExit(
  filePath: string,
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  stderr: string,
): Promise<void> {
  const timeoutAt = Date.now() + 5_000;
  while (Date.now() < timeoutAt) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      const result = await Promise.race([
        closed.then(value => ({ kind: 'closed' as const, value })),
        new Promise<{ kind: 'waiting' }>(resolve => {
          setTimeout(() => resolve({ kind: 'waiting' }), 20);
        }),
      ]);
      if (result.kind === 'closed') {
        throw new Error(
          `Filesystem guard owner exited before acquisition (${result.value.code}/${result.value.signal}): ${stderr}`,
        );
      }
    }
  }
  throw new Error(`Timed out waiting for crashed guard owner at ${filePath}`);
}
