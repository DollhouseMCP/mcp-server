import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The actual helper executes in one synchronous, bounded Python process. Its
// clock and CLI are faked; this creates no Docker/CLI/application descendants.
describe('hosted graceful-stop observation cadence', () => {
  it('observes delayed clean closure and retains deadline, authority and inspect bounds', () => {
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [
      fileURLToPath(new URL('./fixtures/hosted_graceful_stop_polling.py', import.meta.url)),
      fileURLToPath(new URL('../../../scripts/hosted-graceful-stop.py', import.meta.url)),
    ], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0, stdout: '', stderr: expect.stringContaining('OK'),
    });
  });
});
