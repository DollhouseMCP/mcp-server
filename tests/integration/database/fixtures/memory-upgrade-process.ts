/** Owned OFF-mode compiled process proof. No production endpoint or force-kill cleanup. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LocalDevAuthProvider } from '../../../../src/auth/LocalDevAuthProvider.js';
import { makeEquivalentFixture } from './2905-equivalent-reconciliation-fixture.js';

export type UpgradeFrame = Record<string, any>;

const redactDiagnostic = (value: string): string => value
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, '[owned fixture token redacted]')
  .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gu, 'postgres://[owned fixture credential redacted]@')
  .slice(0, 5000);

// Only the owned memory's inner persistence body is delayed, AFTER the real
// MemoryManager.save has registered its lifecycle promise. The original production
// MemorySaveHandler, admission/lifecycle and SQL writer still execute.
const observer = String.raw`
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
if (!process.send || !process.env.DOLLHOUSE_UPGRADE_PROOF_ROOT) throw new Error('Owned IPC child required');
const { MemoryManager } = await import(pathToFileURL(path.join(process.env.DOLLHOUSE_UPGRADE_PROOF_ROOT, 'elements/memories/MemoryManager.js')));
const { DollhouseContainer } = await import(pathToFileURL(path.join(process.env.DOLLHOUSE_UPGRADE_PROOF_ROOT, 'di/Container.js')));
const { MemorySaveHandler } = await import(pathToFileURL(path.join(process.env.DOLLHOUSE_UPGRADE_PROOF_ROOT, 'handlers/mcp-aql/MemorySaveHandler.js')));
const originalResolve = DollhouseContainer.prototype.resolve;
let rootLifecycle;
DollhouseContainer.prototype.resolve = function(name, ...args) {
  const value = Reflect.apply(originalResolve, this, [name, ...args]);
  if (name === 'MemoryUpgradeLifecycle') rootLifecycle = value;
  return value;
};
const original = MemoryManager.prototype.saveMemoryKnown;
if (typeof original !== 'function') throw new Error('Actual compiled tracked persistence body unavailable');
let remaining = 0, persistenceFault = false;
const held = new Map();
const memories = new WeakMap(), managers = new WeakMap();
let entered = 0, settled = 0;
const send = frame => { if (process.connected) process.send(frame); };
MemoryManager.prototype.saveMemoryKnown = async function(memory, ...args) {
  if (memory?.metadata?.name !== process.env.DOLLHOUSE_UPGRADE_PROOF_MEMORY) return Reflect.apply(original, this, [memory, ...args]);
  if (!memories.has(memory)) memories.set(memory, randomUUID());
  if (!managers.has(this)) managers.set(this, randomUUID());
  const call = randomUUID(); entered++;
  let release;
  const barrier = remaining > 0 ? new Promise(resolve => { release = resolve; remaining--; held.set(call, release); }) : undefined;
  send({event:'save-enter', call, memoryInstance:memories.get(memory), managerInstance:managers.get(this), held:!!barrier});
  try {
    if (barrier) await barrier;
    if (persistenceFault) throw Object.assign(new Error('Owned fixture persistence failure'), {code:'EOWNEDPROOF'});
    return await Reflect.apply(original, this, [memory, ...args]);
  } finally { settled++; held.delete(call); send({event:'save-settled', call}); }
};
const disposeOriginal = MemorySaveHandler.prototype.dispose;
MemorySaveHandler.prototype.dispose = async function(...args) {
  const retained = this.hasRetainedMemoryWork();
  if (retained) send({event:'retained-owner-dispose-enter'});
  try { return await Reflect.apply(disposeOriginal, this, args); }
  catch (error) { if (retained) send({event:'retained-owner-dispose-refused'}); throw error; }
};
process.on('message', message => {
  if (!message || typeof message.id !== 'string') return;
  let result;
  if (message.command === 'arm' && Number.isSafeInteger(message.count) && message.count > 0 && message.count <= 4) { remaining=message.count; result={armed:remaining}; }
  else if (message.command === 'release-all') { for (const release of held.values()) release(); result={released:held.size}; }
  else if (message.command === 'fault' && typeof message.enabled === 'boolean') { persistenceFault=message.enabled; result={enabled:persistenceFault}; }
  else if (message.command === 'stats') result={entered,settled,held:held.size};
  else if (message.command === 'summary') {
    if (!rootLifecycle || typeof rootLifecycle.getSummary !== 'function') { send({id:message.id,error:'Actual root lifecycle unavailable'}); return; }
    result=rootLifecycle.getSummary();
  }
  else { send({id:message.id,error:'Unsupported private proof command'}); return; }
  send({id:message.id,result});
});
process.on('SIGTERM', () => send({event:'signal-observed'}));
send({event:'observer-ready'});
`;

export class MemoryUpgradeRuntime {
  readonly child: ChildProcess;
  readonly messages: UpgradeFrame[] = [];
  private readonly pending = new Map<string, { resolve: (frame: UpgradeFrame) => void; reject: (cause: Error) => void }>();
  private readonly clients: Client[] = [];
  private readonly transports = new Map<Client, StreamableHTTPClientTransport>();
  private stderr = '';
  private closed = false;
  private ended = false;
  private closing?: Promise<void>;
  private url = '';
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;
  get finalClosed(): boolean { return this.closed; }

  constructor(directory: string, preloader: string, environment: Record<string, string>) {
    const root = process.cwd();
    this.child = spawn(process.execPath, ['--import', preloader, path.join(root, 'dist/index.js'), '--http', '--port=0'], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, ...environment, DOLLHOUSE_UPGRADE_PROOF_ROOT: path.join(root, 'dist') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    console.info(`[memory-upgrade:child] pid=${this.child.pid} spawned`);
    this.child.stdout!.on('data', () => undefined);
    this.child.stderr!.on('data', chunk => {
      this.stderr = (this.stderr + String(chunk)).slice(-32000).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, '[owned fixture token redacted]');
      const match = /Streamable HTTP server listening on (https?:\/\/[^\s]+)/u.exec(this.stderr);
      if (match) this.url = match[1].endsWith('/mcp') ? match[1] : `${match[1]}/mcp`;
    });
    this.child.on('message', message => {
      const frame = message as UpgradeFrame; this.messages.push(frame);
      const waiter = this.pending.get(frame.id);
      if (waiter) { this.pending.delete(frame.id); waiter.resolve(frame); }
    });
    this.child.once('exit', () => { this.ended = true; });
    this.child.once('close', (code, signal) => {
      this.closed = true; this.exitCode = code; this.exitSignal = signal;
      for (const waiter of this.pending.values()) waiter.reject(new Error('Owned upgrade child closed'));
      this.pending.clear();
      console.info(`[memory-upgrade:child] pid=${this.child.pid} exit=${code} signal=${signal} final-close`);
    });
  }
  async waitUntil(check: () => boolean, bound = 15000): Promise<void> {
    const end = Date.now() + bound;
    while (!check()) {
      if (Date.now() >= end) throw new Error('Owned upgrade condition did not settle within its bound');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  async ready(): Promise<void> {
    await this.waitUntil(() => {
      if (this.closed) throw new Error(`Owned compiled OFF startup failed: ${this.stderr}`);
      return !!this.url && this.messages.some(frame => frame.event === 'observer-ready');
    }, 60000);
  }
  async rpc(command: 'arm' | 'release-all' | 'fault' | 'stats' | 'summary', fields: UpgradeFrame = {}): Promise<UpgradeFrame> {
    if (!this.child.connected) throw new Error('Owned upgrade IPC disconnected');
    const id = randomUUID();
    let cap: ReturnType<typeof setTimeout> | undefined;
    const reply = new Promise<UpgradeFrame>((resolve, reject) => {
      cap = setTimeout(() => { this.pending.delete(id); reject(new Error('Owned upgrade IPC deadline')); }, 15000);
      this.pending.set(id, { resolve, reject });
      this.child.send!({ id, command, ...fields }, cause => {
        if (cause) { this.pending.delete(id); reject(cause); }
      });
    });
    let frame: UpgradeFrame;
    try { frame = await reply; } finally { if (cap) clearTimeout(cap); }
    if (frame.error) throw new Error(frame.error);
    return frame.result;
  }
  async connect(token: string): Promise<Client> {
    const client = new Client({ name: 'owned-memory-upgrade-proof', version: '1.0.0' }, { capabilities: {} });
    this.clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    this.transports.set(client, transport);
    await client.connect(transport);
    return client;
  }
  sessionId(client: Client): string | undefined { return this.transports.get(client)?.sessionId; }
  async terminateSession(client: Client): Promise<void> {
    const transport = this.transports.get(client);
    if (!transport) throw new Error('Owned client transport unavailable');
    await transport.terminateSession();
  }
  diagnostic(): UpgradeFrame {
    return { childPid: this.child.pid, finalClosed: this.closed, exitCode: this.exitCode,
      exitSignal: this.exitSignal, frames: this.messages.slice(-16) };
  }
  signal(): void {
    if (!this.child.kill('SIGTERM')) throw new Error('Owned child did not receive graceful signal');
  }
  async waitForClose(): Promise<void> { await this.waitUntil(() => this.closed, 15000); }
  close(): Promise<void> { return this.closing ??= this.closeOwned(); }
  private async closeOwned(): Promise<void> {
    const outcomes = await Promise.allSettled(this.clients.map(client => client.close()));
    if (this.ended) await this.waitForClose();
    if (!this.closed) {
      await this.rpc('release-all');
      this.signal();
      await this.waitForClose();
    }
    // NEVER escalate to SIGKILL. If drain refuses, the parent fixture retains
    // the child, database, role and directory and reports cleanup unproven.
    const failures = outcomes.filter(outcome => outcome.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(outcome => (outcome as PromiseRejectedResult).reason), 'Owned SDK close failed');
  }
}

export async function ownedUpgradeProcess(caseName: string,
  body: (fixture: { f: Awaited<ReturnType<typeof makeEquivalentFixture>>; directory: string; token: string;
    spawn: () => Promise<MemoryUpgradeRuntime>; ownAuxiliary: (child: ChildProcess) => void }) => Promise<void>): Promise<void> {
  const f = await makeEquivalentFixture();
  let directory: string | undefined;
  const runtimes: MemoryUpgradeRuntime[] = [];
  const auxiliary = new Map<ChildProcess, boolean>();
  let failure: unknown;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'memory-upgrade-'));
    const preloader = path.join(directory, 'owned-upgrade-observer.mjs');
    await writeFile(preloader, observer, { mode: 0o600 });
    const subject = `owned-upgrade-${randomUUID()}`;
    await f.maintenance`INSERT INTO public.auth_accounts(provider,external_sub,sub,user_id) VALUES('local',${subject},${subject},${f.userId}::uuid)`;
    const keyFile = path.join(directory, 'local-es256.json');
    const auth = new LocalDevAuthProvider({ keyFilePath: keyFile });
    const token = await auth.issue(subject, { displayName: f.runtime.selectedUsername, scopes: ['mcp'] });
    // No guarded registry/mode/quotas are installed: this is genuine OFF.
    const environment = {
      DOLLHOUSE_USER: f.runtime.selectedUsername, MCP_INTERFACE_MODE: 'mcpaql', DOLLHOUSE_STORAGE_BACKEND: 'database',
      DOLLHOUSE_DATABASE_URL: f.runtime.appUrl, DOLLHOUSE_DATABASE_ADMIN_URL: f.runtime.systemUrl,
      DOLLHOUSE_DATABASE_POOL_SIZE: '3', DOLLHOUSE_DATABASE_SSL: 'disable', DOLLHOUSE_DATABASE_MEMORY_GUARDED: 'false',
      DOLLHOUSE_AUTH_ENABLED: 'true', DOLLHOUSE_AUTH_PROVIDER: 'local', DOLLHOUSE_AUTH_LOCAL_KEY_FILE: keyFile,
      DOLLHOUSE_MASTER_ENCRYPTION_KEY: randomBytes(32).toString('base64'), DOLLHOUSE_WEB_CONSOLE: 'false',
      DOLLHOUSE_HTTP_WEB_CONSOLE: 'false', DOLLHOUSE_PERMISSION_SERVER: 'false', DOLLHOUSE_ENABLE_FILE_WATCHER: 'false',
      AUTO_RELOAD_ON_EXTERNAL_CHANGE: 'false', DOLLHOUSE_LOG_FLUSH_INTERVAL_MS: '100', DOLLHOUSE_UPGRADE_PROOF_MEMORY: f.name,
    };
    console.info(`[memory-upgrade:${caseName}] fixture-start`);
    await body({ f, directory, token, ownAuxiliary: child => {
      auxiliary.set(child, false); child.once('close', () => auxiliary.set(child, true));
    }, spawn: async () => {
      const childDirectory = path.join(directory!, `runtime-${randomUUID()}`); await mkdir(childDirectory, { mode: 0o700 });
      const runtime = new MemoryUpgradeRuntime(childDirectory, preloader, { ...environment,
        DOLLHOUSE_PORTFOLIO_DIR: path.join(childDirectory, 'portfolio'), DOLLHOUSE_CACHE_DIR: path.join(childDirectory, 'cache'),
        DOLLHOUSE_LOG_DIR: path.join(childDirectory, 'logs') });
      runtimes.push(runtime); await runtime.ready(); return runtime;
    } });
  } catch (cause) {
    failure = cause;
    // Preserve the original bounded failure and IPC phase evidence before
    // owned directory cleanup; outer AggregateError alone hides it in Jest.
    console.error(`[memory-upgrade:${caseName}] original-failure`, cause instanceof Error
      ? { name: cause.name, message: redactDiagnostic(cause.message), stack: cause.stack ? redactDiagnostic(cause.stack) : undefined }
      : redactDiagnostic(String(cause)));
    for (const runtime of runtimes) console.error(`[memory-upgrade:${caseName}] phase-evidence`, runtime.diagnostic());
  }
  const closes = await Promise.allSettled(runtimes.map(runtime => runtime.close()));
  if (runtimes.some(runtime => !runtime.finalClosed) || [...auxiliary.values()].some(closed => !closed)) throw new AggregateError([
    ...(failure ? [failure] : []), ...closes.filter(x => x.status === 'rejected').map(x => (x as PromiseRejectedResult).reason),
  ], 'Owned upgrade application/helper final close unproven; database, role and directory preserved');
  const cleanup = await Promise.allSettled([f.cleanup(), directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve()]);
  const causes = [...closes, ...cleanup].filter(x => x.status === 'rejected').map(x => (x as PromiseRejectedResult).reason);
  if (failure || causes.length) throw new AggregateError([...(failure ? [failure] : []), ...causes], 'Owned upgrade proof or cleanup failed');
  console.info(`[memory-upgrade:${caseName}] owned-cleanup-complete`);
}
