import { afterEach, describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withOAuthStateLock } from '../../../src/utils/OAuthStateCoordinator.js';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-state-coordinator-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe('OAuthStateCoordinator', () => {
  it('serializes a flow cleanup and a replacement state write', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    await fs.writeFile(stateFile, JSON.stringify({ flowId: 'flow-a' }), 'utf8');

    let releaseCleanup!: () => void;
    const cleanupCanFinish = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let cleanupHasRead!: () => void;
    const cleanupRead = new Promise<void>(resolve => { cleanupHasRead = resolve; });

    const cleanup = withOAuthStateLock(stateFile, async () => {
      const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { flowId?: string };
      expect(state.flowId).toBe('flow-a');
      cleanupHasRead();
      await cleanupCanFinish;
      await fs.unlink(stateFile);
    });

    await cleanupRead;
    let replacementEntered = false;
    const replacement = withOAuthStateLock(stateFile, async () => {
      replacementEntered = true;
      await fs.writeFile(stateFile, JSON.stringify({ flowId: 'flow-b' }), 'utf8');
    });

    await new Promise(resolve => setImmediate(resolve));
    expect(replacementEntered).toBe(false);
    releaseCleanup();
    await Promise.all([cleanup, replacement]);

    await expect(fs.readFile(stateFile, 'utf8')).resolves.toContain('flow-b');
    await expect(fs.access(`${stateFile}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prevents a helper claim from overwriting a replacement flow across processes', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const claimStartedFile = path.join(directory, 'claim-started');
    await fs.writeFile(stateFile, JSON.stringify({ flowId: 'flow-a' }), 'utf8');

    const coordinatorUrl = pathToFileURL(
      path.join(process.cwd(), 'dist', 'utils', 'OAuthStateCoordinator.js')
    ).href;
    const childScript = `
      import fs from 'node:fs';
      import { withOAuthStateLockSync, writeFileAtomicallySync } from ${JSON.stringify(coordinatorUrl)};
      const [stateFile, claimStartedFile] = process.argv.slice(1);
      withOAuthStateLockSync(stateFile, () => {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        fs.writeFileSync(claimStartedFile, 'ready');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        writeFileAtomicallySync(stateFile, JSON.stringify({ ...state, pid: process.pid }));
      });
    `;
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      childScript,
      stateFile,
      claimStartedFile
    ], { stdio: 'ignore' });
    const childExit = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Claim child exited ${code}`)));
    });

    await waitForFile(claimStartedFile);
    await withOAuthStateLock(stateFile, async () => {
      await fs.writeFile(stateFile, JSON.stringify({ flowId: 'flow-b' }), 'utf8');
    });
    await childExit;

    const finalState = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Record<string, unknown>;
    expect(finalState).toEqual({ flowId: 'flow-b' });
    await expect(fs.access(`${stateFile}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a stale lock only when its owner is no longer running', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const lockFile = `${stateFile}.lock`;
    await fs.writeFile(lockFile, '99999999:orphaned-lock', { encoding: 'utf8', mode: 0o600 });
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(lockFile, staleTime, staleTime);

    await withOAuthStateLock(stateFile, async () => {
      await fs.writeFile(stateFile, JSON.stringify({ flowId: 'recovered-flow' }), 'utf8');
    });

    await expect(fs.readFile(stateFile, 'utf8')).resolves.toContain('recovered-flow');
    await expect(fs.access(lockFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(`${lockFile}.recovery`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
