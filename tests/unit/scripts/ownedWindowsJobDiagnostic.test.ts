import { describe, expect, it, jest } from '@jest/globals';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { OwnedWindowsJob } from '../../helpers/ownedWindowsJob.js';

// Protocol controls only: these do not execute Windows Job Object APIs.
function fixture() {
  const job = new OwnedWindowsJob(tmpdir());
  const child = { pid: 123, kill: jest.fn() } as unknown as ChildProcess;
  const token = job.environment().OWNED_FIXTURE_JOB_TOKEN;
  const acknowledged = jest.fn();
  const observe = (line: string) => job.observe(Buffer.from(line), child, acknowledged);
  return { job, child, token, acknowledged, observe };
}

describe('owned Windows first-failure diagnostic protocol', () => {
  it('accepts only safe bound fields, with no proof effect and no exposed nonce/PID', async () => {
    const { job, child, token, acknowledged, observe } = fixture();
    const detail = `OWNED_FIXTURE_JOB_DETAIL ${token} 123 finish normal-members -1 2 2 -1\n`;
    observe(detail.slice(0, 50)); observe(detail.slice(50));
    expect(job.failureDetail()).toBeUndefined();
    expect(acknowledged).not.toHaveBeenCalled();
    observe(`OWNED_FIXTURE_JOB_PROOF_FAILED ${token} 123\n`);
    await expect(job.wait(performance.now() + 2500, child)).rejects.toThrow('refused descendant settlement');
    expect(job.failureDetail()).toEqual({ origin: 'finish', stage: 'normal-members', error: null, assigned: 2, listed: 2, active: null });
    expect(JSON.stringify(job.failureDetail())).not.toContain(token);
    expect(Object.keys(job.failureDetail()!)).toEqual(['origin', 'stage', 'error', 'assigned', 'listed', 'active']);
  });

  it('keeps first detail/failure sticky, including invalidation after an earlier ACK', async () => {
    const { job, child, token, acknowledged, observe } = fixture();
    observe(`OWNED_FIXTURE_JOB_QUIESCENT ${token} 123\n`);
    await job.wait(performance.now() + 2500, child);
    observe(`OWNED_FIXTURE_JOB_DETAIL ${token} 123 monitor process-wait-after 4294967295 1 1 1\n`);
    observe(`OWNED_FIXTURE_JOB_PROOF_FAILED ${token} 123\n`);
    observe(`OWNED_FIXTURE_JOB_DETAIL ${token} 123 finish job-close 5 -1 -1 -1\n`);
    observe(`OWNED_FIXTURE_JOB_QUIESCENT ${token} 123\n`);
    const first = job.failureDetail()!; first.stage = 'changed-by-caller';
    expect(job.failureDetail()).toEqual({ origin: 'monitor', stage: 'process-wait-after', error: 4294967295, assigned: 1, listed: 1, active: 1 });
    await expect(job.wait(performance.now() + 2500, child)).rejects.toThrow('refused descendant settlement');
    expect(acknowledged).toHaveBeenCalledTimes(1);
  });

  it.each([
    'wrong-nonce 123 finish normal-members -1 1 1 1',
    '$TOKEN 124 finish normal-members -1 1 1 1',
    '$TOKEN 0123 finish normal-members -1 1 1 1',
    '$TOKEN 123 unknown normal-members -1 1 1 1',
    '$TOKEN 123 finish unknown -1 1 1 1',
    '$TOKEN 123 finish normal-members -1 1 1',
    '$TOKEN 123 finish normal-members -1 1 1 1 extra',
    '$TOKEN 123 finish normal-members NaN 1 1 1',
    '$TOKEN 123 finish normal-members 5 1 1 1',
    '$TOKEN 123 finish normal-members -2 1 1 1',
    '$TOKEN 123 finish normal-members 4294967296 1 1 1',
    '$TOKEN 123 finish normal-members 01 1 1 1',
    '$TOKEN 123 finish normal-members 1e2 1 1 1',
    '$TOKEN 123 finish normal-members 1 1\t1 1',
    '$TOKEN 123 finish normal-members 1 1 1 1 ',
    '$TOKEN 123 finish normal-members -1 1 1 ' + '9'.repeat(260),
  ])('ignores malformed/untrusted detail (%#) without hiding original refusal', async fields => {
    const { job, child, token, acknowledged, observe } = fixture();
    observe(`OWNED_FIXTURE_JOB_DETAIL ${fields.replace('$TOKEN', token)}\n`);
    observe(`OWNED_FIXTURE_JOB_PROOF_FAILED ${token} 123\n`);
    await expect(job.wait(performance.now() + 2500, child)).rejects.toThrow('refused descendant settlement');
    expect(job.failureDetail()).toBeUndefined();
    expect(acknowledged).not.toHaveBeenCalled();
  });

  it('ignores truncated/multiline detail and preserves ordinary ACK and detail-free refusal', async () => {
    const { job, child, token, acknowledged, observe } = fixture();
    observe(`OWNED_FIXTURE_JOB_DETAIL ${token} 123 finish normal-members -1 1\n1 1\n`);
    observe(`OWNED_FIXTURE_JOB_DETAIL ${token} 123 finish normal-members -1 1 1`); // No newline/frame completion.
    expect(job.failureDetail()).toBeUndefined();
    observe('\n'); // Still a truncated nine-field schema.
    observe(`OWNED_FIXTURE_JOB_QUIESCENT ${token} 123\n`);
    await job.wait(performance.now() + 2500, child);
    expect(acknowledged).toHaveBeenCalledTimes(1);
    observe(`OWNED_FIXTURE_JOB_PROOF_FAILED ${token} 123\n`);
    await expect(job.wait(performance.now() + 2500, child)).rejects.toThrow('refused descendant settlement');
    expect(job.failureDetail()).toBeUndefined();
  });

  it('fits the largest permitted full frame within the original 256-character bound', () => {
    const { job, token, observe } = fixture();
    const line = `OWNED_FIXTURE_JOB_DETAIL ${token} 123 monitor process-member-query 4294967295 4294967295 4294967295 4294967295\n`;
    expect(line.replace(' 123 ', ' 4294967295 ').length).toBeLessThanOrEqual(256);
    observe(line);
    observe(`OWNED_FIXTURE_JOB_PROOF_FAILED ${token} 123\n`);
    expect(job.failureDetail()?.assigned).toBe(4294967295);
  });
});
