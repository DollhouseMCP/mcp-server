/** Owned compiled CLI driver. IPC is test-only and never supplies a tenant or authority. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LocalDevAuthProvider } from '../../../../src/auth/LocalDevAuthProvider.js';
import { DatabaseMemoryEquivalentReconciler } from '../../../../src/storage/DatabaseMemoryEquivalentReconciler.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE } from '../../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { DATABASE_MEMORY_LEGACY_PROFILE } from '../../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';
import { SYSTEM_USER_UUID } from '../../../../src/collection/shared-pool/SharedPoolConfig.js';
import { makeEquivalentFixture, type EquivalentFixture } from './2905-equivalent-reconciliation-fixture.js';

export type Frame = Record<string, any>;
export function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { text?: string }[]).map(item => item.text ?? '').join('\n');
}
export async function read(client: Client, operation: string, params: Record<string, unknown>): Promise<string> {
  return text(await client.callTool({ name: 'mcp_aql_read', arguments: { operation, params } }));
}

export class CompiledMemoryRuntime {
  readonly child: ChildProcess;
  readonly messages: Frame[] = [];
  readonly clients: Client[] = [];
  private readonly transports = new Map<Client, StreamableHTTPClientTransport>();
  private readonly pending = new Map<string, { resolve: (value: Frame) => void; reject: (cause: unknown) => void }>();
  private stderr = '';
  private ended = false;
  private closed = false;
  private closing?: Promise<void>;
  get finalClosed(): boolean { return this.closed; }
  url = '';

  constructor(directory: string, environment: Record<string, string>, port = 0) {
    const root = process.cwd();
    this.child = spawn(process.execPath, ['--import', path.join(root,
      'tests/integration/database/fixtures/authenticated-memory-observer.mjs'),
    path.join(root, 'dist/index.js'), '--http', `--port=${port}`], {
      cwd: directory,
      // Deliberately omit Jest/test and repository .env variables. This is the
      // actual main entrypoint, not an exported startup helper or TEST_MODE.
      env: { PATH: process.env.PATH, HOME: directory, ...environment,
        DOLLHOUSE_PROOF_COMPILED_ROOT: path.join(root, 'dist') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child.stdout!.on('data', () => undefined);
    this.child.stderr!.on('data', chunk => {
      // LocalDev intentionally prints its fixture token. Never retain it in
      // failure diagnostics; this observer does not alter the child's stream.
      this.stderr = (this.stderr + String(chunk)).slice(-32000)
        .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, '[owned fixture token redacted]');
      const match = /Streamable HTTP server listening on (https?:\/\/[^\s]+)/u.exec(this.stderr);
      if (match) this.url = match[1].endsWith('/mcp') ? match[1] : `${match[1]}/mcp`;
    });
    this.child.on('message', message => {
      const frame = message as Frame;
      this.messages.push(frame);
      const waiter = this.pending.get(frame.id);
      if (waiter) { this.pending.delete(frame.id); waiter.resolve(frame); }
    });
    this.child.once('close', (code, signal) => {
      this.closed = true;
      console.info(`[authenticated-memory:child] pid=${this.child.pid} exit=${code} signal=${signal} final-close`);
    });
    this.child.once('exit', () => {
      this.ended = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error('Owned compiled child exited'));
      this.pending.clear();
    });
  }

  async ready(): Promise<void> {
    await this.waitUntil(() => {
      if (this.ended) throw new Error(`Actual compiled startup refused: ${this.stderr}`);
      return !!this.url && this.messages.some(frame => frame.event === 'observer-ready');
    }, 60000);
  }
  async refused(): Promise<string> {
    await this.waitUntil(() => this.ended, 60000);
    if (this.url) throw new Error('Expected closed boot before HTTP listen');
    return this.stderr;
  }
  async waitUntil(check: () => boolean, milliseconds = 15000): Promise<void> {
    const end = Date.now() + milliseconds;
    while (!check()) {
      if (Date.now() >= end) throw new Error('Owned proof condition did not settle within its bound');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  async rpc(command: string, fields: Frame = {}): Promise<Frame> {
    if (!this.child.connected) throw new Error('Owned child IPC disconnected');
    const id = randomUUID();
    const result = new Promise<Frame>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    this.child.send!({ id, command, ...fields });
    return result;
  }
  async connect(token: string): Promise<Client> {
    const client = new Client({ name: 'owned-authenticated-memory-proof', version: '1.0.0' }, { capabilities: {} });
    this.clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    this.transports.set(client, transport);
    await client.connect(transport);
    return client;
  }
  async hold(client: Client, name: string): Promise<{ frame: Frame; response: Promise<string> }> {
    const start = this.messages.length;
    await this.rpc('arm');
    const controller = new AbortController();
    const response = client.callTool({ name: 'mcp_aql_read', arguments: { operation: 'get_element_details',
      params: { element_name: name, element_type: 'memories' } } }, undefined, { signal: controller.signal })
      .then(text, cause => {
        // The pinned SDK closes response handlers without clearing their
        // request timers. Explicitly settle this owned rejected request's
        // cancellation signal; preserve the exact rejection.
        controller.abort(cause); throw cause;
      });
    // Observe rejection immediately; the original promise is still returned.
    void response.catch(() => undefined);
    await this.waitUntil(() => this.messages.slice(start).some(frame => frame.event === 'invocation-held'));
    const frame = this.messages.slice(start).find(frame => frame.event === 'invocation-held')!;
    if (frame.tool !== 'mcp_aql_read' || !frame.request || !frame.session) throw new Error('Expected actual signed READ scope');
    return { frame, response };
  }
  async disconnect(client: Client): Promise<void> {
    // Real DELETE first. A stalled DELETE must not prevent transport abort,
    // child shutdown or honest preservation of both termination/close causes.
    const causes: unknown[] = [];
    let settled = false;
    const termination = (this.transports.get(client)?.terminateSession() ?? Promise.resolve()).then(
      () => { settled = true; }, cause => { settled = true; causes.push(cause); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([termination, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
      if (timer) clearTimeout(timer);
      if (!settled) causes.push(new Error('Owned SDK session termination did not settle before transport abort'));
      try { await client.close(); } catch (cause) { causes.push(cause); }
      // Pinned transport.close aborts terminateSession's actual fetch signal.
      // Require its original promise to settle before cleanup is proved.
      await Promise.race([termination, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned SDK termination remained unsettled after transport close')), 5000);
      })]).catch(cause => { causes.push(cause); });
    } finally {
      if (timer) clearTimeout(timer);
      this.transports.delete(client);
    }
    if (causes.length === 1) throw causes[0];
    if (causes.length) throw new AggregateError(causes, 'Owned SDK termination and transport close failed');
  }
  close(): Promise<void> {
    this.closing ??= this.closeOwned();
    return this.closing;
  }
  private async closeOwned(): Promise<void> {
    const outcomes = await Promise.allSettled(this.clients.map(client => this.disconnect(client)));
    if (!this.ended) {
      this.child.kill('SIGTERM');
      try { await this.waitUntil(() => this.closed, 10000); }
      catch { this.child.kill('SIGKILL'); await this.waitUntil(() => this.closed, 5000); }
    }
    // Exit can precede pipe/IPC settlement. Require final close even when
    // startup refused before callers requested cleanup.
    await this.waitUntil(() => this.closed, 5000);
    const failures = outcomes.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => (result as PromiseRejectedResult).reason),
      'Owned SDK sessions failed to close');
  }
}

export interface AuthenticatedFixture {
  f: EquivalentFixture;
  directory: string;
  token: string;
  foreignToken: string;
  environment: Record<string, string>;
  subject: string;
  foreignSubject: string;
  spawnConsole: (environment: Record<string, string>, port: number) => CompiledMemoryRuntime;
  spawn: (guarded?: boolean) => CompiledMemoryRuntime;
}
export async function ownedAuthenticated(caseName: string,
  body: (fixture: AuthenticatedFixture) => Promise<void>,
  initialRaw?: (name: string) => string,
  stageLegacy?: (fixture: EquivalentFixture) => Promise<void>): Promise<void> {
  const phase = (value: string) => console.info(`[authenticated-memory:${caseName}] ${value}`);
  phase('fixture-start');
  const f = await makeEquivalentFixture();
  let directory: string | undefined;
  const runtimes: CompiledMemoryRuntime[] = [];
  let failure: { cause: unknown } | undefined;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'authenticated-memory-'));
    if (initialRaw) await f.layer.writeContent('memories', f.name, initialRaw(f.name),
      { author: 'test-author', version: '1.0.0', description: '', tags: [] });
    if (stageLegacy) await stageLegacy(f);
    // Explicit owned fixture dirtiness, never manual qualification. The real
    // maintenance procedure below must independently inspect and qualify it.
    if (initialRaw || stageLegacy) await f.maintenance`UPDATE public.elements
      SET memory_entries_out_of_sync=true WHERE id=${f.memoryId}::uuid`;
    const reconciler = new DatabaseMemoryEquivalentReconciler(f.db, () => f.userId, f.maintenance, f.roleName);
    const prepared = await reconciler.prepareEquivalent({ userId: f.userId, memoryId: f.memoryId });
    if (!prepared.proposal) throw new Error(`Owned baseline lacks real reconciliation eligibility: ${JSON.stringify(prepared.inspection.diagnostics)}`);
    const qualified = await reconciler.qualifyEquivalent(prepared.proposal, f.request());
    if (qualified.status !== 'qualified') throw new Error(`Owned baseline reconciliation refused: ${JSON.stringify(qualified)}`);
    await f.maintenance`INSERT INTO public.memory_backend_modes(user_id,backend,protocol_version,profile,mode,generation)
      VALUES(${f.userId}::uuid,'database',1,${DATABASE_MEMORY_ADMISSION_PROFILE},'guarded',1),
      (${f.foreignUserId}::uuid,'database',1,${DATABASE_MEMORY_ADMISSION_PROFILE},'guarded',1),
      (${SYSTEM_USER_UUID}::uuid,'database',1,${DATABASE_MEMORY_LEGACY_PROFILE},'legacy',1)`;
    await f.maintenance`INSERT INTO public.memory_candidate_quotas(user_id)
      VALUES(${f.userId}::uuid),(${f.foreignUserId}::uuid)`;
    const subject = `owned-${randomUUID()}`;
    const foreignSubject = `owned-${randomUUID()}`;
    await f.maintenance`INSERT INTO public.auth_accounts(provider,external_sub,sub,user_id)
      VALUES('local',${subject},${subject},${f.userId}::uuid),
      ('local',${foreignSubject},${foreignSubject},${f.foreignUserId}::uuid)`;
    const keyFile = path.join(directory, 'local-es256.json');
    const auth = new LocalDevAuthProvider({ keyFilePath: keyFile });
    const token = await auth.issue(subject, { displayName: f.runtime.selectedUsername, scopes: ['mcp'] });
    const foreignToken = await auth.issue(foreignSubject, { displayName: f.runtime.foreignUsername, scopes: ['mcp'] });
    const environment = {
      DOLLHOUSE_USER: f.runtime.selectedUsername, DOLLHOUSE_PORTFOLIO_DIR: path.join(directory, 'portfolio'),
      MCP_INTERFACE_MODE: 'mcpaql', DOLLHOUSE_STORAGE_BACKEND: 'database',
      DOLLHOUSE_DATABASE_URL: f.runtime.appUrl, DOLLHOUSE_DATABASE_ADMIN_URL: f.runtime.systemUrl,
      DOLLHOUSE_DATABASE_POOL_SIZE: '3', DOLLHOUSE_DATABASE_SSL: 'disable',
      DOLLHOUSE_DATABASE_MEMORY_GUARDED: 'true', DOLLHOUSE_AUTH_ENABLED: 'true',
      DOLLHOUSE_AUTH_PROVIDER: 'local', DOLLHOUSE_AUTH_LOCAL_KEY_FILE: keyFile,
      DOLLHOUSE_MASTER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      DOLLHOUSE_WEB_CONSOLE: 'false', DOLLHOUSE_HTTP_WEB_CONSOLE: 'false',
      DOLLHOUSE_PERMISSION_SERVER: 'false', DOLLHOUSE_ENABLE_FILE_WATCHER: 'false',
      AUTO_RELOAD_ON_EXTERNAL_CHANGE: 'false', DOLLHOUSE_LOG_FLUSH_INTERVAL_MS: '100',
    };
    const fixture: AuthenticatedFixture = { f, directory, token, foreignToken, environment, subject, foreignSubject,
      spawnConsole: (consoleEnvironment, port) => {
        const childDirectory = path.join(directory!, `console-runtime-${randomUUID()}`);
        mkdirSync(childDirectory, { mode: 0o700 });
        const { DOLLHOUSE_AUTH_PROVIDER: _localProvider, DOLLHOUSE_AUTH_LOCAL_KEY_FILE: _localKey, ...common } = environment;
        const runtime = new CompiledMemoryRuntime(childDirectory, { ...common, ...consoleEnvironment,
          DOLLHOUSE_RUN_DIR: path.join(childDirectory, 'run'), DOLLHOUSE_PORTFOLIO_DIR: path.join(childDirectory, 'portfolio'),
          DOLLHOUSE_CACHE_DIR: path.join(childDirectory, 'cache'), DOLLHOUSE_LOG_DIR: path.join(childDirectory, 'logs') }, port);
        runtimes.push(runtime); return runtime;
      },
      spawn: (guarded = true) => {
        const childDirectory = path.join(directory!, `runtime-${randomUUID()}`);
        mkdirSync(childDirectory, { mode: 0o700 });
        const runtime = new CompiledMemoryRuntime(childDirectory, { ...environment,
          DOLLHOUSE_PORTFOLIO_DIR: path.join(childDirectory, 'portfolio'),
          DOLLHOUSE_DATABASE_MEMORY_GUARDED: String(guarded) });
        runtimes.push(runtime);
        return runtime;
      } };
    phase('fixture-end'); phase('lifecycle-start');
    await body(fixture);
    phase('assertions-complete');
  } catch (cause) { failure = { cause }; }
  phase('cleanup-start');
  const childOutcomes = await Promise.allSettled(runtimes.map(runtime => runtime.close()));
  if (runtimes.some(runtime => !runtime.finalClosed)) {
    throw new AggregateError([...(failure ? [failure.cause] : []),
      ...childOutcomes.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason)],
    'Owned child final close unproven; database, role and directory preserved');
  }
  const resourceOutcomes = await Promise.allSettled([f.cleanup(), directory
    ? rm(directory, { recursive: true, force: true }) : Promise.resolve()]);
  const failures = [...childOutcomes, ...resourceOutcomes].filter(result => result.status === 'rejected')
    .map(result => (result as PromiseRejectedResult).reason);
  if (failures.length) throw new AggregateError(failure ? [failure.cause, ...failures] : failures,
    'Owned authenticated proof or cleanup failed');
  console.info(`[authenticated-memory:resources] database=${new URL(f.runtime.appUrl).pathname.slice(1)} role=${f.roleName} directory=${directory ?? 'not-created'} removed`);
  phase('cleanup-end');
  if (failure) throw failure.cause;
}
