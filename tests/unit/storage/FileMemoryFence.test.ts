import { afterEach, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence, FileMemoryFenceTimeoutError } from '../../../src/storage/FileMemoryFence.js';

const sourceExtension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
const childModuleUrl = new URL(`../../../src/storage/FileMemoryFence.${sourceExtension}`, import.meta.url).href;
const childScript = `
  import { FileMemoryFence } from ${JSON.stringify(childModuleUrl)};
  const [tenantRoot, memoryLocator] = process.argv.slice(1);
  try {
    await new FileMemoryFence().withFence({ tenantRoot, memoryLocator }, async () => {
      process.stdout.write('READY\\n');
      process.stdin.resume();
      await new Promise(resolve => process.stdin.once('end', resolve));
    });
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\\n');
    process.exitCode = 1;
  }
`;
const temporaryRoots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

async function root(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'file-memory-fence-'));
  temporaryRoots.push(directory);
  return directory;
}

function childExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
}

async function holdingChild(tenantRoot: string, memoryLocator = 'notes/example.yaml'):
Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', childScript, tenantRoot, memoryLocator,
  ], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let output = '';
    let errors = '';
    const timeout = setTimeout(() => reject(new Error(`Child did not acquire fence: ${errors}`)), 5_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('READY\n')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Child exited ${code}: ${errors}`)); });
  });
  return child;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await childExit(child);
    }
  }
  for (const directory of temporaryRoots.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('FileMemoryFence local POSIX primitive', () => {
  if (process.platform === 'win32') {
    it('fails closed on a platform without POSIX mode and owner checks', async () => {
      await expect(new FileMemoryFence().withFence({ tenantRoot: 'C:\\', memoryLocator: 'a.yaml' }, () => 1))
        .rejects.toThrow('requires POSIX');
    });
    return;
  }

  it('excludes a separate process and canonical dot alias, then releases', async () => {
    const tenantRoot = await root();
    const child = await holdingChild(tenantRoot);
    const fence = new FileMemoryFence();
    const [lockName] = await fs.readdir(path.join(tenantRoot, '.memory-fences'));
    expect(lockName).toBe(`${createHash('sha256').update('notes/example.yaml').digest('hex')}.lock`);
    await expect(fence.withFence(
      { tenantRoot, memoryLocator: 'notes/./example.yaml' }, () => 'contended', { timeoutMs: 80 },
    )).rejects.toBeInstanceOf(FileMemoryFenceTimeoutError);
    const rootAlias = `${tenantRoot}-alias`;
    await fs.symlink(tenantRoot, rootAlias);
    try {
      await expect(fence.withFence(
        { tenantRoot: rootAlias, memoryLocator: 'notes/example.yaml' }, () => 'contended', { timeoutMs: 80 },
      )).rejects.toBeInstanceOf(FileMemoryFenceTimeoutError);
    } finally {
      await fs.unlink(rootAlias);
    }
    const mutableTarget = { tenantRoot, memoryLocator: 'notes/example.yaml' };
    const pending = fence.withFence(mutableTarget, () => 'contended', { timeoutMs: 80 });
    mutableTarget.memoryLocator = 'notes/other.yaml';
    await expect(pending).rejects.toBeInstanceOf(FileMemoryFenceTimeoutError);
    child.stdin.end();
    await expect(childExit(child)).resolves.toBe(0);
    await expect(fence.withFence({ tenantRoot, memoryLocator: 'notes/example.yaml' }, () => 'done'))
      .resolves.toBe('done');
    expect(await fs.readdir(path.join(tenantRoot, '.memory-fences'))).toHaveLength(0);
  });

  it('leaves a crashed process lease fail closed until quiesced manual recovery', async () => {
    const tenantRoot = await root();
    const child = await holdingChild(tenantRoot);
    child.kill('SIGKILL');
    await childExit(child);
    const fence = new FileMemoryFence();
    await expect(fence.withFence(
      { tenantRoot, memoryLocator: 'notes/example.yaml' }, () => undefined, { timeoutMs: 50 },
    )).rejects.toBeInstanceOf(FileMemoryFenceTimeoutError);
    const [lockName] = await fs.readdir(path.join(tenantRoot, '.memory-fences'));
    const lockPath = path.join(tenantRoot, '.memory-fences', lockName);
    await fs.unlink(path.join(lockPath, 'owner'));
    await expect(fence.withFence(
      { tenantRoot, memoryLocator: 'notes/example.yaml' }, () => undefined, { timeoutMs: 50 },
    )).rejects.toBeInstanceOf(FileMemoryFenceTimeoutError);
  });

  it('releases after a callback error and keeps that error if release also fails', async () => {
    const tenantRoot = await root();
    const fence = new FileMemoryFence();
    const target = { tenantRoot, memoryLocator: 'notes/example.yaml' };
    const original = new Error('operation failed');
    await expect(fence.withFence(target, () => { throw original; })).rejects.toBe(original);
    await expect(fence.withFence(target, () => 'retry')).resolves.toBe('retry');

    let lockPath = '';
    await expect(fence.withFence(target, async () => {
      const [lockName] = await fs.readdir(path.join(tenantRoot, '.memory-fences'));
      lockPath = path.join(tenantRoot, '.memory-fences', lockName);
      await fs.writeFile(path.join(lockPath, 'owner'), 'another-owner');
      throw original;
    })).rejects.toMatchObject({ cause: original, errors: expect.arrayContaining([original]) });
    expect(await fs.stat(lockPath)).toBeDefined();
  });

  it('uses private directory and owner modes and rejects unsafe aliases', async () => {
    const tenantRoot = await root();
    const fence = new FileMemoryFence();
    await fence.withFence({ tenantRoot, memoryLocator: 'notes/example.yaml' }, async () => {
      const fenceRoot = path.join(tenantRoot, '.memory-fences');
      const [lockName] = await fs.readdir(fenceRoot);
      const lockPath = path.join(fenceRoot, lockName);
      expect((await fs.stat(fenceRoot)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(lockPath, 'owner'))).mode & 0o777).toBe(0o600);
    });
    await fs.mkdir(path.join(tenantRoot, 'notes'));
    await fs.symlink(path.join(tenantRoot, 'notes'), path.join(tenantRoot, 'alias'));
    await fs.writeFile(path.join(tenantRoot, 'notes', 'original.yaml'), 'head');
    await fs.link(path.join(tenantRoot, 'notes', 'original.yaml'), path.join(tenantRoot, 'notes', 'linked.yaml'));
    for (const memoryLocator of ['Alias/a.yaml', 'café.yaml', '../escape.yaml', 'alias/a.yaml']) {
      await expect(fence.withFence({ tenantRoot, memoryLocator }, () => 1)).rejects.toThrow();
    }
    await expect(fence.withFence({ tenantRoot, memoryLocator: 'notes/linked.yaml' }, () => 1))
      .rejects.toThrow('hard-linked');
    await expect(fence.withFence({ tenantRoot, memoryLocator: 'a.yaml' }, () => 1, { timeoutMs: Infinity }))
      .rejects.toBeInstanceOf(RangeError);

    const anotherRoot = await root();
    await fs.symlink(path.join(tenantRoot, 'notes'), path.join(anotherRoot, '.memory-fences'));
    await expect(fence.withFence({ tenantRoot: anotherRoot, memoryLocator: 'a.yaml' }, () => 1))
      .rejects.toThrow('private, non-symlink');
  });
});
