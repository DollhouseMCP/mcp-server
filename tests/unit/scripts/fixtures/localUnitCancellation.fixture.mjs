import { UnitSubprocessOwner } from '../../../../scripts/ci/local-unit-qualification-jest.mjs';

const owner = new UnitSubprocessOwner();
try {
  await owner.runNode(['-e', String.raw`
    process.on('SIGTERM', () => setTimeout(() => {
      process.stdout.write('CHILD_SETTLED\n'); process.exit(0);
    }, 100));
    process.stdout.write('CHILD_READY '+process.pid+'\n');
    setInterval(() => {}, 1000);
  `]);
  throw new Error('Interrupted child returned as success');
} catch (error) {
  if (!owner.interrupted) throw error;
  process.stdout.write('PARENT_OBSERVED_CLOSE_AND_REJECTED\n');
  try { await owner.runNode(['-e', "process.stdout.write('FORBIDDEN_NEXT_CHILD')"]); }
  catch { process.stdout.write('NEXT_ADMISSION_REFUSED\n'); }
  process.exitCode = 1;
} finally { owner.dispose(); }
