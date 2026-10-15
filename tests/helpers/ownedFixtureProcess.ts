/** Test-only process ownership; never use this for an application process. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { LinuxOwnedGroup } from './linuxOwnedGroup.js';
import { OwnedWindowsJob } from './ownedWindowsJob.js';

export const FIXTURE_CLEANUP_MS = 2500;

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned fixture cleanup did not settle within 2500ms')), FIXTURE_CLEANUP_MS);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class OwnedFixtureProcess {
  private cancelled = false;
  private linuxGroup?: LinuxOwnedGroup;
  private windowsJob?: OwnedWindowsJob;
  private cleanupDeadline?: number;
  private signalRefused = false;
  private child?: ChildProcess;
  private directory?: string;
  private closed = false;
  private resolveClose?: () => void;
  private readonly close = new Promise<void>(resolve => { this.resolveClose = resolve; });
  private resolveFinished?: () => void;
  readonly finished = new Promise<void>(resolve => { this.resolveFinished = resolve; });
  cleaned = false;
  private readonly started = performance.now();
  readonly events: { phase: string; elapsedMs: number }[] = [];

  ownDirectory(directory: string): void {
    if (this.directory) throw new Error('Fixture already owns a directory');
    this.directory = directory;
    this.checkCancellation();
  }

  checkCancellation(): void {
    if (this.cancelled) throw new Error('Owned fixture operation was cancelled');
  }

  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess {
    this.checkCancellation();
    if (this.child) throw new Error('Fixture already owns a child');
    this.record('spawn-requested');
    // POSIX gets a dedicated process group. The Python launcher establishes and
    // verifies a non-inheritable Windows Job Object before creating descendants.
    if (process.platform === 'win32') {
      if (!this.directory) throw new Error('Windows fixture must own its directory before spawn');
      this.windowsJob = new OwnedWindowsJob(this.directory);
    }
    const child = spawn(command, args, { ...options,
      ...(this.windowsJob ? { env: { ...(options.env ?? process.env), ...this.windowsJob.environment() } } : {}),
      detached: process.platform !== 'win32' });
    this.child = child;
    // A successful spawn returns its PID before the next-tick spawn event.
    // Cancellation may run in this same stack; never defer or replace identity.
    if (process.platform === 'linux' && child.pid) this.linuxGroup = new LinuxOwnedGroup(child.pid);
    if (this.windowsJob) child.stderr?.on('data', (chunk: Buffer) => this.windowsJob!.observe(chunk, child, () => this.record('windows-job-quiescent')));
    child.once('spawn', () => {
      this.record('spawn');
    });
    child.stderr?.once('data', () => this.record('first-stderr'));
    child.once('exit', () => this.record('exit'));
    child.once('error', () => this.record('spawn-error'));
    child.once('close', () => {
      this.record('close');
      this.closed = true;
      this.resolveClose?.();
    });
    return child;
  }

  cancel(): void {
    this.cancelled = true;
    this.cleanupDeadline ??= performance.now() + FIXTURE_CLEANUP_MS;
    const child = this.child;
    if (!child || this.closed || !child.pid) return;
    if (this.signalRefused) throw new Error('Owned Linux group identity is unproved; refusing signal and cleanup');
    this.record('cleanup-terminate-owned-tree');
    if (process.platform === 'win32') {
      this.windowsJob!.requestCancellation(child, this.cleanupDeadline);
    } else if (this.authorizePosixSignal()) {
      this.killPosixGroup(child.pid);
    }
  }

  async finish(): Promise<void> {
    if (this.signalRefused) throw new Error('Owned Linux group identity is unproved; refusing signal and cleanup');
    if (this.child && !this.closed) {
      this.cancel();
      await bounded(this.close);
    }
    this.cleanupDeadline ??= performance.now() + FIXTURE_CLEANUP_MS;
    if (this.windowsJob && this.child) await this.windowsJob.wait(this.cleanupDeadline, this.child);
    let orphanedGroup = false;
    if (process.platform !== 'win32' && this.child?.pid && this.groupExists()) {
      orphanedGroup = !this.cancelled;
      this.cancelled = true;
      if (this.authorizePosixSignal()) this.killPosixGroup(this.child.pid);
      await this.waitForGroupSettlement();
    }
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.cleaned = true;
    if (orphanedGroup) throw new Error('Owned fixture exited with live descendants; cleaned but refused success');
  }

  complete(): void { this.resolveFinished?.(); }

  private record(phase: string): void {
    this.events.push({ phase, elapsedMs: Math.round((performance.now() - this.started) * 1000) / 1000 });
  }

  private killPosixGroup(pid: number): void {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }

  private authorizePosixSignal(): boolean {
    if (process.platform !== 'linux') return true;
    if (!this.groupExists()) return false;
    if (!this.linuxGroup?.captureBeforeKill(this.cleanupDeadline!)) {
      this.signalRefused = true;
      throw new Error('Owned Linux group identity is unproved; refusing signal and cleanup');
    }
    return true;
  }

  private groupExists(): boolean {
    if (!this.child?.pid) return false;
    try { process.kill(-this.child.pid, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  }

  /** Distinguish PID absence from exact owned zombie evidence in controls. */
  processSettlement(pid: number): 'absent' | 'owned-zombie' | 'unsettled' {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'absent';
      throw error;
    }
    return this.linuxGroup?.processIsOwnedZombie(pid, performance.now() + 100) ? 'owned-zombie' : 'unsettled';
  }

  private waitForGroupSettlement(): Promise<void> {
    const deadline = this.cleanupDeadline!;
    return new Promise((resolve, reject) => {
      const poll = () => {
        try {
          if (!this.groupExists()) resolve();
          else if (this.linuxGroup?.zombieOnly(deadline)) { this.record('owned-group-zombie-only'); resolve(); }
          else if (performance.now() >= deadline) reject(new Error('Owned fixture group did not close'));
          else setTimeout(poll, 20);
        } catch (error) { reject(error); }
      };
      poll();
    });
  }
}

export class OwnedFixtureRegistry {
  private readonly active = new Set<OwnedFixtureProcess>();

  assertSettled(): void {
    if (this.active.size) throw new Error('Prior owned fixture is unsettled; refusing another spawn');
  }

  async run<T>(work: (owner: OwnedFixtureProcess) => Promise<T>): Promise<T> {
    this.assertSettled();
    const owner = new OwnedFixtureProcess();
    this.active.add(owner); // Before the first setup await, including mkdtemp.
    let value: T | undefined;
    let failure: unknown;
    let failed = false;
    try { value = await work(owner); owner.checkCancellation(); }
    catch (error) { failure = error; failed = true; }
    try { await owner.finish(); }
    catch (error) { if (!failed) { failure = error; failed = true; } }
    finally {
      if (owner.cleaned) this.active.delete(owner);
      owner.complete();
    }
    if (failed) throw failure;
    return value as T;
  }

  async cancelUnfinished(): Promise<void> {
    // afterEach runs after Jest records the original test failure/10s timeout.
    // This bounded teardown is never treated as successful helper execution.
    for (const owner of this.active) owner.cancel();
    await bounded(Promise.all([...this.active].map(owner => owner.finished)));
    this.assertSettled();
  }
}
