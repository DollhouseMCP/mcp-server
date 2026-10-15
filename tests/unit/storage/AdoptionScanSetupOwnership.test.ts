import { expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// New outer observation bound; the imported actual suite retains every 10s bound.
it.each(['fail-fast', 'setup-timeout', 'blocked'])(
  'owns actual EOF setup sibling promises and preserves %s failure', async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eof-owned-'));
    try {
      const require = createRequire(import.meta.url);
      const result = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--config', 'tests/jest.config.cjs',
        '--runInBand', '--no-coverage', '--testMatch', '**/eofSetupOwnership.fixture.ts',
        '--testNamePattern', 'EOF census fixture|controlled next', '--json', '--outputFile', path.join(root, 'result.json')], {
        cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: root,
          NODE_OPTIONS: '--experimental-vm-modules --no-warnings', EOF_SETUP_PROOF_ROOT: root, EOF_SETUP_PROOF_MODE: mode },
        encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024,
      });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
      const report = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
      const cases = report.testResults[0].assertionResults.filter((item: { fullName: string }) =>
        /EOF census fixture|controlled next/.test(item.fullName));
      expect(cases.map((item: { status: string }) => item.status)).toEqual(['failed', mode === 'blocked' ? 'failed' : 'passed']);
      const firstFailure = cases[0].failureMessages.join('\n');
      if (mode === 'setup-timeout') expect(firstFailure).toContain('Exceeded timeout of 10000 ms for a hook');
      else {
        expect(firstFailure).toContain('undefined');
        expect(firstFailure).not.toContain('Exceeded timeout'); // First write failure stays fail-fast.
      }
      const receipt = JSON.parse(await fs.readFile(path.join(root, 'receipt.json'), 'utf8'));
      expect(receipt).toMatchObject({ writes: 4096, settled: 4096, cleanupBeforeSettlement: false,
        rejected: mode === 'setup-timeout' ? 0 : 1, removals: mode === 'blocked' ? 0 : 1,
        nextEntered: mode !== 'blocked', rootRetained: mode === 'blocked', observer: mode === 'blocked' ? 'retained' : 'original' });
      const summaries = result.stderr.split('\n').filter(line => line.includes('ADOPTION fixture cleanup '))
        .map(line => JSON.parse(line.split('ADOPTION fixture cleanup ')[1]));
      if (mode === 'blocked') {
        expect(cases[1].failureMessages.join('\n')).toContain('Previous storage case has not completed safe cleanup');
        expect(firstFailure).toContain('safe cleanup not established');
        expect(summaries.filter((item: { phase: string }) => item.phase === 'write-drain-end')).toHaveLength(0);
        expect(summaries).toContainEqual({ phase: 'teardown-returned', writes: 4096, roots: 1 });
      } else {
        expect(receipt.events.indexOf('sibling-settled-with-resources')).toBeLessThan(receipt.events.indexOf('root-cleanup'));
        expect(receipt.events.indexOf('root-cleanup')).toBeLessThan(receipt.events.indexOf('next-case'));
      }
      process.stderr.write(`EOF ownership receipt ${JSON.stringify(receipt)}\n`);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 30000);
