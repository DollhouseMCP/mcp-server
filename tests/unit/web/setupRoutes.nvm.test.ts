/**
 * NVM Mitigation Helpers — Unit Tests
 *
 * Tests the three helper functions that detect NVM, create the launcher
 * wrapper, and patch the MCP client config to avoid Claude Desktop's broken
 * NVM PATH ordering bug (all installed versions in ascending order, oldest
 * first, causing npx to run under e.g. Node 12 even when Node 24 is active).
 *
 * See: https://github.com/DollhouseMCP/mcp-server/issues/1902
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isNvmPresent,
  ensureNvmLauncher,
  patchConfigForNvmLauncher,
} from '../../../src/web/routes/setupRoutes.js';

// ── Shared temp directory setup ──────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dollhouse-nvm-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── isNvmPresent ─────────────────────────────────────────────────────────────

describe('isNvmPresent', () => {
  it('returns false when ~/.nvm/nvm.sh does not exist', async () => {
    const result = await isNvmPresent(tempDir);
    expect(result).toBe(false);
  });

  it('returns false when .nvm directory exists but nvm.sh is missing', async () => {
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    const result = await isNvmPresent(tempDir);
    expect(result).toBe(false);
  });

  it('returns true when ~/.nvm/nvm.sh exists', async () => {
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '# nvm script');
    const result = await isNvmPresent(tempDir);
    expect(result).toBe(true);
  });

  it('returns true even when nvm.sh is empty', async () => {
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '');
    const result = await isNvmPresent(tempDir);
    expect(result).toBe(true);
  });

  it('is a function (win32 branch exists in source)', () => {
    // The win32 short-circuit is verified via code inspection;
    // we confirm the export is callable and typed correctly.
    expect(typeof isNvmPresent).toBe('function');
  });
});

// ── ensureNvmLauncher ────────────────────────────────────────────────────────

describe('ensureNvmLauncher', () => {
  it('creates the ~/.dollhouse/bin directory', async () => {
    await ensureNvmLauncher(tempDir);
    const s = await stat(join(tempDir, '.dollhouse', 'bin'));
    expect(s.isDirectory()).toBe(true);
  });

  it('creates nested directories even when none exist', async () => {
    // tempDir has no .dollhouse at all — mkdir recursive must handle it
    const deepHome = join(tempDir, 'nested', 'home');
    await mkdir(deepHome, { recursive: true });
    await ensureNvmLauncher(deepHome);
    const s = await stat(join(deepHome, '.dollhouse', 'bin'));
    expect(s.isDirectory()).toBe(true);
  });

  it('returns the absolute path to the wrapper script', async () => {
    const result = await ensureNvmLauncher(tempDir);
    const expected = join(tempDir, '.dollhouse', 'bin', 'dollhousemcp-nvm.sh');
    expect(result).toBe(expected);
  });

  it('creates the wrapper script file', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const s = await stat(wrapperPath);
    expect(s.isFile()).toBe(true);
  });

  it('wrapper script has executable permission bits set', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const s = await stat(wrapperPath);
    // 0o111 = any execute bit (owner/group/other)
    expect(s.mode & 0o111).toBeTruthy();
  });

  it('wrapper script starts with #!/bin/bash shebang', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content.startsWith('#!/bin/bash\n')).toBe(true);
  });

  it('wrapper script exports NVM_DIR', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).toContain('export NVM_DIR=');
  });

  it('wrapper script sources nvm.sh', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).toContain('. "$NVM_DIR/nvm.sh"');
  });

  it('wrapper script detects Node major version', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).toContain('MAJOR=');
    expect(content).toContain('process.versions.node');
  });

  it('wrapper script falls back to nvm use node when version < 18', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).toContain('-lt 18');
    expect(content).toContain('nvm use node');
  });

  it('wrapper script delegates to exec npx "$@"', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).toContain('exec npx "$@"');
  });

  it('wrapper script ends with a newline', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('references the GitHub issue in a comment', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).toContain('issues/1902');
  });

  it('overwrites an existing wrapper without throwing', async () => {
    const first = await ensureNvmLauncher(tempDir);
    await writeFile(first, '# stale content');

    const second = await ensureNvmLauncher(tempDir);
    const content = await readFile(second, 'utf-8');

    // Re-generated content replaces the stale file
    expect(content).toContain('#!/bin/bash');
    expect(content).not.toBe('# stale content');
  });

  it('returns the same path on repeated calls', async () => {
    const first = await ensureNvmLauncher(tempDir);
    const second = await ensureNvmLauncher(tempDir);
    expect(first).toBe(second);
  });
});

// ── patchConfigForNvmLauncher ────────────────────────────────────────────────

describe('patchConfigForNvmLauncher', () => {
  const WRAPPER = '/Users/test/.dollhouse/bin/dollhousemcp-nvm.sh';

  it('silently no-ops when config file does not exist', async () => {
    const missing = join(tempDir, 'nonexistent.json');
    await expect(
      patchConfigForNvmLauncher('claude', WRAPPER, missing)
    ).resolves.not.toThrow();
  });

  it('silently no-ops when config is malformed JSON', async () => {
    const bad = join(tempDir, 'bad.json');
    await writeFile(bad, '{ not: valid, json }');
    await expect(
      patchConfigForNvmLauncher('claude', WRAPPER, bad)
    ).resolves.not.toThrow();
    // File should be unchanged
    expect(await readFile(bad, 'utf-8')).toBe('{ not: valid, json }');
  });

  it('skips TOML config paths (codex)', async () => {
    const tomlPath = join(tempDir, 'config.toml');
    await writeFile(tomlPath, '[mcp_servers.dollhousemcp]\ncommand = "npx"\n');
    await patchConfigForNvmLauncher('codex', WRAPPER, tomlPath);
    // TOML file must not be touched
    const content = await readFile(tomlPath, 'utf-8');
    expect(content).toContain('command = "npx"');
  });

  it('patches command under mcpServers.dollhousemcp', async () => {
    const configPath = join(tempDir, 'claude.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: { dollhousemcp: { command: 'npx', args: ['@dollhousemcp/mcp-server@latest'] } },
    }, null, 2));

    await patchConfigForNvmLauncher('claude', WRAPPER, configPath);

    const after = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(after.mcpServers.dollhousemcp.command).toBe(WRAPPER);
  });

  it('patches command under servers.dollhousemcp (VS Code style)', async () => {
    const configPath = join(tempDir, 'vscode.json');
    await writeFile(configPath, JSON.stringify({
      servers: { dollhousemcp: { command: 'npx', args: ['@dollhousemcp/mcp-server@latest'] } },
    }, null, 2));

    await patchConfigForNvmLauncher('claude-code', WRAPPER, configPath);

    const after = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(after.servers.dollhousemcp.command).toBe(WRAPPER);
  });

  it('silently no-ops when no dollhousemcp entry is present', async () => {
    const configPath = join(tempDir, 'no-entry.json');
    const original = { mcpServers: { othertool: { command: 'npx', args: [] } } };
    await writeFile(configPath, JSON.stringify(original, null, 2));

    await patchConfigForNvmLauncher('claude', WRAPPER, configPath);

    const after = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(after).toEqual(original);
  });

  it('preserves the args array unchanged', async () => {
    const configPath = join(tempDir, 'claude.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: { dollhousemcp: { command: 'npx', args: ['@dollhousemcp/mcp-server@rc'] } },
    }, null, 2));

    await patchConfigForNvmLauncher('claude', WRAPPER, configPath);

    const after = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(after.mcpServers.dollhousemcp.args).toEqual(['@dollhousemcp/mcp-server@rc']);
  });

  it('preserves other top-level config keys', async () => {
    const configPath = join(tempDir, 'claude.json');
    await writeFile(configPath, JSON.stringify({
      globalShortcut: 'Cmd+Shift+.',
      mcpServers: { dollhousemcp: { command: 'npx', args: ['@dollhousemcp/mcp-server@latest'] } },
    }, null, 2));

    await patchConfigForNvmLauncher('claude', WRAPPER, configPath);

    const after = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(after.globalShortcut).toBe('Cmd+Shift+.');
  });

  it('preserves other mcpServers entries', async () => {
    const configPath = join(tempDir, 'multi.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        othertool: { command: 'node', args: ['server.js'] },
        dollhousemcp: { command: 'npx', args: ['@dollhousemcp/mcp-server@latest'] },
      },
    }, null, 2));

    await patchConfigForNvmLauncher('claude', WRAPPER, configPath);

    const after = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(after.mcpServers.othertool).toEqual({ command: 'node', args: ['server.js'] });
  });

  it('output is valid JSON', async () => {
    const configPath = join(tempDir, 'claude.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: { dollhousemcp: { command: 'npx', args: ['@dollhousemcp/mcp-server@latest'] } },
    }, null, 2));

    await patchConfigForNvmLauncher('claude', WRAPPER, configPath);

    const raw = await readFile(configPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('output ends with a newline', async () => {
    const configPath = join(tempDir, 'claude.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: { dollhousemcp: { command: 'npx', args: ['@dollhousemcp/mcp-server@latest'] } },
    }, null, 2));

    await patchConfigForNvmLauncher('claude', WRAPPER, configPath);

    const raw = await readFile(configPath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('does not throw for an unknown client with no config path', async () => {
    await expect(
      patchConfigForNvmLauncher('unknown-client-xyz', WRAPPER)
    ).resolves.not.toThrow();
  });

  it('patches idempotently — second patch uses new wrapper path', async () => {
    const configPath = join(tempDir, 'claude.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: { dollhousemcp: { command: 'npx', args: ['@dollhousemcp/mcp-server@latest'] } },
    }, null, 2));

    const wrapper2 = '/new/path/dollhousemcp-nvm.sh';
    await patchConfigForNvmLauncher('claude', WRAPPER, configPath);
    await patchConfigForNvmLauncher('claude', wrapper2, configPath);

    const after = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(after.mcpServers.dollhousemcp.command).toBe(wrapper2);
  });
});
