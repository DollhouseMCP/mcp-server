/**
 * NVM Mitigation Helpers — Unit Tests
 *
 * Tests the helper functions that detect NVM, create the launcher wrapper,
 * patch the MCP client config, and perform startup repair to avoid Claude
 * Desktop's broken NVM PATH ordering bug (all installed versions in ascending
 * order, oldest first, causing npx to run under e.g. Node 12 even when Node
 * 24 is active).
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
  applyNvmLauncherIfNeeded,
  repairNvmLauncherOnStartup,
} from '../../../src/web/routes/setupRoutes.js';

const isWindows = process.platform === 'win32';

// ── Shared temp directory setup ──────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dollhouse-nvm-test-'));
  // Clear NVM_DIR before each test so the CI runner's real NVM installation
  // doesn't bleed into tests that pass a custom home directory.
  delete process.env.NVM_DIR;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  // Restore NVM_DIR env var if a test modified it
  delete process.env.NVM_DIR;
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
    if (isWindows) return; // isNvmPresent always returns false on Windows by design
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '# nvm script');
    const result = await isNvmPresent(tempDir);
    expect(result).toBe(true);
  });

  it('returns true even when nvm.sh is empty', async () => {
    if (isWindows) return; // isNvmPresent always returns false on Windows by design
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '');
    const result = await isNvmPresent(tempDir);
    expect(result).toBe(true);
  });

  it('returns false on Windows even when ~/.nvm/nvm.sh exists (win32 short-circuit)', async () => {
    if (!isWindows) return; // Windows-only: verifies the platform guard
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '# nvm script');
    const result = await isNvmPresent(tempDir);
    expect(result).toBe(false);
  });

  it('is a function with correct signature', () => {
    expect(typeof isNvmPresent).toBe('function');
  });

  it('returns true when process.env.NVM_DIR points to a valid nvm.sh', async () => {
    if (isWindows) return;
    const customNvmDir = join(tempDir, 'custom-nvm');
    await mkdir(customNvmDir, { recursive: true });
    await writeFile(join(customNvmDir, 'nvm.sh'), '# nvm script');
    process.env.NVM_DIR = customNvmDir;
    // home does NOT have a .nvm dir — only the env var path does
    const result = await isNvmPresent(tempDir);
    expect(result).toBe(true);
  });

  it('env NVM_DIR takes precedence over ~/.nvm when both exist', async () => {
    if (isWindows) return;
    // Only env path has nvm.sh — default path does not
    const customNvmDir = join(tempDir, 'custom-nvm');
    await mkdir(customNvmDir, { recursive: true });
    await writeFile(join(customNvmDir, 'nvm.sh'), '# nvm via env');
    process.env.NVM_DIR = customNvmDir;
    // Even if we set a different home dir with no .nvm, result is true
    const result = await isNvmPresent(join(tempDir, 'no-nvm-home'));
    expect(result).toBe(true);
  });

  it('falls back to ~/.nvm when NVM_DIR env var is not set', async () => {
    if (isWindows) return;
    delete process.env.NVM_DIR;
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '# nvm script');
    const result = await isNvmPresent(tempDir);
    expect(result).toBe(true);
  });

  it('returns false when NVM_DIR env points to directory without nvm.sh', async () => {
    if (isWindows) return;
    const emptyDir = join(tempDir, 'empty-nvm');
    await mkdir(emptyDir, { recursive: true });
    process.env.NVM_DIR = emptyDir;
    // No ~/.nvm/.nvm.sh either
    const result = await isNvmPresent(tempDir);
    expect(result).toBe(false);
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
    if (isWindows) return; // chmod does not set Unix permission bits on Windows
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

  it('wrapper script contains NVM_DIR assignment', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).toContain('NVM_DIR=');
  });

  it('wrapper script hardcodes the resolved NVM path (not a shell variable expansion)', async () => {
    // The path must be an absolute path literal, not ${NVM_DIR:-...}
    const customNvmDir = join(tempDir, 'my-custom-nvm');
    const wrapperPath = await ensureNvmLauncher(tempDir, customNvmDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).toContain(`NVM_DIR="${customNvmDir}"`);
    expect(content).not.toContain('${NVM_DIR:-');
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

  it('wrapper script checks MAJOR twice (before and after nvm use cascade)', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    // MAJOR=... appears once before the cascade and once after
    const count = (content.match(/MAJOR=\$\(/g) ?? []).length;
    expect(count).toBe(2);
  });

  it('wrapper script falls back to nvm use --lts when node alias fails', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).toContain('nvm use node');
    expect(content).toContain('nvm use --lts');
  });

  it('wrapper script emits a stderr warning when Node is still below 18 after cascade', async () => {
    const wrapperPath = await ensureNvmLauncher(tempDir);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).toContain('WARNING:');
    expect(content).toContain('>&2');
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

  it('accepts nvmDirOverride and embeds it in the script', async () => {
    const override = '/opt/custom-nvm';
    const wrapperPath = await ensureNvmLauncher(tempDir, override);
    const content = await readFile(wrapperPath, 'utf-8');
    expect(content).toContain(`NVM_DIR="${override}"`);
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

  it('preserves 2-space indentation', async () => {
    const configPath = join(tempDir, 'indent2.json');
    const original = '{\n  "mcpServers": {\n    "dollhousemcp": {\n      "command": "npx",\n      "args": []\n    }\n  }\n}\n';
    await writeFile(configPath, original);

    await patchConfigForNvmLauncher('claude', WRAPPER, configPath);

    const result = await readFile(configPath, 'utf-8');
    // Must use 2-space indent (not 4)
    expect(result).toContain('  "mcpServers"');
    expect(result).not.toContain('    "mcpServers"');
  });

  it('preserves 4-space indentation', async () => {
    const configPath = join(tempDir, 'indent4.json');
    const original = '{\n    "mcpServers": {\n        "dollhousemcp": {\n            "command": "npx",\n            "args": []\n        }\n    }\n}\n';
    await writeFile(configPath, original);

    await patchConfigForNvmLauncher('claude', WRAPPER, configPath);

    const result = await readFile(configPath, 'utf-8');
    // The mcpServers line must be indented with exactly 4 spaces (not 2)
    const lines = result.split('\n');
    const mcpLine = lines.find(l => l.includes('"mcpServers"')) ?? '';
    expect(mcpLine).toMatch(/^ {4}"[^"]/);   // exactly 4 leading spaces
    expect(mcpLine).not.toMatch(/^ {2}"[^"]/); // not 2-space indent on that line
  });

  it('uses tab indentation when input uses tabs', async () => {
    const configPath = join(tempDir, 'indentTab.json');
    const original = '{\n\t"mcpServers": {\n\t\t"dollhousemcp": {\n\t\t\t"command": "npx",\n\t\t\t"args": []\n\t\t}\n\t}\n}\n';
    await writeFile(configPath, original);

    await patchConfigForNvmLauncher('claude', WRAPPER, configPath);

    const result = await readFile(configPath, 'utf-8');
    expect(result).toContain('\t"mcpServers"');
  });
});

// ── applyNvmLauncherIfNeeded ─────────────────────────────────────────────────

describe('applyNvmLauncherIfNeeded', () => {
  it('returns not-applicable when NVM is not present', async () => {
    // tempDir has no .nvm — deterministically not-applicable on all machines
    const result = await applyNvmLauncherIfNeeded('claude', tempDir);
    expect(result).toBe('not-applicable');
  });

  it('is a function', () => {
    expect(typeof applyNvmLauncherIfNeeded).toBe('function');
  });

  it('returns applied and creates wrapper in home when NVM is present', async () => {
    if (isWindows) return;
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '# nvm');

    const result = await applyNvmLauncherIfNeeded('claude', tempDir);
    expect(result).toBe('applied');

    // Wrapper must have been created inside tempDir, not the real home
    const wrapperPath = join(tempDir, '.dollhouse', 'bin', 'dollhousemcp-nvm.sh');
    const s = await stat(wrapperPath);
    expect(s.isFile()).toBe(true);
  });

  it('result type is a valid NvmLauncherResult string literal', async () => {
    const result = await applyNvmLauncherIfNeeded('claude', tempDir);
    expect(typeof result).toBe('string');
    const valid: string[] = ['applied', 'not-applicable', 'failed'];
    expect(valid).toContain(result);
  });
});

// ── repairNvmLauncherOnStartup ───────────────────────────────────────────────

describe('repairNvmLauncherOnStartup', () => {
  it('is a function', () => {
    expect(typeof repairNvmLauncherOnStartup).toBe('function');
  });

  it('no-ops when NVM is not present (tempDir has no .nvm)', async () => {
    await expect(repairNvmLauncherOnStartup(tempDir)).resolves.not.toThrow();
    // Wrapper must not exist
    const { access: fsAccess } = await import('node:fs/promises');
    await expect(
      fsAccess(join(tempDir, '.dollhouse', 'bin', 'dollhousemcp-nvm.sh'))
    ).rejects.toThrow();
  });

  it('creates the wrapper when NVM is present', async () => {
    if (isWindows) return;
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '# nvm');

    await repairNvmLauncherOnStartup(tempDir);

    const s = await stat(join(tempDir, '.dollhouse', 'bin', 'dollhousemcp-nvm.sh'));
    expect(s.isFile()).toBe(true);
  });

  it('patches a pre-existing config that still uses bare npx (via configPathResolver)', async () => {
    if (isWindows) return;
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '# nvm');

    // Seed a config that simulates a pre-PR install (command is bare npx)
    const configPath = join(tempDir, 'claude_desktop_config.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: { dollhousemcp: { command: 'npx', args: ['@dollhousemcp/mcp-server@latest'] } },
    }, null, 2));

    // Inject a resolver that routes 'claude' to our temp config; skips all others
    const resolver = (client: string) => client === 'claude' ? configPath : null;
    await repairNvmLauncherOnStartup(tempDir, resolver);

    const after = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(after.mcpServers.dollhousemcp.command).toContain('dollhousemcp-nvm.sh');
  });

  it('patches all clients returned by the resolver', async () => {
    if (isWindows) return;
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '# nvm');

    // Create configs for two clients
    const claudeConfig = join(tempDir, 'claude.json');
    const cursorConfig = join(tempDir, 'cursor.json');
    for (const p of [claudeConfig, cursorConfig]) {
      await writeFile(p, JSON.stringify({
        mcpServers: { dollhousemcp: { command: 'npx', args: ['@dollhousemcp/mcp-server@latest'] } },
      }, null, 2));
    }

    const resolver = (client: string) => {
      if (client === 'claude') return claudeConfig;
      if (client === 'cursor') return cursorConfig;
      return null;
    };
    await repairNvmLauncherOnStartup(tempDir, resolver);

    for (const p of [claudeConfig, cursorConfig]) {
      const after = JSON.parse(await readFile(p, 'utf-8'));
      expect(after.mcpServers.dollhousemcp.command).toContain('dollhousemcp-nvm.sh');
    }
  });

  it('skips clients whose resolver returns null', async () => {
    if (isWindows) return;
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '# nvm');

    const untouched = join(tempDir, 'cursor.json');
    const original = JSON.stringify({
      mcpServers: { dollhousemcp: { command: 'npx', args: [] } },
    }, null, 2);
    await writeFile(untouched, original);

    // Resolver returns null for every client — no patching should occur
    await repairNvmLauncherOnStartup(tempDir, () => null);

    expect(await readFile(untouched, 'utf-8')).toBe(original);
  });

  it('recreates a deleted wrapper when NVM is present', async () => {
    if (isWindows) return;
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '# nvm');

    await repairNvmLauncherOnStartup(tempDir);
    const wrapperPath = join(tempDir, '.dollhouse', 'bin', 'dollhousemcp-nvm.sh');

    // Simulate user deleting the wrapper
    await rm(wrapperPath);

    await repairNvmLauncherOnStartup(tempDir);
    const s = await stat(wrapperPath);
    expect(s.isFile()).toBe(true);
  });

  it('is idempotent — two consecutive calls produce the same wrapper and config', async () => {
    if (isWindows) return;
    await mkdir(join(tempDir, '.nvm'), { recursive: true });
    await writeFile(join(tempDir, '.nvm', 'nvm.sh'), '# nvm');

    const configPath = join(tempDir, 'claude.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: { dollhousemcp: { command: 'npx', args: ['@dollhousemcp/mcp-server@latest'] } },
    }, null, 2));
    const resolver = (client: string) => client === 'claude' ? configPath : null;

    await repairNvmLauncherOnStartup(tempDir, resolver);
    const wrapperFirst = await readFile(
      join(tempDir, '.dollhouse', 'bin', 'dollhousemcp-nvm.sh'), 'utf-8'
    );
    const configFirst = await readFile(configPath, 'utf-8');

    await repairNvmLauncherOnStartup(tempDir, resolver);
    const wrapperSecond = await readFile(
      join(tempDir, '.dollhouse', 'bin', 'dollhousemcp-nvm.sh'), 'utf-8'
    );
    const configSecond = await readFile(configPath, 'utf-8');

    expect(wrapperFirst).toBe(wrapperSecond);
    expect(configFirst).toBe(configSecond);
  });
});
