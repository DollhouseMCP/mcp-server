import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modelPythonCommand } from '../../helpers/modelPythonCommand.js';

// The actual helper executes in one synchronous, bounded Python process. Its
// clock and CLI are faked; this creates no Docker/CLI/application descendants.
describe('hosted graceful-stop observation cadence', () => {
  it('observes delayed clean closure and retains deadline, authority and inspect bounds', () => {
    const result = spawnSync(modelPythonCommand(process.platform, process.arch, process.env), [
      fileURLToPath(new URL('./fixtures/hosted_graceful_stop_polling.py', import.meta.url)),
      fileURLToPath(new URL('../../../scripts/hosted-graceful-stop.py', import.meta.url)),
    ], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
    try {
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 0, stdout: '', stderr: expect.stringContaining('OK'),
      });
    } catch (error) {
      try {
        const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
        const signal = result.signal;
        const count = (value: unknown) => typeof value === 'string' ? Math.min(value.length, 64 * 1024) : null;
        const stderrTail = typeof result.stderr === 'string' ? result.stderr.slice(-256) : '';
        const errorCategory = () => {
          if (result.error === undefined) return 'none';
          if (['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES', 'EPERM'].includes(code ?? '')) return code;
          return 'other';
        };
        const statusCategory = () => {
          if (result.status === 0) return 'zero';
          if (typeof result.status === 'number' && Number.isSafeInteger(result.status)) return 'nonzero';
          return 'unknown';
        };
        const signalCategory = () => {
          if (signal === null) return 'none';
          if (['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV'].includes(signal ?? '')) return signal;
          return 'other';
        };
        const unittestCategory = () => {
          if (/(?:^|\n)OK\r?\n?$/.test(stderrTail)) return 'ok';
          if (/(?:^|\n)FAILED \((?:failures|errors)=\d+(?:, (?:failures|errors|skipped)=\d+)*\)\r?\n?$/.test(stderrTail)) return 'failed';
          return 'unknown';
        };
        console.error('[hosted-stop-polling:returned-failure]', JSON.stringify({
          error: errorCategory(),
          status: statusCategory(),
          signal: signalCategory(),
          stdoutCodeUnitsCapped: count(result.stdout), stderrCodeUnitsCapped: count(result.stderr),
          unittest: unittestCategory(),
        }));
      } catch { /* Evidence failure cannot replace the original assertion failure. */ }
      throw error;
    }
  });
});
