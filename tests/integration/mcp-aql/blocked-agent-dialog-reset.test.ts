import { expect, it } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createConnection, createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

it('provisions basic approval at trusted stdio startup with the console disabled and runs the dialog reset', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'stdio-block-reset-'));
  const state = path.join(home, '.dollhouse', 'security');
  const portfolio = path.join(home, 'portfolio');
  const tokenFile = path.join(home, 'console-token.json');
  const damaged = path.join(state, 'blocked-agents.json');
  const port = await reservePort();
  await Promise.all([mkdir(state, { recursive: true }), mkdir(portfolio)]);
  await writeFile(damaged, '{');
  const childEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([, value]) => value !== undefined)) as Record<string, string>;
  delete childEnv.JEST_WORKER_ID;
  delete childEnv.NODE_OPTIONS;
  const transport = new StdioClientTransport({
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
  const client = new Client({ name: 'block-reset-fixture', version: '1.0.0' });
  try {
    await client.connect(transport);
    // Startup establishes the tier before any reset operation is requested.
    const basic = JSON.parse(await readFile(tokenFile, 'utf8'));
    expect(basic.totp.enrolled).toBe(false);
    expect(basic).not.toHaveProperty('enrollmentState');
    const request = async (params: Record<string, unknown>) => {
      const response = await client.callTool({
        name: 'mcp_aql_create', arguments: { operation: 'request_blocked_agent_reset', params },
      });
      const [content] = response.content as { type: string; text: string }[];
      return JSON.parse(content.text);
    };
    const invalid = await request({ approved: true });
    expect(invalid.data?.reset).not.toBe(true);
    expect(await readFile(damaged, 'utf8')).toBe('{');
    expect(await request({})).toMatchObject({ success: true, data: { reset: true, status: 'approved' } });
    expect(JSON.parse(await readFile(damaged, 'utf8'))).toEqual({ version: 1, blocks: {} });
    expect((await readdir(state)).filter(name => name.endsWith('.backup'))).toHaveLength(1);
    expect(await consoleIsListening(port)).toBe(false);
  } finally {
    await client.close();
    await transport.close();
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);
