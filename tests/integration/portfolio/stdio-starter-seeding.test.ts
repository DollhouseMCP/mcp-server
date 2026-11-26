import { expect, it } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ElementType } from '../../../src/portfolio/types.js';
import { isBundledElementFilename } from '../../../src/storage/elementFileExtensions.js';
import { isolatedServerEnv } from '../../helpers/isolated-server-env.cjs';

async function withStdioServer(home: string, work: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({ name: 'fresh-starter-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('dist/index.js')],
    cwd: home,
    env: isolatedServerEnv(home, {
      NODE_ENV: 'production',
      MCP_INTERFACE_MODE: 'mcpaql',
      DOLLHOUSE_WEB_CONSOLE: 'false',
      DOLLHOUSE_PERMISSION_SERVER: 'false',
    }),
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    await work(client);
  } finally {
    await client.close();
    await transport.close();
  }
}

async function listElements(client: Client, type: ElementType) {
  const response = await client.callTool({
    name: 'mcp_aql_read',
    arguments: { operation: 'list_elements', element_type: type },
  });
  const [content] = response.content as { type: string; text: string }[];
  return JSON.parse(content.text);
}

it('seeds the default local portfolio before the first stdio request and preserves edits across restart', async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'stdio-starters-')));
  const root = path.join(home, 'DollhouseMCP');
  const portfolio = path.join(root, 'users', 'local-user', 'portfolio');
  try {
    await withStdioServer(home, async client => {
      expect(await readdir(root)).toContain('.dollhouse-per-user-layout');
      for (const type of Object.values(ElementType)) {
        const filenames = (await readdir(new URL(`../../../data/${type}/`, import.meta.url)))
          .filter(name => isBundledElementFilename(name, type));
        expect(filenames.length).toBeGreaterThan(0);
        expect(await listElements(client, type)).toMatchObject({
          success: true,
          data: { pagination: { totalItems: filenames.length } },
        });
        expect(await readdir(path.join(portfolio, type))).toEqual(expect.arrayContaining(filenames));
      }
      await expect(readdir(path.join(home, '.dollhouse', 'portfolio'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    const updated = path.join(portfolio, 'skills', 'code-review.md');
    const removed = path.join(portfolio, 'skills', 'translation.md');
    const edited = (await readFile(updated, 'utf8')) + '\nKeep this user edit.\n';
    await writeFile(updated, edited);
    await rm(removed);
    await withStdioServer(home, async client => {
      expect(await listElements(client, ElementType.SKILL)).toMatchObject({
        success: true,
        data: { pagination: { totalItems: 7 } },
      });
      expect(await readFile(updated, 'utf8')).toBe(edited);
      await expect(readFile(removed)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);
