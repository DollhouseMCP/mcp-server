import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseJsonc } from 'jsonc-parser';
import { clientConfigTarget, installClientConfig } from '../../../src/web/routes/clientConfigInstaller.js';
import {
  createSetupRoutes,
  installJsonMcpClientConfig,
  parseJsonConfig,
  patchConfigForNvmLauncher,
  repairNvmLauncherOnStartup,
} from '../../../src/web/routes/setupRoutes.js';

let home: string;
let configPath: string;
let originalNvmDir: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dollhouse-vscode-consumers-'));
  configPath = join(home, 'settings.json');
  originalNvmDir = process.env.NVM_DIR;
  delete process.env.NVM_DIR;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  if (originalNvmDir === undefined) delete process.env.NVM_DIR;
  else process.env.NVM_DIR = originalNvmDir;
});

const args = ['@dollhousemcp/mcp-server@beta'];

/** Include legacy decoys to verify repair updates the canonical settings path. */
function settings(command = 'npx'): string {
  return [
    '{',
    '  // User settings and other servers must survive launcher repairs.',
    '  "editor.fontSize": 17,',
    '  "documentation": "https://example.com/docs/*literal*/",',
    '  "mcpServers": { "dollhousemcp": { "command": "legacy-mcpServers" } },',
    '  "servers": { "dollhousemcp": { "command": "legacy-servers" } },',
    '  "mcp": {',
    '    "inputs": [{ "id": "token", "type": "promptString" }],',
    '    "servers": {',
    '      "other": { "command": "node", "args": ["other.js"] },',
    '      "dollhousemcp": {',
    `        "command": ${JSON.stringify(command)}, // Keep this launch comment.`,
    `        "args": ${JSON.stringify(args)},`,
    '        "env": { "USER_SETTING": "retained" },',
    '      },',
    '    },',
    '  },',
    '}',
    '',
  ].join('\n');
}

async function detectSettings(path: string) {
  const { detectHandler } = createSetupRoutes({ _configPathResolver: client => client === 'vscode' ? path : null });
  const app = express();
  app.get('/detect', detectHandler);
  return request(app).get('/detect').expect(200);
}

describe('VS Code setup config consumers', () => {
  it('reports a config produced by the global installer as installed', async () => {
    const environment = { home, platform: 'darwin', env: {} };
    await installClientConfig('vscode', 'beta', environment);
    const target = clientConfigTarget('vscode', environment);
    const response = await detectSettings(target.path);
    expect(response.body.vscode).toMatchObject({
      installed: true,
      configPath: target.path,
      serverKey: 'mcp.servers',
      currentConfig: { command: 'npx', args: expect.arrayContaining(args) },
    });
  });

  it('detects JSONC settings and prefers nested servers over legacy entries', async () => {
    await writeFile(configPath, settings());
    const response = await detectSettings(configPath);
    expect(response.body.vscode).toMatchObject({ installed: true, serverKey: 'mcp.servers', currentConfig: { command: 'npx', args } });
  });

  it.each(['mcpServers', 'servers'])('continues detecting and patching legacy %s entries', async key => {
    const raw = JSON.stringify({ [key]: { dollhousemcp: { command: 'npx', args } }, unrelated: true });
    expect(parseJsonConfig(raw, 'vscode')).toMatchObject({ installed: true, serverKey: key });
    await writeFile(configPath, raw);
    await patchConfigForNvmLauncher('vscode', '/persistent/dollhousemcp-nvm.sh', configPath);
    const after = JSON.parse(await readFile(configPath, 'utf8'));
    expect(after[key].dollhousemcp).toEqual({ command: '/persistent/dollhousemcp-nvm.sh', args });
    expect(after.unrelated).toBe(true);
  });

  it('patches only the nested command and preserves JSONC comments, settings, args and other entries', async () => {
    const raw = settings();
    const wrapper = '/persistent/dollhousemcp-nvm.sh';
    await writeFile(configPath, raw);
    await patchConfigForNvmLauncher('vscode', wrapper, configPath);
    expect(await readFile(configPath, 'utf8')).toBe(raw.replace('"command": "npx"', `"command": ${JSON.stringify(wrapper)}`));
  });

  it('repairs the installed nested entry on NVM startup and keeps a healthy config byte-identical', async () => {
    if (process.platform === 'win32') return;
    await mkdir(join(home, '.nvm'));
    await writeFile(join(home, '.nvm', 'nvm.sh'), '# test nvm');
    const raw = settings();
    await writeFile(configPath, raw);
    const resolver = (client: string) => client === 'vscode' ? configPath : null;
    await repairNvmLauncherOnStartup(home, resolver);
    const after = await readFile(configPath, 'utf8');
    const wrapper = join(home, '.dollhouse', 'bin', 'dollhousemcp-nvm.sh');
    expect(after).toBe(raw.replace('"command": "npx"', `"command": ${JSON.stringify(wrapper)}`));
    await repairNvmLauncherOnStartup(home, resolver);
    expect(await readFile(configPath, 'utf8')).toBe(after);
  });

  it('heals a missing nested launcher without NVM while preserving JSONC exactly', async () => {
    if (process.platform === 'win32') return;
    const missingWrapper = join(home, 'deleted', 'dollhousemcp-nvm.sh');
    const raw = settings(missingWrapper);
    await writeFile(configPath, raw);
    await repairNvmLauncherOnStartup(home, client => client === 'vscode' ? configPath : null);
    expect(await readFile(configPath, 'utf8')).toBe(settings('npx'));
  });

  it.each(['{ "mcp": { "servers": ', '[1, 2]', 'null'])('leaves malformed settings untouched: %s', async raw => {
    await writeFile(configPath, raw);
    await patchConfigForNvmLauncher('vscode', '/persistent/dollhousemcp-nvm.sh', configPath);
    expect(await readFile(configPath, 'utf8')).toBe(raw);
    expect((await detectSettings(configPath)).body.vscode.installed).toBe(false);
  });

  it.each([
    '{ "__proto__": { "mcp": { "servers": { "dollhousemcp": { "command": "npx" } } } } }',
    '{ "mcp": { "__proto__": { "servers": { "dollhousemcp": { "command": "npx" } } } } }',
    '{ "mcp": { "servers": { "__proto__": { "dollhousemcp": { "command": "npx" } } } } }',
  ])('ignores inherited JSONC server paths: %s', async raw => {
    expect(parseJsonConfig(raw, 'vscode')).toEqual({ installed: false });
    await writeFile(configPath, raw);
    await patchConfigForNvmLauncher('vscode', '/persistent/dollhousemcp-nvm.sh', configPath);
    expect(await readFile(configPath, 'utf8')).toBe(raw);
  });

  it('retains strict JSON parsing and top-level precedence for other clients', async () => {
    const entry = { command: 'npx', args };
    expect(parseJsonConfig(JSON.stringify({ mcpServers: { dollhousemcp: entry } }), 'claude'))
      .toEqual({ installed: true, currentConfig: entry, serverKey: 'mcpServers' });
    expect(() => parseJsonConfig(settings(), 'claude')).toThrow();
    expect(parseJsonConfig(JSON.stringify({ mcp: { servers: { dollhousemcp: entry } } }), 'claude')).toEqual({ installed: false });
  });

  it('writes the canonical nested path through the direct JSON install helper and preserves settings comments', async () => {
    const raw = settings('previous');
    await writeFile(configPath, raw);
    await installJsonMcpClientConfig('vscode', 'rc', configPath);
    const after = await readFile(configPath, 'utf8');
    const parsed = parseJsonc(after);
    expect(parsed.mcp.servers.dollhousemcp).toEqual({ command: 'npx', args: ['@dollhousemcp/mcp-server@rc'] });
    expect(parsed.mcp.servers.other).toEqual({ command: 'node', args: ['other.js'] });
    expect(parsed.mcp.inputs).toEqual([{ id: 'token', type: 'promptString' }]);
    expect(parsed.servers.dollhousemcp.command).toBe('legacy-servers');
    expect(parsed['editor.fontSize']).toBe(17);
    expect(after).toContain('// User settings and other servers must survive launcher repairs.');
  });

  it.each(['null', '[]', '"invalid"'])('rejects malformed nested install sections without overwriting them: %s', async section => {
    const raw = `{ "mcp": ${section} }`;
    await writeFile(configPath, raw);
    await expect(installJsonMcpClientConfig('vscode', 'beta', configPath)).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe(raw);
  });
});
