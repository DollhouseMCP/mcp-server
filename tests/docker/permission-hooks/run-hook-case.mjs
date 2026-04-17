import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_MOCK_SERVER_PORT = 41715;
const hookScript = process.env.HOOK_SCRIPT;
const hookPayloadB64 = process.env.HOOK_PAYLOAD_B64;
const mockResponseB64 = process.env.MOCK_RESPONSE_B64;
const hookEnvB64 = process.env.HOOK_ENV_B64;
const portDiscoveryMode = process.env.PORT_DISCOVERY_MODE ?? 'shared';
const port = Number(process.env.MOCK_SERVER_PORT ?? String(DEFAULT_MOCK_SERVER_PORT));

if (!hookScript || !hookPayloadB64 || !mockResponseB64) {
  throw new Error('HOOK_SCRIPT, HOOK_PAYLOAD_B64, and MOCK_RESPONSE_B64 are required');
}

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`MOCK_SERVER_PORT must be a valid TCP port, received ${process.env.MOCK_SERVER_PORT ?? 'undefined'}`);
}

const hookPayload = parseJsonEnvironmentVariable(hookPayloadB64, 'HOOK_PAYLOAD_B64');
const mockResponse = parseJsonEnvironmentVariable(mockResponseB64, 'MOCK_RESPONSE_B64');
const hookEnv = hookEnvB64
  ? parseStringRecord(parseJsonEnvironmentVariable(hookEnvB64, 'HOOK_ENV_B64'), 'HOOK_ENV_B64')
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
    try {
      capturedRequestBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockResponse));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Malformed JSON request body: ${error instanceof Error ? error.message : String(error)}`,
      }));
    }
  });
});

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

const result = await new Promise((resolve) => {
  const child = spawn('bash', [hookScript], {
    env: {
      ...hookEnv,
      HOME: tempHome,
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

function parseJsonEnvironmentVariable(encodedValue, envName) {
  let decodedValue;
  try {
    decodedValue = Buffer.from(encodedValue, 'base64').toString('utf-8');
  } catch (error) {
    throw new Error(`${envName} is not valid base64: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return JSON.parse(decodedValue);
  } catch (error) {
    throw new Error(`${envName} does not contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseStringRecord(value, envName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${envName} must decode to a JSON object`);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      if (typeof entryValue !== 'string') {
        throw new TypeError(`${envName}.${key} must be a string`);
      }
      return [key, entryValue];
    }),
  );
}
