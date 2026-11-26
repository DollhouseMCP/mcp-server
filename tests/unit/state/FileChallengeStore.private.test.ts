import { expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { FileChallengeStore } from '../../../src/state/FileChallengeStore.js';

it('stores only a keyed verifier and consumes it after restarting with a rotated key', async () => {
  const state = await fs.mkdtemp(path.join(tmpdir(), 'private-challenge-'));
  const originalKey = { keyId: 'test', key: Buffer.alloc(32, 0x1e) };
  const keys = { resolve: async () => originalKey };
  const rotatedKeys = {
    resolve: async () => ({ keyId: 'rotated', key: Buffer.alloc(32, 0x2e) }),
    resolveForKeyId: async (keyId: string) => keyId === originalKey.keyId ? originalKey : null,
  };
  const ops = new FileOperationsService(new FileLockManager());
  const session = 'private-challenge-test';
  const code = 'SYNTHETIC-VERIFICATION';
  const first = new FileChallengeStore(ops, keys, state, session, 0);
  const second = new FileChallengeStore(ops, rotatedKeys, state, session, 0);
  try {
    await first.initialize();
    first.set('one', { code, expiresAt: Date.now() + 60_000, reason: 'review' });
    await first.awaitPendingWrites();
    const filename = path.join(state, `challenges-${session}.json`);
    const bytes = await fs.readFile(filename, 'utf8');
    expect(bytes).not.toContain(code);
    expect(JSON.parse(bytes)).toMatchObject({
      version: 2,
      challenges: [['one', expect.objectContaining({ verifier: expect.stringMatching(/^[a-f0-9]{64}$/u) })]],
    });
    if (process.platform !== 'win32') expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);

    await second.initialize();
    expect(second.get('one')).toMatchObject({ reason: 'review' });
    expect(second.get('one')).not.toHaveProperty('code');
    expect(second.verify('one', code)).toBe(true);
    expect(second.verify('one', code)).toBe(false);
    await second.awaitPendingWrites();
    expect(JSON.parse(await fs.readFile(filename, 'utf8')).challenges).toEqual([]);
  } finally {
    await Promise.all([first.awaitPendingWrites(), second.awaitPendingWrites()]);
    first.destroy();
    second.destroy();
    await fs.rm(state, { force: true, recursive: true });
  }
});

it('restores dialog-only requests without accepting any legacy code or an edited request', async () => {
  const state = await fs.mkdtemp(path.join(tmpdir(), 'dialog-challenge-'));
  const keys = { resolve: async () => ({ keyId: 'test', key: Buffer.alloc(32, 0x1e) }) };
  const ops = new FileOperationsService(new FileLockManager());
  const session = 'dialog-challenge-test';
  const store = new FileChallengeStore(ops, keys, state, session, 0);
  const restored = new FileChallengeStore(ops, keys, state, session, 0);
  const tampered = new FileChallengeStore(ops, keys, state, session, 0);
  try {
    const request = { dialog: true as const, expiresAt: Date.now() + 60_000, reason: 'Review the next action' };
    await store.initialize();
    store.set('dialog', request);
    await store.awaitPendingWrites();
    const filename = path.join(state, `challenges-${session}.json`);
    const onDisk = JSON.parse(await fs.readFile(filename, 'utf8'));
    expect(onDisk.challenges[0][1]).not.toHaveProperty('code');
    await restored.initialize();
    expect(restored.verify('dialog', 'anything')).toBe(false);
    expect(restored.get('dialog')).toEqual(request);

    onDisk.challenges[0][1].reason = 'Edited after issuance';
    await fs.writeFile(filename, JSON.stringify(onDisk));
    await tampered.initialize();
    expect(tampered.get('dialog')).toBeUndefined();
  } finally {
    store.destroy();
    restored.destroy();
    tampered.destroy();
    await fs.rm(state, { force: true, recursive: true });
  }
});
