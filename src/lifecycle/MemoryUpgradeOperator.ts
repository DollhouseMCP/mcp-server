import net, { type Socket, type Server } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MemoryUpgradeLifecycle } from './MemoryUpgradeLifecycle.js';
import { CONTROL_MAX_BYTES, CONTROL_TOKEN, MemoryUpgradeControlState,
  type MemoryControlRecord, type MemoryControlStatus } from './MemoryUpgradeControlState.js';

export interface MemoryDrainAcknowledgement {
  protocol: 2;
  phase: 'drained';
  containerId: string;
  nonce: string;
  bootId: string;
  generation: string;
  sourceBootId: string;
  mode: 'same-boot' | 'drained-successor';
  admitted: 0;
  writes: 0;
  failedWrites: 0;
  retainedOwners: 0;
}

interface ControlRequest {
  protocol: 2;
  phase: 'hello' | 'drain';
  nonce: string;
  bootId?: string;
  containerId?: string;
  remainingMs?: number;
}

/** Private Linux hosted operator; never a console/MCP route or payload recovery API. */
export class MemoryUpgradeOperator {
  readonly bootId = randomBytes(32).toString('hex');
  readonly socketPath: string;
  private lifecycle?: MemoryUpgradeLifecycle;
  private originalReady = false;
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private record?: MemoryControlRecord;
  private drainAttempt?: Promise<MemoryControlRecord>;

  private constructor(readonly state: MemoryUpgradeControlState, readonly startup: MemoryControlStatus) {
    this.socketPath = path.join(state.directory, 'control.sock');
  }

  static async prepare(directory: string): Promise<MemoryUpgradeOperator> {
    const state = new MemoryUpgradeControlState(directory);
    await state.validateDirectory();
    return new MemoryUpgradeOperator(state, await state.read());
  }

  get controlOnly(): boolean { return this.startup.kind !== 'absent'; }

  bindLifecycle(lifecycle: MemoryUpgradeLifecycle): void {
    if (this.controlOnly || (this.lifecycle && this.lifecycle !== lifecycle)) throw new Error('Memory control root cannot be replaced');
    this.lifecycle = lifecycle;
  }

  /** Called only after the original supported runtime has completed bootstrap. */
  enableOriginalDrain(): void {
    if (this.controlOnly || !this.lifecycle) throw new Error('Memory control original runtime is not ready');
    this.originalReady = true;
  }

  async listen(): Promise<void> {
    await this.removeStaleSocket();
    const server = net.createServer(socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      void this.handleSocket(socket).catch(() => socket.destroy());
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => { server.off('error', reject); resolve(); });
    });
    await fs.chmod(this.socketPath, 0o600);
  }

  private async removeStaleSocket(): Promise<void> {
    let before;
    try { before = await fs.lstat(this.socketPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!before.isSocket() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600) {
      throw new Error('Memory control socket ownership changed');
    }
    await new Promise<void>((resolve, reject) => {
      const probe = net.createConnection(this.socketPath);
      probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('Memory control socket remains ambiguous')); });
      probe.once('connect', () => { probe.destroy(); reject(new Error('Memory control socket is live')); });
      probe.once('error', error => {
        probe.destroy();
        if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve();
        else reject(error);
      });
    });
    const after = await fs.lstat(this.socketPath);
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isSocket() ||
      after.uid !== before.uid || (after.mode & 0o777) !== 0o600) throw new Error('Memory control socket changed');
    await fs.unlink(this.socketPath);
  }

  private async handleSocket(socket: Socket): Promise<void> {
    socket.setTimeout(30_000, () => socket.destroy());
    let pending = '';
    let helloNonce: string | undefined;
    for await (const bytes of socket) {
      pending += Buffer.from(bytes).toString('utf8');
      if (Buffer.byteLength(pending) > CONTROL_MAX_BYTES) throw new Error('Memory control request too large');
      const boundary = pending.indexOf('\n');
      if (boundary < 0) continue;
      if (pending.slice(boundary + 1).length) throw new Error('Unexpected memory control frame');
      const request = this.parseRequest(pending.slice(0, boundary));
      pending = '';
      if (request.phase === 'hello' && helloNonce === undefined) {
        helloNonce = request.nonce;
        socket.write(`${JSON.stringify({ protocol: 2, phase: 'hello', nonce: helloNonce, bootId: this.bootId })}\n`);
        continue;
      }
      if (request.phase !== 'drain' || request.nonce !== helloNonce || request.bootId !== this.bootId) {
        throw new Error('Memory control instance changed');
      }
      const response = await this.requestDrain(request);
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
      return;
    }
  }

  private parseRequest(raw: string): ControlRequest {
    const request = JSON.parse(raw) as ControlRequest;
    if (!request || request.protocol !== 2 || typeof request.nonce !== 'string' || !CONTROL_TOKEN.test(request.nonce) ||
      !['hello', 'drain'].includes(request.phase)) throw new Error('Invalid memory control request');
    const keys = request.phase === 'hello' ? ['protocol', 'phase', 'nonce'] :
      ['protocol', 'phase', 'nonce', 'bootId', 'containerId', 'remainingMs'];
    if (Object.keys(request).sort().join(',') !== keys.sort().join(',')) throw new Error('Invalid memory control fields');
    if (request.phase === 'drain' && (typeof request.bootId !== 'string' || !CONTROL_TOKEN.test(request.bootId) ||
      typeof request.containerId !== 'string' || !CONTROL_TOKEN.test(request.containerId) ||
      !Number.isSafeInteger(request.remainingMs) || request.remainingMs! <= 0 || request.remainingMs! > 30_000)) {
      throw new Error('Invalid memory drain budget');
    }
    return request;
  }

  private async requestDrain(request: ControlRequest): Promise<MemoryDrainAcknowledgement | { protocol: 2; phase: 'refused'; nonce: string; bootId: string }> {
    try {
      const record = await this.knownDrain(request.containerId!, request.remainingMs!);
      return { protocol: 2, phase: 'drained', containerId: record.containerId, nonce: request.nonce,
        bootId: this.bootId, generation: record.generation, sourceBootId: record.sourceBootId,
        mode: record.sourceBootId === this.bootId ? 'same-boot' : 'drained-successor',
        admitted: 0, writes: 0, failedWrites: 0, retainedOwners: 0 };
    } catch { return { protocol: 2, phase: 'refused', nonce: request.nonce, bootId: this.bootId }; }
  }

  private async knownDrain(containerId: string, remainingMs: number): Promise<MemoryControlRecord> {
    if (this.startup.kind === 'drained') {
      const current = await this.state.read();
      if (current.kind !== 'drained' || current.record.containerId !== containerId ||
        current.record.generation !== this.startup.record.generation ||
        current.record.sourceBootId !== this.startup.record.sourceBootId) throw new Error('Memory control certificate changed');
      return current.record;
    }
    if (this.controlOnly || !this.lifecycle || !this.originalReady) throw new Error('Memory control has no ready original root');
    if (this.record?.containerId !== undefined && this.record.containerId !== containerId) throw new Error('Memory control container changed');
    if (this.drainAttempt) return this.drainAttempt;
    const work = this.drainOriginal(containerId, remainingMs);
    this.drainAttempt = work;
    try { return await work; }
    finally { this.drainAttempt = undefined; }
  }

  private async drainOriginal(containerId: string, remainingMs: number): Promise<MemoryControlRecord> {
    const deadline = Date.now() + remainingMs;
    // No new mutation may enter while durable intent is being written. Flushes
    // still begin only after that intent is known to have reached storage.
    this.lifecycle!.closeAdmission();
    this.record ??= await this.state.request(containerId, this.bootId);
    // Persistence and quiescence must fit the original caller's budget.
    const budget = Math.min(deadline - Date.now(), 30_000);
    if (budget <= 0) throw new Error('Memory control deadline reached');
    await this.lifecycle!.quiesceAndDrain(budget);
    if (Date.now() >= deadline) throw new Error('Memory control deadline reached');
    const summary = this.lifecycle!.getSummary();
    if (summary.state !== 'drained' || summary.admitted || summary.writes || summary.failedWrites || summary.retainedOwners) {
      throw new Error('Memory control original work remains');
    }
    if (this.record.phase !== 'drained') this.record = await this.state.markDrained(this.record);
    const current = await this.state.read();
    if (current.kind !== 'drained' || current.record.containerId !== containerId ||
      current.record.generation !== this.record.generation || current.record.sourceBootId !== this.bootId) {
      throw new Error('Memory control certificate changed');
    }
    return this.record;
  }

  /** Only terminal known-success teardown; neither phase-one drain nor refusal closes control. */
  async closeAfterDrain(): Promise<void> {
    const current = this.startup.kind === 'drained' ? await this.state.read() : undefined;
    const inherited = this.startup.kind === 'drained' && current?.kind === 'drained' &&
      current.record.containerId === this.startup.record.containerId &&
      current.record.generation === this.startup.record.generation &&
      current.record.sourceBootId === this.startup.record.sourceBootId;
    const known = inherited || this.lifecycle?.getSummary().state === 'drained';
    if (!known) throw new Error('Memory control shutdown refused');
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
    this.server = undefined;
  }
}
