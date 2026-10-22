import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
import { parse as parseJsonc, visit } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { clientConfigTarget, installClientConfig } from '../../../src/web/routes/clientConfigInstaller.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'client-installer-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
function jsoncComments(source: string): string[] {
  const comments: string[] = [];
  visit(source, { onComment: (offset, length) => comments.push(source.slice(offset, offset + length)) }, { allowTrailingComma: true });
  return comments;
}

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
    expect(servers.dollhousemcp.args).toEqual(['-y', '@dollhousemcp/mcp-server@beta']);
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
    expect(config.dollhousemcp).toMatchObject({ start_on_launch: true, args: ['-y', '@dollhousemcp/mcp-server@rc'] });
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

  it.each(['vscode', 'zed'])('installs into %s line-comment, block-comment and trailing-comma JSONC', async client => {
    const environment = { home, platform: 'linux', env: {} };
    const target = clientConfigTarget(client, environment);
    await mkdir(dirname(target.path), { recursive: true });
    const sources = [
      '{\n  "docs": "https://example.com",\n  // Keep this comment\n  "theme": "dark"\n}\n',
      '{\n  /* Keep this block comment */\n  "theme": "dark"\n}\n',
      '{ "theme": "dark", "array": [1, 2,], }',
      `{ "note": ${JSON.stringify('Escaped quote: " // still a string')}, /* Real comment */ "theme": "dark" }`,
      `{ "note": ${JSON.stringify('Trailing backslash: \\')}, // Real comment\n "theme": "dark" }`,
    ];
    for (const source of sources) {
      await writeFile(target.path, source);
      await installClientConfig(client, 'latest', environment);
      const result = await readFile(target.path, 'utf8');
      const parsed = parseJsonc(result, [], { allowTrailingComma: true });
      expect(parsed).toMatchObject(parseJsonc(source, [], { allowTrailingComma: true }));
      expect(target.keys.reduce((value, key) => value[key], parsed).dollhousemcp.args)
        .toEqual(['-y', '@dollhousemcp/mcp-server@latest']);
      expect(jsoncComments(result)).toEqual(jsoncComments(source));
      await installClientConfig(client, 'latest', environment);
      expect(await readFile(target.path, 'utf8')).toBe(result);
      expect(await readdir(dirname(target.path))).toEqual(['settings.json']);
    }
  });

  it.each(['vscode', 'zed'])('updates %s JSONC entries while preserving comments, other servers and permissions', async client => {
    const environment = { home, platform: 'linux', env: {} };
    const target = clientConfigTarget(client, environment);
    const section = `{
      // Other server keeps its command and comments.
      "other": { "command": "keep", "args": ["--flag",], },
      "another": { /* Keep this server too. */ "command": "also-keep" },
      "dollhousemcp": {
        // Keep the launch explanation.
        "command": "old",
        "args": ["old-package"],
        "env": { /* Preserve env notes. */ "TOKEN": "secret", },
        "custom": { /* Preserve custom values. */ "enabled": true },
      },
    }`;
    const source = `// Settings header\r\n{\r\n  "theme": "dark", // Theme note.\r\n  ${client === 'vscode' ? `"mcp": { "inputs": ["retained",], "servers": ${section}, }` : `"context_servers": ${section}`},\r\n}\r\n/* Settings footer */\r\n`;
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, source);
    await chmod(target.path, 0o640);
    const originalMode = (await stat(target.path)).mode & 0o777;
    await installClientConfig(client, 'beta', environment);
    const result = await readFile(target.path, 'utf8');
    const parsed = parseJsonc(result, [], { allowTrailingComma: true });
    const servers = target.keys.reduce((value, key) => value[key], parsed);
    expect(servers).toMatchObject({
      other: { command: 'keep', args: ['--flag'] },
      another: { command: 'also-keep' },
      dollhousemcp: { command: 'npx', args: ['-y', '@dollhousemcp/mcp-server@beta'], env: { TOKEN: 'secret' }, custom: { enabled: true } },
    });
    if (client === 'vscode') expect(parsed.mcp.inputs).toEqual(['retained']);
    if (client === 'zed') expect(servers.dollhousemcp.source).toBe('custom');
    expect(jsoncComments(result)).toEqual(jsoncComments(source));
    expect(result).toContain('"env": { /* Preserve env notes. */ "TOKEN": "secret", }');
    expect(result).toContain('"custom": { /* Preserve custom values. */ "enabled": true }');
    expect(result.startsWith('// Settings header\r\n')).toBe(true);
    expect(result.endsWith('/* Settings footer */\r\n')).toBe(true);
    expect((await stat(target.path)).mode & 0o777).toBe(originalMode);
    await installClientConfig(client, 'beta', environment);
    expect(await readFile(target.path, 'utf8')).toBe(result);
    expect(await readdir(dirname(target.path))).toEqual(['settings.json']);
  });

  it.each(['vscode', 'zed'])('refuses malformed %s JSONC and invalid sections without changing the file', async client => {
    const environment = { home, platform: 'linux', env: {} };
    const target = clientConfigTarget(client, environment);
    await mkdir(dirname(target.path), { recursive: true });
    const sources = [
      '{ /* Unclosed comment',
      '{ // Comment\n "theme": "dark" "missingComma": true }',
      '{ "theme": "dark",, }',
      '// Only a comment',
      '// Root must be an object\n []',
      client === 'vscode' ? '{ "mcp": { "servers": [] }, }' : '{ "context_servers": [], }',
      client === 'vscode' ? '{ "mcp": null, }' : '{ "context_servers": "bad", }',
    ];
    for (const source of sources) {
      await writeFile(target.path, source);
      await expect(installClientConfig(client, 'latest', environment)).rejects.toThrow();
      expect(await readFile(target.path, 'utf8')).toBe(source);
      expect(await readdir(dirname(target.path))).toEqual(['settings.json']);
    }
  });

  it('keeps strict JSON validation for other clients', async () => {
    const environment = { home, env: {} };
    const target = clientConfigTarget('cursor', environment);
    await mkdir(dirname(target.path), { recursive: true });
    for (const source of ['{ /* Comment */ "mcpServers": {} }', '{ "mcpServers": {}, }']) {
      await writeFile(target.path, source);
      await expect(installClientConfig('cursor', 'latest', environment)).rejects.toThrow(SyntaxError);
      expect(await readFile(target.path, 'utf8')).toBe(source);
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
    const source = `{ "url": "https://example.com", "note": ${JSON.stringify('Escaped quote: " /* literal */ // literal')}, "broken" }`;
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
