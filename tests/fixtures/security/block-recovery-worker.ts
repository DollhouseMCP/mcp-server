import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { FileDangerZoneBlockStore } from '../../../src/state/FileDangerZoneBlockStore.js';

const [directory, index] = process.argv.slice(2);
const [own, peer] = index === '0' ? ['first', 'second'] : ['second', 'first'];
const enforcer = new DangerZoneEnforcer(new FileDangerZoneBlockStore(new FileOperationsService(new FileLockManager()), directory));
try {
  await enforcer.initialize();
  assert.match((await enforcer.check('unlisted')).reason ?? '', /unavailable/);
  assert.equal(await enforcer.block(own, 'Requires review', []), false);
  await fs.writeFile(path.join(homedir(), 'ready'), '');

  // Listing does not request a refresh. Only background recovery can restore this block.
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await enforcer.getBlockedAgents()).includes('stored')) break;
    await delay(20);
  }
  assert.ok((await enforcer.getBlockedAgents()).includes('stored'), 'Expected automatic recovery');
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await enforcer.check(peer)).reason === 'Requires review') break;
    await delay(20);
  }
  for (const name of [own, peer, 'stored']) {
    assert.equal((await enforcer.check(name)).reason, 'Requires review');
  }
  assert.equal((await enforcer.check('unlisted')).blocked, false);
} finally {
  await enforcer.shutdown();
}
