import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const hookScript = process.env.HOOK_SCRIPT;
const hookPayloadB64 = process.env.HOOK_PAYLOAD_B64;
const mockResponseB64 = process.env.MOCK_RESPONSE_B64;
const hookEnvB64 = process.env.HOOK_ENV_B64;
const portDiscoveryMode = process.env.PORT_DISCOVERY_MODE ?? 'shared';
const port = Number(process.env.MOCK_SERVER_PORT ?? '41715');

if (!hookScript || !hookPayloadB64 || !mockResponseB64) {
  throw new Error('HOOK_SCRIPT, HOOK_PAYLOAD_B64, and MOCK_RESPONSE_B64 are required');
}

const hookPayload = JSON.parse(Buffer.from(hookPayloadB64, 'base64').toString('utf-8'));
const mockResponse = JSON.parse(Buffer.from(mockResponseB64, 'base64').toString('utf-8'));
const hookEnv = hookEnvB64
  ? JSON.parse(Buffer.from(hookEnvB64, 'base64').toString('utf-8'))
  : {};

const tempHome = await mkdtemp(join(tmpdir(), 'dollhouse-hook-home-'));
const runDir = join(tempHome, '.dollhouse', 'run');
const sharedPortFile = join(runDir, 'permission-server.port');
const pidPortFile = join(runDir, `permission-server-${process.pid}.port`);

await mkdir(runDir, { recursive: true });

if (portDiscoveryMode === 'shared' || portDiscoveryMode === 'both') {
  await writeFile(sharedPortFile, String(port), 'utf-8');
}
if (portDiscoveryMode === 'pid' || portDiscoveryMode === 'both') {
  await writeFile(pidPortFile, String(port), 'utf-8');
}

let capturedRequestBody = null;
const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/evaluate_permission') {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', () => {
    capturedRequestBody = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockResponse));
  });
});

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

const result = await new Promise((resolve) => {
  const child = spawn('bash', [hookScript], {
    env: {
      ...process.env,
      ...hookEnv,
      HOME: tempHome,
      PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      DOLLHOUSE_SESSION_ID: 'docker-hook-session',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('close', exitCode => {
    resolve({ exitCode: exitCode ?? 0, stdout, stderr });
  });

  child.stdin.write(JSON.stringify(hookPayload));
  child.stdin.end();
});

await new Promise((resolve) => server.close(() => resolve()));
await rm(tempHome, { recursive: true, force: true });

process.stdout.write(JSON.stringify({
  ...result,
  requestBody: capturedRequestBody,
}));
