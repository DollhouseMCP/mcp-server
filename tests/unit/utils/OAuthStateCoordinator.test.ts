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

async function expectAllTicketsCompleted(stateFile: string): Promise<void> {
  const entries = await fs.readdir(`${stateFile}.lock`);
  const slots = entries.filter(entry => /^\d+\.slot$/.test(entry));
  const doneMarkers = new Set(entries.filter(entry => /^\d+\.done$/.test(entry)));

  expect(slots.length).toBeGreaterThan(0);
  expect(entries).toHaveLength(slots.length * 2);
  for (const slot of slots) {
    expect(doneMarkers.has(slot.replace(/\.slot$/, '.done'))).toBe(true);
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe('OAuthStateCoordinator', () => {
  it('compacts completed prefixes while retaining the allocation high-water mark', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');

    for (let acquisition = 0; acquisition < 3; acquisition++) {
      await withOAuthStateLock(stateFile, async () => {});
    }

    const entries = await fs.readdir(`${stateFile}.lock`);
    expect(entries.sort()).toEqual(['3.done', '3.slot']);
  });

  it('does not compact completed tickets beneath another allocation intent', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const lockDirectory = `${stateFile}.lock`;

    await withOAuthStateLock(stateFile, async () => {});
    const activeOwner = await fs.readFile(path.join(lockDirectory, '1.slot'), 'utf8');
    const competingIntent = path.join(lockDirectory, '.999.competing.slot.tmp');
    await fs.writeFile(competingIntent, activeOwner, 'utf8');
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(competingIntent, staleTime, staleTime);

    await withOAuthStateLock(stateFile, async () => {});
    await expect(fs.access(path.join(lockDirectory, '1.slot'))).resolves.toBeUndefined();

    await fs.unlink(competingIntent);
    await withOAuthStateLock(stateFile, async () => {});
    const entries = await fs.readdir(lockDirectory);
    expect(entries.sort()).toEqual(['3.done', '3.slot']);
  });

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
    await expectAllTicketsCompleted(stateFile);
  });

  it('prevents a helper claim from overwriting a replacement flow across processes', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const claimStartedFile = path.join(directory, 'claim-started');
    await fs.writeFile(stateFile, JSON.stringify({ flowId: 'flow-a' }), 'utf8');

    const coordinatorUrl = pathToFileURL(
      path.join(process.cwd(), 'oauth-state-coordinator.mjs')
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
    await expectAllTicketsCompleted(stateFile);
  });

  it('completes an abandoned ticket even when its slot contains a live reused PID', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const lockDirectory = `${stateFile}.lock`;
    const orphanedId = '00000000-0000-4000-8000-000000000001';
    const orphanedSlot = path.join(lockDirectory, '1.slot');
    await fs.mkdir(lockDirectory, { recursive: true });
    await fs.writeFile(
      orphanedSlot,
      JSON.stringify({
        id: orphanedId,
        ownerPid: process.pid,
        ownerIdentity: 'identity-from-the-previous-process-that-used-this-pid'
      }),
      { encoding: 'utf8', mode: 0o600 }
    );
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(orphanedSlot, staleTime, staleTime);

    await withOAuthStateLock(stateFile, async () => {
      await fs.writeFile(stateFile, JSON.stringify({ flowId: 'recovered-flow' }), 'utf8');
    });

    await expect(fs.readFile(stateFile, 'utf8')).resolves.toContain('recovered-flow');
    await expect(fs.access(orphanedSlot)).resolves.toBeUndefined();
    await expect(fs.access(path.join(lockDirectory, '1.done'))).resolves.toBeUndefined();
    await expectAllTicketsCompleted(stateFile);
  });

  it('does not reclaim a stale-aged ticket while its original process is alive', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const ownerEnteredFile = path.join(directory, 'owner-entered');
    const releaseOwnerFile = path.join(directory, 'release-owner');
    const contenderEnteredFile = path.join(directory, 'contender-entered');
    const coordinatorUrl = pathToFileURL(
      path.join(process.cwd(), 'oauth-state-coordinator.mjs')
    ).href;
    const ownerScript = `
      import fs from 'node:fs';
      import { withOAuthStateLockSync } from ${JSON.stringify(coordinatorUrl)};
      const [stateFile, ownerEnteredFile, releaseOwnerFile] = process.argv.slice(1);
      withOAuthStateLockSync(stateFile, () => {
        fs.writeFileSync(ownerEnteredFile, 'ready');
        while (!fs.existsSync(releaseOwnerFile)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      });
    `;
    const contenderScript = `
      import fs from 'node:fs';
      import { withOAuthStateLockSync } from ${JSON.stringify(coordinatorUrl)};
      const [stateFile, contenderEnteredFile] = process.argv.slice(1);
      withOAuthStateLockSync(stateFile, () => {
        fs.writeFileSync(contenderEnteredFile, 'entered');
      });
    `;

    const owner = spawn(process.execPath, [
      '--input-type=module', '--eval', ownerScript, stateFile, ownerEnteredFile, releaseOwnerFile
    ], { stdio: 'ignore' });
    const ownerExit = new Promise<void>((resolve, reject) => {
      owner.once('error', reject);
      owner.once('exit', code => code === 0 ? resolve() : reject(new Error(`Owner child exited ${code}`)));
    });

    await waitForFile(ownerEnteredFile);
    const ownerSlot = path.join(`${stateFile}.lock`, '1.slot');
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(ownerSlot, staleTime, staleTime);

    const contender = spawn(process.execPath, [
      '--input-type=module', '--eval', contenderScript, stateFile, contenderEnteredFile
    ], { stdio: 'ignore' });
    const contenderExit = new Promise<void>((resolve, reject) => {
      contender.once('error', reject);
      contender.once('exit', code => code === 0
        ? resolve()
        : reject(new Error(`Contender child exited ${code}`)));
    });

    await new Promise(resolve => setTimeout(resolve, 150));
    await expect(fs.access(contenderEnteredFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(releaseOwnerFile, 'release', 'utf8');
    await Promise.all([ownerExit, contenderExit]);

    await expect(fs.access(contenderEnteredFile)).resolves.toBeUndefined();
    await expectAllTicketsCompleted(stateFile);
  });

  it('serializes concurrent processes while they complete the same abandoned ticket', async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = path.join(directory, 'oauth-helper-state.json');
    const counterFile = path.join(directory, 'counter.txt');
    const lockDirectory = `${stateFile}.lock`;
    const orphanedId = '00000000-0000-4000-8000-000000000002';
    const orphanedSlot = path.join(lockDirectory, '1.slot');
    await fs.mkdir(lockDirectory, { recursive: true });
    await fs.writeFile(
      orphanedSlot,
      JSON.stringify({ id: orphanedId, ownerPid: 99_999_999, ownerIdentity: 'dead-owner' }),
      'utf8'
    );
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(orphanedSlot, staleTime, staleTime);
    await fs.writeFile(counterFile, '0', 'utf8');

    const coordinatorUrl = pathToFileURL(
      path.join(process.cwd(), 'oauth-state-coordinator.mjs')
    ).href;
    const childScript = `
      import fs from 'node:fs';
      import { withOAuthStateLockSync } from ${JSON.stringify(coordinatorUrl)};
      const [stateFile, counterFile] = process.argv.slice(1);
      withOAuthStateLockSync(stateFile, () => {
        const value = Number.parseInt(fs.readFileSync(counterFile, 'utf8'), 10);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        fs.writeFileSync(counterFile, String(value + 1));
      });
    `;

    const children = Array.from({ length: 8 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        childScript,
        stateFile,
        counterFile
      ], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', code => code === 0
        ? resolve()
        : reject(new Error(`Recovery child exited ${code}`)));
    }));

    await Promise.all(children);

    await expect(fs.readFile(counterFile, 'utf8')).resolves.toBe('8');
    await expectAllTicketsCompleted(stateFile);
  });
});
