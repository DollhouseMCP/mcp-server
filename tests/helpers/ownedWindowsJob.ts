/** Nonce-bound proof from the existing anonymous Windows fixture Job Object. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ChildProcess } from 'node:child_process';

const failureStages = new Set(['setup', 'exception', 'members-query', 'members-counts', 'members-identity',
  'active-query', 'process-open', 'process-member-query', 'process-member-guard', 'process-wait-before',
  'process-wait-result', 'process-terminate', 'process-wait-after', 'process-wait-timeout', 'process-close',
  'normal-members', 'fence-set', 'fence-query', 'fence-flags', 'fence-breakaway', 'fence-limit',
  'settlement-budget', 'disarm-set', 'disarm-query', 'disarm-flags', 'disarm-limit', 'job-close']);
const apiFailureStages = new Set(['members-query', 'active-query', 'process-open', 'process-member-query',
  'process-wait-before', 'process-terminate', 'process-wait-after', 'process-close',
  'fence-set', 'fence-query', 'disarm-set', 'disarm-query', 'job-close']);
export type WindowsJobFailureDetail = {
  origin: 'finish' | 'monitor'; stage: string; error: number | null;
  assigned: number | null; listed: number | null; active: number | null;
};

export class OwnedWindowsJob {
  private readonly token = randomUUID();
  private readonly cancelFile: string;
  private resolveProof!: () => void;
  private rejectProof!: (error: Error) => void;
  private readonly proof = new Promise<void>((resolve, reject) => { this.resolveProof = resolve; this.rejectProof = reject; });
  private failure?: Error;
  private detail?: WindowsJobFailureDetail;
  private proved = false;
  private requested = false;
  private tail = '';
  private dropping = false;
  private timer?: NodeJS.Timeout;

  constructor(directory: string) {
    this.cancelFile = join(directory, `.owned-job-cancel-${this.token}`);
    void this.proof.catch(() => {}); // Keep the original rejected proof for wait().
  }

  failureDetail(): WindowsJobFailureDetail | undefined {
    return this.failure && this.detail ? { ...this.detail } : undefined;
  }

  environment(): Record<string, string> {
    return { OWNED_FIXTURE_CANCEL_FILE: this.cancelFile, OWNED_FIXTURE_JOB_TOKEN: this.token };
  }

  observe(chunk: Buffer, child: ChildProcess, onProof: () => void): void {
    for (const character of chunk.toString('utf8')) {
      if (character === '\n') {
        if (!this.dropping) this.line(this.tail.replace(/\r$/, ''), child, onProof);
        this.tail = ''; this.dropping = false;
      } else if (!this.dropping) {
        this.tail += character;
        if (this.tail.length > 256) { this.tail = ''; this.dropping = true; }
      }
    }
  }

  requestCancellation(child: ChildProcess, deadline: number): void {
    if (!this.requested) {
      writeFileSync(this.cancelFile, 'cancel\n', { flag: 'wx', mode: 0o600 });
      this.requested = true;
      this.arm(deadline, child);
      void this.proof.then(() => {
        try { child.kill('SIGKILL'); } // Exact launcher handle, only after proof.
        catch (error) { this.fail(error as Error); }
      }, () => {});
    }
  }

  async wait(deadline: number, child: ChildProcess): Promise<void> {
    if (this.failure) throw this.failure;
    this.arm(deadline, child);
    try { await this.proof; if (this.failure) throw this.failure; }
    finally { if (this.proved) clearTimeout(this.timer); }
  }

  private line(line: string, child: ChildProcess, onProof: () => void): void {
    if (line.startsWith('OWNED_FIXTURE_JOB_DETAIL ')) {
      this.readDetail(line, child);
      return; // Diagnostic detail can never authorize or invalidate a proof.
    }
    if (line.startsWith('OWNED_FIXTURE_JOB_PROOF_FAILED ')) {
      const expected = `OWNED_FIXTURE_JOB_PROOF_FAILED ${this.token} ${child.pid}`;
      this.fail(new Error(line === expected
        ? 'Owned Windows job refused descendant settlement'
        : 'Owned Windows job failure has the wrong nonce or launcher identity'));
      return; // Invalidate even a previously resolved quiescence promise.
    }
    if (!line.startsWith('OWNED_FIXTURE_JOB_QUIESCENT ')) return;
    if (line !== `OWNED_FIXTURE_JOB_QUIESCENT ${this.token} ${child.pid}`) {
      this.fail(new Error('Owned Windows job proof has the wrong nonce or launcher identity')); return;
    }
    if (this.proved || this.failure) return;
    this.proved = true;
    clearTimeout(this.timer);
    onProof(); this.resolveProof();
  }

  private readDetail(line: string, child: ChildProcess): void {
    if (this.detail) return; // Retain the first valid bound detail across later failures/ACKs.
    const fields = line.split(' ');
    if (fields.length !== 9 || fields[1] !== this.token || fields[2] !== String(child.pid) ||
        !['finish', 'monitor'].includes(fields[3]) || !failureStages.has(fields[4])) return;
    if (fields[5] !== '-1' && !apiFailureStages.has(fields[4])) return; // Never label a logical guard with an API error.
    const numbers = fields.slice(5);
    if (numbers.some(value => !/^(?:-1|0|[1-9]\d{0,9})$/.test(value) || Number(value) > 0xffffffff)) return;
    const [error, assigned, listed, active] = numbers.map(value => value === '-1' ? null : Number(value));
    this.detail = { origin: fields[3] as 'finish' | 'monitor', stage: fields[4], error, assigned, listed, active };
  }

  private arm(deadline: number, child: ChildProcess): void {
    if (this.timer || this.proved) return;
    this.timer = setTimeout(() => {
      this.fail(new Error('Owned Windows job did not prove descendant settlement within 2500ms'));
      // Last-handle termination is a fail-closed fallback, never settlement proof.
      // Roots/registry remain retained even after this exact launcher is reaped.
      try { child.kill('SIGKILL'); } catch { /* The proof remains rejected. */ }
    }, Math.max(0, deadline - performance.now()));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.rejectProof(this.failure);
  }
}
