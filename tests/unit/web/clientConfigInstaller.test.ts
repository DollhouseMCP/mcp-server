import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
import { parse as parseToml } from 'smol-toml';
import { clientConfigTarget, installClientConfig } from '../../../src/web/routes/clientConfigInstaller.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'client-installer-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const clients = ['claude', 'cline', 'roo-cline', 'windsurf', 'witsy', 'enconvo', 'cursor', 'gemini-cli', 'vscode', 'claude-code', 'goose', 'zed', 'codex'];

describe('config-only installer', () => {
  it.each(clients)('preserves unrelated %s settings and servers across repeated installs', async client => {
    const environment = { home, platform: 'linux', env: {} };
    const target = clientConfigTarget(client, environment);
    await mkdir(dirname(target.path), { recursive: true });
    const existing = target.format === 'yaml' ? 'theme: dark\nextensions:\n  other:\n    enabled: true\n'
      : target.format === 'toml' ? 'theme = "dark"\n[mcp_servers.other]\ncommand = "existing"\n'
        : JSON.stringify(client === 'vscode' ? { theme: 'dark', mcp: { inputs: ['retained'], servers: { other: { command: 'existing' } } } }
          : { theme: 'dark', [target.keys[0]]: { other: { command: 'existing' } } });
    await writeFile(target.path, existing);
    await installClientConfig(client, 'beta', environment);
    const first = await readFile(target.path, 'utf8');
    const parsed = target.format === 'yaml' ? load(first) as any : target.format === 'toml' ? parseToml(first) : JSON.parse(first);
    expect(parsed.theme).toBe('dark');
    const servers = target.keys.reduce((value, key) => value[key], parsed);
    expect(servers.other).toBeDefined();
    expect(servers.dollhousemcp.command).toBe('npx');
    expect(servers.dollhousemcp.args).toEqual(['@dollhousemcp/mcp-server@beta']);
    if (client === 'vscode') expect(parsed.mcp.inputs).toEqual(['retained']);
    if (client === 'goose') expect(servers.dollhousemcp).toMatchObject({ cmd: 'npx', enabled: true, type: 'stdio', timeout: 300 });
    if (client === 'zed') expect(servers.dollhousemcp.source).toBe('custom');
    await installClientConfig(client, 'beta', environment);
    expect(await readFile(target.path, 'utf8')).toBe(first);
    expect((await readdir(dirname(target.path))).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('retains platform, XDG, APPDATA and CODEX_HOME path contracts', () => {
    expect(clientConfigTarget('claude', { home, platform: 'darwin', env: {} }).path).toBe(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    expect(clientConfigTarget('vscode', { home, platform: 'linux', env: { XDG_CONFIG_HOME: '/custom-xdg' } }).path).toBe(join('/custom-xdg', 'Code', 'User', 'settings.json'));
    expect(clientConfigTarget('zed', { home, platform: 'win32', env: { APPDATA: '/custom-appdata' } }).path).toBe(join('/custom-appdata', 'Zed', 'settings.json'));
    expect(clientConfigTarget('codex', { home, env: { CODEX_HOME: '/custom-codex' } }).path).toBe(join('/custom-codex', 'config.toml'));
  });

  it('produces Warp copyable config without writing a file', async () => {
    const output = await installClientConfig('warp', 'rc', { home });
    const config = JSON.parse(output.slice(output.indexOf('{')));
    expect(config.dollhousemcp).toMatchObject({ start_on_launch: true, args: ['@dollhousemcp/mcp-server@rc'] });
    expect(await readdir(home)).toEqual([]);
  });

  it('updates a managed symlink target atomically and refuses dangling links', async () => {
    const environment = { home, env: {} };
    const target = clientConfigTarget('cursor', environment);
    const managed = join(home, 'managed.json');
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(managed, '{"theme":"dark"}');
    await symlink(managed, target.path);
    await installClientConfig('cursor', 'latest', environment);
    expect((await lstat(target.path)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(managed, 'utf8')).mcpServers.dollhousemcp).toBeDefined();
    await rm(managed);
    await expect(installClientConfig('cursor', 'latest', environment)).rejects.toThrow('symlink target is unavailable');
    expect((await lstat(target.path)).isSymbolicLink()).toBe(true);
  });

  it('bounds YAML alias text expansion before writing', async () => {
    const environment = { home, env: {} };
    const target = clientConfigTarget('goose', environment);
    await mkdir(dirname(target.path), { recursive: true });
    const source = `extensions: {}\nscalar: &large ${'x'.repeat(4096)}\nrepeated: [${Array(1100).fill('*large').join(', ')}]\n`;
    await writeFile(target.path, source);
    await expect(installClientConfig('goose', 'latest', environment)).rejects.toThrow('text expansion limit');
    expect(await readFile(target.path, 'utf8')).toBe(source);
  });

  it.each(['vscode', 'zed'])('explains unsupported comments and leaves %s JSONC settings untouched', async client => {
    const environment = { home, platform: 'linux', env: {} };
    const target = clientConfigTarget(client, environment);
    await mkdir(dirname(target.path), { recursive: true });
    const sources = [
      '{\n  "docs": "https://example.com",\n  // Keep this comment\n  "theme": "dark"\n}\n',
      '{\n  /* Keep this block comment */\n  "theme": "dark"\n}\n',
      `{ "note": ${JSON.stringify('Escaped quote: " // still a string')}, /* Real comment */ "theme": "dark" }`,
      `{ "note": ${JSON.stringify('Trailing backslash: \\')}, // Real comment\n "theme": "dark" }`,
    ];
    for (const source of sources) {
      await writeFile(target.path, source);
      await expect(installClientConfig(client, 'latest', environment)).rejects.toThrow(/contains comments.*file left untouched/);
      expect(await readFile(target.path, 'utf8')).toBe(source);
      expect(await readdir(dirname(target.path))).toEqual(['settings.json']);
    }
  });

  it.each(['vscode', 'zed'])('preserves URLs and comment markers inside %s JSON strings', async client => {
    const environment = { home, platform: 'linux', env: {} };
    const target = clientConfigTarget(client, environment);
    const existing = {
      url: 'https://example.com/settings',
      pattern: '/* literal block markers */',
      escapedQuote: 'Escaped quote: " // still a string',
      trailingBackslash: 'Trailing backslash: \\',
    };
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, JSON.stringify(existing));
    await installClientConfig(client, 'latest', environment);
    expect(JSON.parse(await readFile(target.path, 'utf8'))).toMatchObject(existing);
  });

  it.each(['vscode', 'zed'])('keeps clear parse errors for malformed %s JSON containing comment-like strings', async client => {
    const environment = { home, platform: 'linux', env: {} };
    const target = clientConfigTarget(client, environment);
    await mkdir(dirname(target.path), { recursive: true });
    const source = `{ "url": "https://example.com", "note": ${JSON.stringify('Escaped quote: " /* literal */ // literal')}, }`;
    await writeFile(target.path, source);
    await expect(installClientConfig(client, 'latest', environment)).rejects.toThrow(SyntaxError);
    expect(await readFile(target.path, 'utf8')).toBe(source);
    expect(await readdir(dirname(target.path))).toEqual(['settings.json']);
  });

  it('refuses malformed/invalid structures without overwriting and cannot select prototype keys', async () => {
    const environment = { home, env: {} };
    const target = clientConfigTarget('cursor', environment);
    await mkdir(dirname(target.path), { recursive: true });
    for (const content of ['{ broken', '{"mcpServers": []}', '{"mcpServers": "bad"}']) {
      await writeFile(target.path, content);
      await expect(installClientConfig('cursor', 'latest', environment)).rejects.toThrow();
      expect(await readFile(target.path, 'utf8')).toBe(content);
    }
    await expect(installClientConfig('__proto__', 'latest', environment)).rejects.toThrow('Unsupported MCP client');
    await expect(installClientConfig('cursor', 'beta; command', environment)).rejects.toThrow('Invalid install version');
    await writeFile(target.path, '{"__proto__":{"polluted":true},"mcpServers":{}}');
    await installClientConfig('cursor', 'latest', environment);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.parse(await readFile(target.path, 'utf8')).__proto__).toEqual({ polluted: true });
  });
});
