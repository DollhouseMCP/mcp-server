import { expect, it } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createConnection, createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_BLOCK_SNAPSHOT_BYTES } from '../../../src/state/readDangerZoneBlockSnapshot.js';
import { isolatedServerEnv } from '../../helpers/isolated-server-env.cjs';
import { callTool } from '../../helpers/httpTransportHelper.js';

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

function approvalTransport(
  home: string, portfolio: string, tokenFile: string, port: number, desktop: 'local' | 'ssh' | 'suppressed' = 'local',
): StdioClientTransport {
  const childEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([, value]) => value !== undefined)) as Record<string, string>;
  delete childEnv.JEST_WORKER_ID;
  delete childEnv.NODE_OPTIONS;
  delete childEnv.SSH_CLIENT;
  delete childEnv.SSH_TTY;
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
      DISPLAY: desktop === 'ssh' ? '' : ':fixture',
      WAYLAND_DISPLAY: '',
      SSH_CONNECTION: desktop === 'ssh' ? '192.0.2.1 51500 192.0.2.2 22' : '',
      DOLLHOUSE_TEST_STUB_APPROVALS: String(desktop !== 'suppressed'),
      GITHUB_TOKEN: '',
    }),
    stderr: 'pipe',
  });
}

async function request(
  client: Client, operation: string, params: Record<string, unknown> = {}, timeout?: number,
) {
  const response = await client.callTool({
    name: 'mcp_aql_create', arguments: { operation, params },
  }, undefined, { timeout });
  const [content] = response.content as { type: string; text: string }[];
  // Stdio adds an active-element policy digest after the JSON response.
  return JSON.parse(content.text.split('\n\n', 1)[0]);
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

it('refuses a blocked-agent reset with native dialogs suppressed by the integration environment', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'stdio-suppressed-block-reset-'));
  const state = path.join(home, '.dollhouse', 'security');
  const portfolio = path.join(home, 'portfolio');
  const snapshot = path.join(state, 'blocked-agents.json');
  const transport = approvalTransport(home, portfolio, path.join(home, 'console-token.json'), await reservePort(), 'suppressed');
  const client = new Client({ name: 'suppressed-block-reset-fixture', version: '1.0.0' });
  try {
    await Promise.all([mkdir(state, { recursive: true }), mkdir(portfolio)]);
    await writeFile(snapshot, '{');
    await client.connect(transport);

    // If suppression is bypassed, the dialog fixture would approve the reset.
    expect(await request(client, 'request_blocked_agent_reset', {}, 5_000))
      .toMatchObject({ success: true, data: { reset: false, status: 'desktop_unavailable' } });
    expect(await readFile(snapshot, 'utf8')).toBe('{');
    const evidence = (await readdir(state)).filter(name => name.endsWith('.backup'));
    expect(evidence).toHaveLength(1);
    expect(await readFile(path.join(state, evidence[0]), 'utf8')).toBe('{');
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

it('refuses headless SSH releases promptly and points the operator to recovery', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'stdio-headless-approval-'));
  const portfolio = path.join(home, 'portfolio');
  await mkdir(portfolio);
  const snapshot = path.join(home, '.dollhouse', 'security', 'blocked-agents.json');
  const transport = approvalTransport(home, portfolio, path.join(home, 'console-token.json'), await reservePort(), 'ssh');
  const client = new Client({ name: 'headless-approval-fixture', version: '1.0.0' });
  try {
    await client.connect(transport);
    const block = await request(client, 'beetlejuice_beetlejuice_beetlejuice');
    expect(block).toMatchObject({ success: true, data: { challenge_id: expect.any(String) } });
    const blockedBefore = await readFile(snapshot, 'utf8');
    expect(await request(client, 'verify_challenge', { challenge_id: block.data.challenge_id }, 5_000))
      .toMatchObject({
        success: true,
        data: {
          verified: false, status: 'desktop_unavailable',
          message: expect.stringContaining('docs/guides/dangerzone-offline-single-block-recovery.md'),
        },
      });
    expect(await readFile(snapshot, 'utf8')).toBe(blockedBefore);

    expect(await request(client, 'create_element', {
      element_name: 'headless-fixture', element_type: 'skill',
      description: 'Verify that a refused deadlock release preserves the active skill.',
      content: 'Keep this skill active.',
    })).toMatchObject({ success: true });
    expect(await callTool(client, 'mcp_aql_read', {
      operation: 'activate_element', params: { element_name: 'headless-fixture', element_type: 'skill' },
    })).toContain("Skill 'headless-fixture' activated");
    const listActiveSkills = () => callTool(client, 'mcp_aql_read', {
      operation: 'get_active_elements', params: { element_type: 'skill' },
    });
    expect(await listActiveSkills()).toContain('Active skills: 🛠️ headless-fixture');
    expect(await request(client, 'release_deadlock', {}, 5_000))
      .toMatchObject({
        success: true,
        data: {
          released: false, status: 'desktop_unavailable',
          message: expect.stringContaining('docs/security/deadlock-relief-flow.md#headless-stdio'),
        },
      });
    expect(await listActiveSkills()).toContain('Active skills: 🛠️ headless-fixture');
  } finally {
    await client.close();
    await transport.close();
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);
