/** Linux-only test fixture evidence. A zombie is not PID absence. */
import { closeSync, opendirSync, openSync, readSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export type LinuxProcess = { pid: number; state: string; group: number; session: number; started: string; threads: number };
const MAX_ENTRIES = 2048;
const CENSUS_MS = 100;

// proc_pid_stat(5): comm may itself contain spaces and closing parentheses.
export function parseLinuxProcess(raw: string): LinuxProcess {
  const match = /^(\d+) \([\s\S]*\) (\S+) ([\s\S]+)$/.exec(raw.trim());
  if (!match) throw new Error('Unrecognized Linux process metadata');
  const fields = [match[2], ...match[3].split(/\s+/)];
  const integer = (value: string | undefined) => {
    if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid Linux process identity');
    return Number(value);
  };
  const started = fields[19];
  if (!started || !/^\d+$/.test(started) || !/^[A-Za-z]$/.test(fields[0])) throw new Error('Invalid Linux process state or start time');
  const value = { pid: integer(match[1]), state: fields[0], group: integer(fields[2]), session: integer(fields[3]),
    started, threads: integer(fields[17]) };
  if (value.pid <= 0 || value.threads <= 0) throw new Error('Invalid Linux process identity');
  return value;
}

export function sameLinuxProcess(left: LinuxProcess, right: LinuxProcess): boolean {
  return left.pid === right.pid && left.started === right.started && left.group === right.group && left.session === right.session;
}

function processEvidence(pid: number): LinuxProcess | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(`/proc/${pid}/stat`, 'r');
    const buffer = Buffer.alloc(4097), length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 4096) throw new Error('Linux process metadata exceeded bound');
    const value = parseLinuxProcess(buffer.toString('utf8', 0, length));
    if (value.pid !== pid) throw new Error('Linux process identity changed');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function names(directory: string, deadline: number): string[] {
  const handle = opendirSync(directory), result: string[] = [];
  try {
    for (;;) {
      if (performance.now() >= deadline || result.length >= MAX_ENTRIES) throw new Error('Linux ownership census exceeded bound');
      const entry = handle.readSync();
      if (!entry) return result;
      result.push(entry.name);
    }
  } finally { handle.closeSync(); }
}

function census(group: number, deadline: number): LinuxProcess[] {
  const result: LinuxProcess[] = [];
  for (const name of names('/proc', deadline)) {
    if (performance.now() >= deadline) throw new Error('Linux ownership census exceeded bound');
    if (!/^\d+$/.test(name)) continue;
    const value = processEvidence(Number(name));
    if (value?.group === group) result.push(value);
  }
  return result;
}

/** Pure identity/state predicate; never accepts a new, reused, live or threaded member. */
export function exactOwnedZombies(previous: readonly LinuxProcess[], current: readonly LinuxProcess[], group: number): boolean {
  return Number.isSafeInteger(group) && group > 0 && current.length > 0 && current.every(value => BigInt(value.started) > 0n && value.group === group && value.session === group &&
    value.state === 'Z' && value.threads === 1 && previous.some(before => sameLinuxProcess(before, value)));
}

type CaptureStage = 'initial-leader' | 'current-leader' | 'census' | 'member-match' | 'post-leader';
type CaptureReason = 'missing-snapshot' | 'missing-leader' | 'leader-mismatch' | 'members-mismatch' | 'observation-error';
export type LinuxCaptureRefusal = {
  mode: 'first' | 'repeated'; stage: CaptureStage; reason: CaptureReason;
  retained: number | null; observed: number | null; code: string | null;
};
const safeCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'ESRCH', 'EIO', 'EMFILE', 'ENFILE']);
function safeCode(error: unknown): string | null {
  try {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return typeof code === 'string' && safeCodes.has(code) ? code : null;
  } catch { return null; } // Arbitrary thrown payloads never enter diagnostics.
}

export class LinuxOwnedGroup {
  private readonly leader?: LinuxProcess;
  private members?: LinuxProcess[];
  private attempted = false;
  private readonly initialFailed: boolean = false;
  private readonly initialCode: string | null = null;
  private refusal?: LinuxCaptureRefusal;

  refusalDetail(): LinuxCaptureRefusal | undefined {
    return this.refusal ? { ...this.refusal } : undefined;
  }

  constructor(private readonly group: number) {
    try {
      const leader = processEvidence(group);
      if (group > 0 && leader?.group === group && leader.session === group && BigInt(leader.started) > 0n) this.leader = leader;
    } catch (error) { this.initialFailed = true; this.initialCode = safeCode(error); } // Unknown evidence never authorizes completion.
  }

  captureBeforeKill(deadline: number): boolean {
    const mode = this.attempted ? 'repeated' : 'first';
    let stage: CaptureStage = 'initial-leader';
    let observed: number | null = null;
    const refuse = (reason: CaptureReason, code: string | null = null): false => {
      this.refusal ??= { mode, stage, reason, retained: this.members?.length ?? null, observed, code };
      return false;
    };
    try {
      const slice = Math.min(deadline, performance.now() + CENSUS_MS);
      if (this.attempted) {
        if (!this.members) return refuse('missing-snapshot');
        stage = 'census';
        const current = census(this.group, slice);
        observed = current.length;
        stage = 'member-match';
        const accepted = current.length > 0 && current.every(value => this.members!.some(before => sameLinuxProcess(before, value)));
        if (!accepted) return refuse('members-mismatch');
        return true;
      }
      this.attempted = true;
      if (!this.leader) return refuse(this.initialFailed ? 'observation-error' : 'missing-leader', this.initialCode);
      stage = 'current-leader';
      const leader = processEvidence(this.group);
      if (!leader || !sameLinuxProcess(this.leader, leader)) return refuse('leader-mismatch');
      stage = 'census';
      const members = census(this.group, slice);
      observed = members.length;
      stage = 'member-match';
      if (!members.some(value => sameLinuxProcess(value, leader)) || members.some(value => value.session !== this.group)) return refuse('members-mismatch');
      // Recheck the actual launcher after the census, before authorizing a signal.
      stage = 'post-leader';
      const currentLeader = processEvidence(this.group);
      if (!currentLeader || !sameLinuxProcess(this.leader, currentLeader)) return refuse('leader-mismatch');
      this.members = members;
      return true;
    } catch (error) { return refuse('observation-error', safeCode(error)); } // Never authorize an unknown group signal.
  }

  zombieOnly(deadline: number): boolean {
    if (!this.members) return false;
    try {
      const slice = Math.min(deadline, performance.now() + CENSUS_MS);
      const current = census(this.group, slice);
      if (!exactOwnedZombies(this.members, current, this.group)) return false;
      // A zombie thread-group leader alone does not prove its sibling threads
      // stopped. Require its task directory to contain only the captured leader.
      return current.every(value => {
        const tasks = names(`/proc/${value.pid}/task`, slice);
        return tasks.length === 1 && tasks[0] === String(value.pid);
      });
    } catch { return false; }
  }

  processIsOwnedZombie(pid: number, deadline: number): boolean {
    if (!this.members) return false;
    try {
      const value = processEvidence(pid);
      if (!value || !exactOwnedZombies(this.members, [value], this.group)) return false;
      const tasks = names(`/proc/${pid}/task`, Math.min(deadline, performance.now() + CENSUS_MS));
      return tasks.length === 1 && tasks[0] === String(pid);
    } catch { return false; }
  }
}
