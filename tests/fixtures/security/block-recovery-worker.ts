import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { FileDangerZoneBlockStore } from '../../../src/state/FileDangerZoneBlockStore.js';

async function waitUntil(check: () => Promise<boolean>, deadline: number, message: string): Promise<void> {
  if (await check()) return;
  assert.ok(performance.now() < deadline, message);
  await delay(20);
  return waitUntil(check, deadline, message);
}

const [directory, index] = process.argv.slice(2);
const [own, peer] = index === '0' ? ['first', 'second'] : ['second', 'first'];
const enforcer = new DangerZoneEnforcer(new FileDangerZoneBlockStore(new FileOperationsService(new FileLockManager()), directory));
try {
  await enforcer.initialize();
  assert.match((await enforcer.check('unlisted')).reason ?? '', /unavailable/);
  assert.equal(await enforcer.block(own, 'Requires review', []), false);
  await fs.writeFile(path.join(homedir(), 'ready'), '');

  // Listing does not request a refresh. Only background recovery can restore this block.
  await waitUntil(async () => (await enforcer.getBlockedAgents()).includes('stored'),
    performance.now() + 4_000, 'Expected automatic recovery');
  await waitUntil(async () => (await enforcer.check(peer)).reason === 'Requires review',
    performance.now() + 2_000, 'Expected the other process’s block to be visible');
  await Promise.all([own, peer, 'stored'].map(async name => {
    assert.equal((await enforcer.check(name)).reason, 'Requires review');
  }));
  assert.equal((await enforcer.check('unlisted')).blocked, false);
} finally {
  await enforcer.shutdown();
}
