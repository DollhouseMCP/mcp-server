import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import postgres from 'postgres';

const execFileAsync = promisify(execFile);
const runDirectory = path.join(process.cwd(), '.onboarding-browser');
const statePath = path.join(runDirectory, 'state.json');

export default async function globalSetup(): Promise<void> {
  mkdirSync(runDirectory, { recursive: true });
  const databaseName = `dollhousemcp_onboarding_browser_${randomBytes(4).toString('hex')}`;
  const adminTemplate = postgresAdminTemplate();
  const databaseUrl = withDatabase(adminTemplate, databaseName);
  const admin = postgres(withDatabase(adminTemplate, 'postgres'), { ssl: false, max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${databaseName}`); } finally { await admin.end({ timeout: 5 }); }
  const children: ChildProcess[] = [];
  try {
    await execFileAsync('npx', ['drizzle-kit', 'migrate'], { cwd: process.cwd(),
      env: { ...process.env, DOLLHOUSE_DATABASE_ADMIN_URL: databaseUrl }, maxBuffer: 32 * 1024 * 1024 });
    const [firstPort, secondPort, proxyPort] = await Promise.all([freePort(), freePort(), freePort()]);
    const origin = `https://127.0.0.1:${proxyPort}`;
    const controlSecret = randomBytes(32).toString('base64url');
    const common: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', ONBOARDING_BROWSER_DATABASE_URL: databaseUrl,
      ONBOARDING_BROWSER_ORIGIN: origin, ONBOARDING_BROWSER_CONTROL_SECRET: controlSecret,
      ONBOARDING_BROWSER_INVITER_ID: randomUUID(), ONBOARDING_BROWSER_UNRELATED_ID: randomUUID(),
      ONBOARDING_BROWSER_PROVIDER_EMAIL: `${randomUUID()}@provider.test`,
      ONBOARDING_BROWSER_GITHUB_ID: String(randomInt(1, 2 ** 48 - 1)),
      ONBOARDING_BROWSER_OAUTH_CODE: `browser-code-${randomUUID()}`,
      ONBOARDING_BROWSER_OAUTH_TOKEN: `browser-token-${randomUUID()}`,
      ONBOARDING_BROWSER_GITHUB_SECRET: randomBytes(32).toString('base64url'),
      ONBOARDING_BROWSER_OPAQUE_KEY: randomBytes(32).toString('base64url') };
    const forcedFailure = process.env.ONBOARDING_BROWSER_FORCE_STARTUP_FAILURE;
    children.push(await boot('replica-a', firstPort, { ...common,
      ONBOARDING_BROWSER_FIXTURE_MODE: forcedFailure === 'replica-a' ? 'forced-failure' : 'replica',
      ONBOARDING_BROWSER_FAILURE_MARKER: process.env.ONBOARDING_BROWSER_FAILURE_MARKER,
      ONBOARDING_BROWSER_REPLICA: 'a' }));
    children.push(await boot('replica-b', secondPort, { ...common, ONBOARDING_BROWSER_FIXTURE_MODE: 'replica', ONBOARDING_BROWSER_REPLICA: 'b' }));
    children.push(await boot('proxy', proxyPort, { ...common, ONBOARDING_BROWSER_FIXTURE_MODE: 'proxy',
      ONBOARDING_BROWSER_REPLICA_A: `http://127.0.0.1:${firstPort}`, ONBOARDING_BROWSER_REPLICA_B: `http://127.0.0.1:${secondPort}`,
      ONBOARDING_BROWSER_TLS_KEY: path.join(process.cwd(), 'tests/fixtures/tls/pinned-outbound/address-key.pem'),
      ONBOARDING_BROWSER_TLS_CERT: path.join(process.cwd(), 'tests/fixtures/tls/pinned-outbound/address-cert.pem') }));
    process.env.ONBOARDING_BROWSER_ORIGIN = origin;
    process.env.ONBOARDING_BROWSER_REPLICA_A = `http://127.0.0.1:${firstPort}`;
    process.env.ONBOARDING_BROWSER_CONTROL_SECRET = controlSecret;
    process.env.ONBOARDING_BROWSER_OAUTH_CODE = common.ONBOARDING_BROWSER_OAUTH_CODE;
    process.env.ONBOARDING_BROWSER_PROVIDER_EMAIL = common.ONBOARDING_BROWSER_PROVIDER_EMAIL;
    const pids = children.map(child => child.pid);
    if (pids.some(pid => pid === undefined)) throw new Error('Browser fixture process has no pid');
    writeFileSync(statePath, JSON.stringify({ databaseName, pids }));
  } catch (error) {
    await Promise.all(children.map(stopChild));
    await dropDatabase(adminTemplate, databaseName);
    throw error;
  }
}

async function boot(label: string, port: number, env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const runner = path.join(process.cwd(), 'tests/integration/onboarding-browser/fixture/runner.ts');
  const child = spawn(process.execPath, [path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), runner], {
    cwd: process.cwd(), detached: true, env: { ...env, ONBOARDING_BROWSER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.resume();
  try {
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const finish = (result: () => void) => {
        clearTimeout(timer); child.off('error', failed); child.off('exit', failed); child.stdout?.off('data', ready);
        child.stdout?.resume(); result();
      };
      const failed = () => finish(() => reject(new Error('startup')));
      const ready = (data: Buffer) => { if (String(data).includes('READY')) finish(resolve); };
      timer = setTimeout(failed, 30_000);
      child.once('error', failed); child.once('exit', failed); child.stdout?.on('data', ready);
    });
    return child;
  } catch {
    await stopChild(child);
    throw new Error(`Browser fixture ${label} failed to start`);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    new Promise<void>(resolve => setTimeout(resolve, 500)),
  ]);
  if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate fixture port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

function postgresAdminTemplate(): string {
  return process.env.ONBOARDING_BROWSER_PG_ADMIN_URL ?? process.env.DOLLHOUSE_TEST_DATABASE_ADMIN_URL ??
    process.env.DOLLHOUSE_TEST_DATABASE_URL ?? 'postgres://dollhouse:dollhouse@127.0.0.1:5432/postgres';
}
function withDatabase(template: string, database: string): string { const url = new URL(template); url.pathname = `/${database}`; return url.toString(); }
async function dropDatabase(template: string, database: string): Promise<void> {
  const admin = postgres(withDatabase(template, 'postgres'), { ssl: false, max: 1, onnotice: () => {} });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}
