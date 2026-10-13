import net from 'node:net';
import path from 'node:path';
import { CONTROL_MAX_BYTES, CONTROL_TOKEN } from './MemoryUpgradeControlState.js';
import type { MemoryDrainAcknowledgement } from './MemoryUpgradeOperator.js';

function exactKeys(value: object, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
}

function validHello(response: Record<string, unknown>, nonce: string): response is Record<string, unknown> & { bootId: string } {
  return response.protocol === 2 && response.phase === 'hello' && response.nonce === nonce &&
    typeof response.bootId === 'string' && CONTROL_TOKEN.test(response.bootId) &&
    exactKeys(response, ['bootId', 'nonce', 'phase', 'protocol']);
}

function validAcknowledgement(value: unknown, containerId: string, nonce: string, bootId: string): value is MemoryDrainAcknowledgement {
  if (!value || typeof value !== 'object') return false;
  const ack = value as MemoryDrainAcknowledgement;
  const keys = ['protocol', 'phase', 'containerId', 'nonce', 'bootId', 'generation', 'sourceBootId', 'mode',
    'admitted', 'writes', 'failedWrites', 'retainedOwners'];
  if (!exactKeys(value, keys)) return false;
  return ack.protocol === 2 && ack.phase === 'drained' && ack.containerId === containerId && ack.nonce === nonce &&
    ack.bootId === bootId && typeof ack.generation === 'string' && CONTROL_TOKEN.test(ack.generation) &&
    typeof ack.sourceBootId === 'string' && CONTROL_TOKEN.test(ack.sourceBootId) &&
    ack.mode === (ack.sourceBootId === bootId ? 'same-boot' : 'drained-successor') &&
    ack.admitted === 0 && ack.writes === 0 && ack.failedWrites === 0 && ack.retainedOwners === 0;
}

/** One bounded same-socket exchange. A lost client never cancels original server drain work. */
export async function requestMemoryDrain(directory: string, containerId: string, nonce: string,
  remainingMs: number): Promise<MemoryDrainAcknowledgement> {
  if (!path.isAbsolute(directory) || !CONTROL_TOKEN.test(containerId) || !CONTROL_TOKEN.test(nonce) ||
    !Number.isSafeInteger(remainingMs) || remainingMs <= 0) throw new Error('Invalid memory drain request');
  const deadline = Date.now() + remainingMs;
  const socket = net.createConnection(path.join(directory, 'control.sock'));
  const timer = setTimeout(() => socket.destroy(new Error('Memory drain client deadline')), remainingMs);
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write(`${JSON.stringify({ protocol: 2, phase: 'hello', nonce })}\n`);
    let pending = '';
    let bootId: string | undefined;
    for await (const bytes of socket) {
      pending += Buffer.from(bytes).toString('utf8');
      if (Buffer.byteLength(pending) > CONTROL_MAX_BYTES) throw new Error('Memory drain response too large');
      const boundary = pending.indexOf('\n');
      if (boundary < 0) continue;
      if (pending.slice(boundary + 1).length) throw new Error('Unexpected memory drain response');
      const response = JSON.parse(pending.slice(0, boundary)) as Record<string, unknown>;
      pending = '';
      if (!bootId) {
        if (!validHello(response, nonce)) throw new Error('Invalid memory drain hello');
        bootId = response.bootId;
        const budget = Math.min(deadline - Date.now(), 30_000);
        if (budget <= 0) throw new Error('Memory drain client deadline');
        socket.write(`${JSON.stringify({ protocol: 2, phase: 'drain', nonce, bootId, containerId, remainingMs: budget })}\n`);
      } else {
        if (!validAcknowledgement(response, containerId, nonce, bootId)) throw new Error('Memory drain refused');
        return response;
      }
    }
    throw new Error('Memory drain response missing');
  } finally { clearTimeout(timer); socket.destroy(); }
}

const direct = process.argv[1]?.endsWith('/requestMemoryDrain.js');
if (direct) {
  const [containerId, nonce, budget] = process.argv.slice(2);
  const directory = process.env.DOLLHOUSE_MEMORY_UPGRADE_CONTROL_DIR;
  if (!directory || process.argv.length !== 5) process.exitCode = 1;
  else {
    try {
      const ack = await requestMemoryDrain(directory, containerId, nonce, Number(budget));
      process.stdout.write(`${JSON.stringify(ack)}\n`);
    } catch { process.exitCode = 1; }
  }
}
