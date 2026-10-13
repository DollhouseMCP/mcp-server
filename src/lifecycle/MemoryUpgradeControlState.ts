import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const CONTROL_MAX_BYTES = 1024;
export const CONTROL_TOKEN = /^[a-f0-9]{64}$/;

export interface MemoryControlIdentity {
  protocol: 2;
  containerId: string;
  generation: string;
  sourceBootId: string;
}
export interface MemoryControlRecord extends MemoryControlIdentity { phase: 'requested' | 'drained'; }
export type MemoryControlStatus = { kind: 'absent' | 'unknown' } |
  { kind: 'requested' | 'drained'; record: MemoryControlRecord };

function identity(value: unknown): value is MemoryControlIdentity {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.protocol === 2 && [record.containerId, record.generation, record.sourceBootId]
    .every(token => typeof token === 'string' && CONTROL_TOKEN.test(token));
}

function exactKeys(value: object, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
}

/** Private admission hold, not a payload journal or recovery authority. Never cleared automatically. */
export class MemoryUpgradeControlState {
  constructor(readonly directory: string) {}

  async validateDirectory(): Promise<void> {
    if (!path.isAbsolute(this.directory) || await fs.realpath(this.directory) !== path.resolve(this.directory)) {
      throw new Error('Invalid memory control directory');
    }
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
      throw new Error('Invalid memory control directory ownership');
    }
  }

  async read(): Promise<MemoryControlStatus> {
    try {
      await this.validateDirectory();
      const names = await fs.readdir(this.directory);
      if (names.some(name => !['intent.json', 'state.json', 'control.sock'].includes(name))) return { kind: 'unknown' };
      const seal = await this.readPrivate('intent.json');
      const state = await this.readPrivate('state.json');
      if (seal === undefined && state === undefined) return { kind: 'absent' };
      if (!identity(seal) || !exactKeys(seal, ['protocol', 'containerId', 'generation', 'sourceBootId'])) return { kind: 'unknown' };
      if (!identity(state) || !exactKeys(state, ['protocol', 'containerId', 'generation', 'sourceBootId', 'phase'])) return { kind: 'unknown' };
      const record = state as MemoryControlRecord;
      if (!['requested', 'drained'].includes(record.phase) || record.containerId !== seal.containerId ||
        record.generation !== seal.generation || record.sourceBootId !== seal.sourceBootId) return { kind: 'unknown' };
      return { kind: record.phase, record };
    } catch { return { kind: 'unknown' }; }
  }

  private async readPrivate(name: string): Promise<unknown> {
    const file = path.join(this.directory, name);
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 || stat.size > CONTROL_MAX_BYTES) throw new Error('Invalid memory control record');
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  }

  async request(containerId: string, sourceBootId: string): Promise<MemoryControlRecord> {
    if ((await this.read()).kind !== 'absent' || !CONTROL_TOKEN.test(containerId) || !CONTROL_TOKEN.test(sourceBootId)) {
      throw new Error('Memory control intent unavailable');
    }
    const seal: MemoryControlIdentity = { protocol: 2, containerId, generation: randomBytes(32).toString('hex'), sourceBootId };
    // Exclusive immutable seal: partial/missing state is detectable on every later startup.
    await this.writeSynced(path.join(this.directory, 'intent.json'), seal);
    await this.syncDirectory();
    const record: MemoryControlRecord = { ...seal, phase: 'requested' };
    await this.replaceState(record);
    return record;
  }

  async markDrained(record: MemoryControlRecord): Promise<MemoryControlRecord> {
    const current = await this.read();
    if (current.kind !== 'requested' || current.record.generation !== record.generation ||
      current.record.containerId !== record.containerId || current.record.sourceBootId !== record.sourceBootId) {
      throw new Error('Memory control generation changed');
    }
    const drained: MemoryControlRecord = { ...record, phase: 'drained' };
    // Keep an uncertainty marker until the drained record itself is fully synced.
    // A failure before that checkpoint cannot be mistaken for completion at restart.
    const pending = path.join(this.directory, 'drained-pending.json');
    await this.writeSynced(pending, record);
    await this.syncDirectory();
    await this.replaceState(drained);
    await fs.unlink(pending);
    await this.syncDirectory();
    return drained;
  }

  private async replaceState(record: MemoryControlRecord): Promise<void> {
    await this.validateDirectory();
    const temporary = path.join(this.directory, `state-${randomBytes(16).toString('hex')}.tmp`);
    await this.writeSynced(temporary, record);
    await fs.rename(temporary, path.join(this.directory, 'state.json'));
    await this.syncDirectory();
  }

  private async writeSynced(file: string, value: object): Promise<void> {
    const bytes = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(bytes) > CONTROL_MAX_BYTES) throw new Error('Memory control record too large');
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
  }

  private async syncDirectory(): Promise<void> {
    const handle = await fs.open(this.directory, 'r');
    try { await handle.sync(); }
    finally { await handle.close(); }
  }
}
