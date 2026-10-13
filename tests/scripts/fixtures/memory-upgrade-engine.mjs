import fs from 'node:fs/promises';
import { MemoryUpgradeOperator } from '../app/dist/lifecycle/MemoryUpgradeOperator.js';
import { MemoryUpgradeLifecycle } from '../app/dist/lifecycle/MemoryUpgradeLifecycle.js';

// Synthetic engine witness only: no app root, clients, payloads or database.
const directory = '/app/.memory-upgrade-control';
const observations = '/app/tmp/engine-observations.jsonl';
const operator = await MemoryUpgradeOperator.prepare(directory);
let lifecycle;
let retained = process.env.OWNED_ENGINE_MODE === 'retained';
if (!operator.controlOnly) {
  lifecycle = new MemoryUpgradeLifecycle();
  lifecycle.registerOwner({
    hasRetainedMemoryWork: () => retained,
    async flushPendingSaves() {
      try { await fs.access('/app/tmp/engine-release'); retained = false; }
      catch { /* Retain the artificial owner until explicit fixture release. */ }
      if (retained) throw new Error('Synthetic owner retained');
    },
  });
  operator.bindLifecycle(lifecycle);
  operator.enableOriginalDrain(); // Synthetic original runtime is now initialized.
}
process.on('SIGUSR2', () => process.exit(17)); // Deliberate isolated restart fault.
process.on('SIGTERM', () => {
  void (async () => {
    // Explicit disposable-fixture cleanup is not a production drain authority.
    // There is never accepted app data in this command-override witness.
    try { await fs.access('/app/tmp/engine-disposable-cleanup'); process.exit(0); }
    catch { /* Ordinary tested path must meet the actual lifecycle boundary. */ }
    try {
      if (lifecycle) await lifecycle.quiesceAndDrain(1000);
      await operator.closeAfterDrain();
      process.exit(0);
    } catch { /* Refusal keeps the original process/listener alive. */ }
  })();
});
await operator.listen();
await fs.appendFile(observations, `${JSON.stringify({ bootId: operator.bootId,
  controlOnly: operator.controlOnly, startup: operator.startup.kind,
  syntheticRootConstructed: Boolean(lifecycle) })}\n`);
