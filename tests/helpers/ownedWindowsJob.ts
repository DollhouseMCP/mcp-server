/** Nonce-bound proof from the existing anonymous Windows fixture Job Object. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ChildProcess } from 'node:child_process';

export class OwnedWindowsJob {
  private readonly token = randomUUID();
  private readonly cancelFile: string;
  private resolveProof!: () => void;
  private rejectProof!: (error: Error) => void;
  private readonly proof = new Promise<void>((resolve, reject) => { this.resolveProof = resolve; this.rejectProof = reject; });
  private failure?: Error;
  private proved = false;
  private requested = false;
  private tail = '';
  private dropping = false;
  private timer?: NodeJS.Timeout;

  constructor(directory: string) {
    this.cancelFile = join(directory, `.owned-job-cancel-${this.token}`);
    void this.proof.catch(() => {}); // Keep the original rejected proof for wait().
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
    if (!line.startsWith('OWNED_FIXTURE_JOB_QUIESCENT ')) return;
    if (line !== `OWNED_FIXTURE_JOB_QUIESCENT ${this.token} ${child.pid}`) {
      this.fail(new Error('Owned Windows job proof has the wrong nonce or launcher identity')); return;
    }
    if (this.proved || this.failure) return;
    this.proved = true;
    clearTimeout(this.timer);
    onProof(); this.resolveProof();
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
