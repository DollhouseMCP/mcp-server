import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
import { parse as parseJsonc, visit } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { LogManager } from '../../../src/logging/LogManager.js';
import { wireLogHooks } from '../../../src/logging/LogHooks.js';
import { FileLogSink } from '../../../src/logging/sinks/FileLogSink.js';
import { MemoryLogSink } from '../../../src/logging/sinks/MemoryLogSink.js';
import { JsonlFormatter } from '../../../src/logging/formatters/JsonlFormatter.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
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

describe('client configuration audit trail', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('records success only after the config has been written without logging its contents or path', async () => {
    const environment = { home, platform: 'linux', env: {} };
    const target = clientConfigTarget('cursor', environment);
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, JSON.stringify({ secret: 'retained-private-value' }));
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(event => {
      expect(JSON.parse(readFileSync(target.path, 'utf8')).mcpServers.dollhousemcp).toBeDefined();
      expect(JSON.stringify(event)).not.toContain(home);
      expect(JSON.stringify(event)).not.toContain('retained-private-value');
    });
    await installClientConfig('cursor', 'beta', environment);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'CONFIG_UPDATED', source: 'clientConfigInstaller',
      additionalData: { client: 'cursor', version: 'beta', outcome: 'written' },
    }));
  });

  it('records a bounded failure without including invalid config or request values', async () => {
    const environment = { home, env: {} };
    const target = clientConfigTarget('cursor', environment);
    await mkdir(dirname(target.path), { recursive: true });
    const source = '{"private-key":"secret-value", invalid';
    await writeFile(target.path, source);
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
    await expect(installClientConfig('cursor', 'latest', environment)).rejects.toThrow();
    await expect(installClientConfig('secret-client', 'secret-version', environment)).rejects.toThrow();
    expect(await readFile(target.path, 'utf8')).toBe(source);
    expect(audit).toHaveBeenCalledTimes(2);
    for (const [event] of audit.mock.calls) {
      expect(event).toEqual({ type: 'OPERATION_FAILED', severity: 'LOW', source: 'clientConfigInstaller',
        details: expect.stringMatching(/^MCP client configuration installation failed \([a-f0-9-]{36}\)$/), additionalData: { outcome: 'failed' } });
    }
  });

  it('retains consecutive write events within the monitor deduplication window', async () => {
    const monitor = new SecurityMonitor();
    SecurityMonitor.setInstance(monitor);
    try {
      const environment = { home, env: {} };
      await installClientConfig('cursor', 'latest', environment);
      await installClientConfig('cursor', 'latest', environment);
      const events = monitor.instanceGetEventsByType('CONFIG_UPDATED');
      expect(events).toHaveLength(2);
      expect(events[0].details).not.toBe(events[1].details);
    } finally {
      SecurityMonitor.clearInstance(monitor);
    }
  });

  it('persists installer details and distinct attempts through the actual unified logging pipeline', async () => {
    const logDir = join(home, 'logs');
    const manager = new LogManager({
      logDir, logFormat: 'jsonl', retentionDays: 1, securityRetentionDays: 1,
      flushIntervalMs: 0, bufferSize: 100, memoryCapacity: 100,
      memoryAppCapacity: 100, memorySecurityCapacity: 100,
      memoryPerfCapacity: 100, memoryTelemetryCapacity: 100,
      maxEntrySize: 16384, immediateFlushRate: 50, fileMaxSize: 1048576,
      maxDirSizeBytes: 1048576, maxFilesPerCategory: 10, logLevel: 'debug',
    });
    const memory = new MemoryLogSink({ appCapacity: 100, securityCapacity: 100, perfCapacity: 100, telemetryCapacity: 100 });
    manager.registerSink(memory);
    manager.registerSink(new FileLogSink({ logDir, formatter: new JsonlFormatter(),
      maxFileSize: 1048576, retentionDays: 1, securityRetentionDays: 1,
      maxDirSizeBytes: 1048576, maxFilesPerCategory: 10 }));
    const monitor = new SecurityMonitor();
    SecurityMonitor.setInstance(monitor);
    const cleanups = wireLogHooks(manager, { resolve: () => { throw new Error('No optional fixture service'); } });
    try {
      const environment = { home, platform: 'linux', env: {} };
      const target = clientConfigTarget('cursor', environment);
      await mkdir(dirname(target.path), { recursive: true });
      await writeFile(target.path, JSON.stringify({ secret: 'private-config-value' }));
      await installClientConfig('cursor', 'beta', environment);
      await installClientConfig('cursor', 'beta', environment);
      await installClientConfig('codex', 'rc', environment);
      await expect(installClientConfig('private-client', 'private-version', environment)).rejects.toThrow();
      await installClientConfig('warp', 'latest', environment);
      await manager.flush();
      const entries = memory.query({ category: 'security', limit: 100 }).entries;
      expect(entries).toHaveLength(4);
      expect(entries.filter(entry => entry.data?.client === 'cursor' && entry.data?.version === 'beta')).toHaveLength(2);
      const files = (await readdir(logDir)).filter(file => file.startsWith('security-'));
      const persisted = (await Promise.all(files.map(file => readFile(join(logDir, file), 'utf8'))))
        .join('').trim().split('\n').map(line => JSON.parse(line));
      expect(persisted).toHaveLength(4);
      expect(persisted.slice(0, 3).map(entry => entry.data)).toEqual([
        { client: 'cursor', version: 'beta', outcome: 'written', eventType: 'CONFIG_UPDATED', severity: 'LOW', sourceComponent: 'clientConfigInstaller' },
        { client: 'cursor', version: 'beta', outcome: 'written', eventType: 'CONFIG_UPDATED', severity: 'LOW', sourceComponent: 'clientConfigInstaller' },
        { client: 'codex', version: 'rc', outcome: 'written', eventType: 'CONFIG_UPDATED', severity: 'LOW', sourceComponent: 'clientConfigInstaller' },
      ]);
      expect(persisted[0].msg).not.toBe(persisted[1].msg);
      expect(persisted[3].data).toEqual({ outcome: 'failed', eventType: 'OPERATION_FAILED', severity: 'LOW', sourceComponent: 'clientConfigInstaller' });
      for (const privateValue of [home, 'private-config-value', 'private-client', 'private-version']) {
        expect(JSON.stringify(entries)).not.toContain(privateValue);
        expect(JSON.stringify(persisted)).not.toContain(privateValue);
      }
    } finally {
      cleanups.forEach(cleanup => cleanup());
      SecurityMonitor.clearInstance(monitor);
      await manager.close();
    }
  });

  it('does not report a config write for manual Warp instructions', async () => {
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
    await installClientConfig('warp', 'latest', { home });
    expect(audit).not.toHaveBeenCalled();
  });
});
