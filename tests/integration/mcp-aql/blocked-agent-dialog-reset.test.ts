import { expect, it } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createConnection, createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_BLOCK_SNAPSHOT_BYTES } from '../../../src/state/readDangerZoneBlockSnapshot.js';
import { isolatedServerEnv } from '../../helpers/isolated-server-env.cjs';

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject).listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function consoleIsListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const finish = (listening: boolean) => { socket.destroy(); resolve(listening); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

function approvalTransport(home: string, portfolio: string, tokenFile: string, port: number): StdioClientTransport {
  const childEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([, value]) => value !== undefined)) as Record<string, string>;
  delete childEnv.JEST_WORKER_ID;
  delete childEnv.NODE_OPTIONS;
  return new StdioClientTransport({
    command: process.execPath,
    args: ['--import', './tests/fixtures/security/approve-native-block-reset.mjs', 'dist/index.js'],
    env: isolatedServerEnv(home, {
      ...childEnv,
      NODE_ENV: 'test',
      TEST_MODE: 'true',
      MCP_INTERFACE_MODE: 'mcpaql',
      DOLLHOUSE_STORAGE_BACKEND: 'file',
      DOLLHOUSE_PORTFOLIO_DIR: portfolio,
      DOLLHOUSE_CONSOLE_TOKEN_FILE: tokenFile,
      DOLLHOUSE_WEB_CONSOLE: 'false',
      DOLLHOUSE_HTTP_WEB_CONSOLE: 'false',
      DOLLHOUSE_PERMISSION_SERVER: 'false',
      DOLLHOUSE_WEB_CONSOLE_PORT: String(port),
      DISPLAY: ':fixture',
      GITHUB_TOKEN: '',
    }),
    stderr: 'pipe',
  });
}

async function request(client: Client, operation: string, params: Record<string, unknown> = {}) {
  const response = await client.callTool({
    name: 'mcp_aql_create', arguments: { operation, params },
  });
  const [content] = response.content as { type: string; text: string }[];
  return JSON.parse(content.text);
}

it.each(['malformed', 'oversized'] as const)('provisions basic approval with the console disabled and resets the %s snapshot', async kind => {
  const home = await mkdtemp(path.join(tmpdir(), 'stdio-block-reset-'));
  const state = path.join(home, '.dollhouse', 'security');
  const portfolio = path.join(home, 'portfolio');
  const tokenFile = path.join(home, 'console-token.json');
  const damaged = path.join(state, 'blocked-agents.json');
  const port = await reservePort();
  await Promise.all([mkdir(state, { recursive: true }), mkdir(portfolio)]);
  const bytes = kind === 'oversized' ? Buffer.alloc(MAX_BLOCK_SNAPSHOT_BYTES + 1, 0x20) : Buffer.from('{');
  if (kind === 'oversized') bytes.write('{"version":1,"blocks":{}}');
  await writeFile(damaged, bytes);
  const transport = approvalTransport(home, portfolio, tokenFile, port);
  const client = new Client({ name: 'block-reset-fixture', version: '1.0.0' });
  try {
    await client.connect(transport);
    // Startup establishes the tier before any reset operation is requested.
    const basic = JSON.parse(await readFile(tokenFile, 'utf8'));
    expect(basic.totp.enrolled).toBe(false);
    expect(basic).not.toHaveProperty('enrollmentState');
    const invalid = await request(client, 'request_blocked_agent_reset', { approved: true });
    expect(invalid.data?.reset).not.toBe(true);
    expect((await readFile(damaged)).equals(bytes)).toBe(true);
    expect(await request(client, 'request_blocked_agent_reset')).toMatchObject({ success: true, data: { reset: true, status: 'approved' } });
    expect(JSON.parse(await readFile(damaged, 'utf8'))).toEqual({ version: 1, blocks: {} });
    const backups = (await readdir(state)).filter(name => name.endsWith('.backup'));
    expect(backups).toHaveLength(1);
    expect((await readFile(path.join(state, backups[0]))).equals(bytes)).toBe(true);
    expect(await consoleIsListening(port)).toBe(false);
  } finally {
    await client.close();
    await transport.close();
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);

it('releases a block and a permission deadlock through the stdio dialog without MCP proof', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'stdio-approval-'));
  const portfolio = path.join(home, 'portfolio');
  await mkdir(portfolio);
  const transport = approvalTransport(home, portfolio, path.join(home, 'console-token.json'), await reservePort());
  const client = new Client({ name: 'dialog-approval-fixture', version: '1.0.0' });
  try {
    await client.connect(transport);
    const block = await request(client, 'beetlejuice_beetlejuice_beetlejuice');
    expect(block).toMatchObject({ success: true, data: { triggered: true, challenge_id: expect.any(String) } });
    expect(await request(client, 'verify_challenge', { challenge_id: block.data.challenge_id })).toMatchObject({
      success: true,
      data: { verified: true, unblockedAgent: 'beetlejuice-test-agent' },
    });
    expect(await request(client, 'release_deadlock', { approved: true })).toMatchObject({ success: false });
    expect(await request(client, 'release_deadlock')).toMatchObject({
      success: true, data: { released: true, persistedStateCleared: true },
    });
  } finally {
    await client.close();
    await transport.close();
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);
