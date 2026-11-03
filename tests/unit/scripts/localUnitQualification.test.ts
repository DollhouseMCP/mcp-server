import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { checkCoreSchedule, checkPartition, checkResult, explicitJestArgs, serialGroups } from '../../../scripts/ci/local-unit-qualification-jest.mjs';
import { OwnedFixtureRegistry } from '../../helpers/ownedFixtureProcess.js';

const serial = serialGroups.flatMap(([, files]) => files);
const ordinary = ['tests/unit/example.test.ts', 'tests/unit/example.spec.ts'];
const inventory = [...serial, ...ordinary];

describe('complete local unit qualification admission and evidence', () => {
  it('matches the actual mandatory Core serial commands and refuses drift', () => {
    const workflow = readFileSync('.github/workflows/core-build-test.yml', 'utf8');
    expect(() => checkCoreSchedule(workflow)).not.toThrow();
    expect(() => checkCoreSchedule(workflow.replace('run: npm test -- --runInBand --runTestsByPath tests/unit/storage/FileMemoryOwnedRename.test.ts',
      'run: npm test -- --runTestsByPath tests/unit/storage/FileMemoryOwnedRename.test.ts'))).toThrow('differs');
  });

  it('requires a disjoint complete discovered inventory including spec files', () => {
    expect(() => checkPartition(inventory, [[ordinary[0]], [ordinary[1]]])).not.toThrow();
    expect(() => checkPartition(inventory, [[ordinary[0]], [ordinary[0], ordinary[1]]])).toThrow('Duplicate');
    expect(() => checkPartition(inventory, [[ordinary[0]], ['tests/unit/extra.test.ts']])).toThrow('union');
    expect(() => checkPartition(inventory.filter(file => file !== serial[0]), [[ordinary[0]], [ordinary[1]]])).toThrow('union');
    expect(() => checkPartition(inventory, [[ordinary[0]]])).toThrow('Both ordinary');
  });

  function report(statuses = ['passed', 'pending', 'todo']) {
    return { success: true, numFailedTests: 0, numFailedTestSuites: 0, numRuntimeErrorTestSuites: 0,
      numPassedTests: 1, numPendingTests: 1, numTodoTests: 1, numTotalTests: 3, numTotalTestSuites: 1,
      testResults: [{ name: path.resolve(ordinary[0]), status: 'focused', assertionResults: statuses.map(status => ({ status })) }] };
  }

  it('retains pending/todo separately and refuses failed, missing or fabricated results', () => {
    expect(checkResult(report(), [ordinary[0]], 0)).toEqual({ passed: 1, pending: 1, todo: 1, suites: 1 });
    expect(() => checkResult(report(), [ordinary[0]], 1)).toThrow('subprocess');
    expect(() => checkResult({ ...report(), success: false }, [ordinary[0]], 0)).toThrow('not successful');
    expect(() => checkResult({ ...report(), numFailedTests: 1 }, [ordinary[0]], 0)).toThrow();
    expect(() => checkResult({ ...report(), testResults: [] }, [ordinary[0]], 0)).toThrow('empty');
    expect(() => checkResult(report(), [ordinary[1]], 0)).toThrow('suite result');
    expect(() => checkResult(report(['passed', 'failed', 'todo']), [ordinary[0]], 0)).toThrow('assertion');
    expect(() => checkResult({ ...report(), numPassedTests: 99 }, [ordinary[0]], 0)).toThrow('count');
    const duplicate = report(); duplicate.testResults.push(duplicate.testResults[0]);
    expect(() => checkResult(duplicate, [ordinary[0]], 0)).toThrow('Duplicate');
  });

  it('forwards explicit Jest selections/options without changing their execution contract', () => {
    const args = ['--runInBand', '--runTestsByPath', serial[0], '--testNamePattern', 'exact test'];
    expect(explicitJestArgs(args).slice(3)).toEqual(args);
  });

  // Windows forcibly terminates a PID on SIGTERM rather than delivering this
  // catchable POSIX signal. This control exercises actual POSIX signal delivery.
  (process.platform === 'win32' ? it.skip : it)('settles a parent-only SIGTERM child before refusing subsequent admission', async () => {
    const registry = new OwnedFixtureRegistry();
    await registry.run(async fixture => {
      const child = fixture.spawn(process.execPath, ['tests/unit/scripts/fixtures/localUnitCancellation.fixture.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', diagnostics = '', childPid = 0;
      let acknowledge!: () => void;
      const ready = new Promise<void>(resolve => { acknowledge = resolve; });
      child.stdout!.on('data', chunk => {
        output = (output + String(chunk)).slice(0, 4096);
        const match = /^CHILD_READY (\d+)\n/u.exec(output);
        if (match) { childPid = Number(match[1]); acknowledge(); }
      });
      child.stderr!.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(0, 4096); });
      const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
      });
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([ready, closed.then(() => { throw new Error(`Cancellation fixture exited before readiness: ${diagnostics}`); }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation fixture did not become ready')), 2500); })]);
        clearTimeout(timer);
        expect(child.kill('SIGTERM')).toBe(true); // Signal only the wrapper PID.
        const result = await Promise.race([closed, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Cancellation fixture did not settle')), 2500);
        })]);
        expect(result).toEqual({ code: 1, signal: null });
        expect(output).toBe(`CHILD_READY ${childPid}\nCHILD_SETTLED\nPARENT_OBSERVED_CLOSE_AND_REJECTED\nNEXT_ADMISSION_REFUSED\n`);
        expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      } finally { clearTimeout(timer); }
    });
    registry.assertSettled();
  });
});
