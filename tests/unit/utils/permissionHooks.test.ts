import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep installed wrapper-script expectations in sync with
// docs/architecture/permission-hook-platform-contracts.md.

import {
  ensureClaudePreToolUseHook,
  ensureCodexPreToolUseHook,
  ensureCursorPreToolUseHook,
  ensureGeminiBeforeToolHook,
  ensureVsCodePreToolUseHook,
  ensureWindsurfHooks,
  getCodexConfigPath,
  getCodexHookSettingsPath,
  getCursorHookSettingsPath,
  getGeminiHookSettingsPath,
  getPermissionHookMarkerPath,
  getPermissionHookScriptPath,
  getPermissionHookStatus,
  getVsCodeHookSettingsPath,
  getVsCodeUserSettingsPath,
  getWindsurfHookSettingsPath,
  installPermissionHook,
} from '../../../src/utils/permissionHooks.js';

describe('permissionHooks', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'permission-hooks-'));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  describe('ensureClaudePreToolUseHook', () => {
    it('adds a PreToolUse command hook when missing', () => {
      const parsed = { hooks: {} } as Record<string, unknown>;

      const result = ensureClaudePreToolUseHook(parsed, 'bash ~/.dollhouse/hooks/pretooluse-dollhouse.sh');

      expect(result.changed).toBe(true);
      expect(result.parsed).toEqual({
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: 'bash ~/.dollhouse/hooks/pretooluse-dollhouse.sh',
                },
              ],
            },
          ],
        },
      });
    });

    it('is idempotent when the same command hook already exists', () => {
      const parsed = {
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: 'bash ~/.dollhouse/hooks/pretooluse-dollhouse.sh',
                },
              ],
            },
          ],
        },
      } as Record<string, unknown>;

      const result = ensureClaudePreToolUseHook(parsed, 'bash ~/.dollhouse/hooks/pretooluse-dollhouse.sh');

      expect(result.changed).toBe(false);
    });
  });

  describe('ensureGeminiBeforeToolHook', () => {
    it('adds a BeforeTool command hook when missing', () => {
      const parsed = { hooks: {} } as Record<string, unknown>;

      const result = ensureGeminiBeforeToolHook(parsed, 'bash ~/.dollhouse/hooks/pretooluse-gemini.sh');

      expect(result.changed).toBe(true);
      expect(result.parsed).toEqual({
        hooks: {
          BeforeTool: [
            {
              matcher: '.*',
              hooks: [
                {
                  type: 'command',
                  command: 'bash ~/.dollhouse/hooks/pretooluse-gemini.sh',
                },
              ],
            },
          ],
        },
      });
    });
  });

  describe('ensureVsCodePreToolUseHook', () => {
    it('adds a PreToolUse command hook when missing', () => {
      const parsed = { hooks: {} } as Record<string, unknown>;

      const result = ensureVsCodePreToolUseHook(parsed, 'bash ~/.dollhouse/hooks/pretooluse-vscode.sh');

      expect(result.changed).toBe(true);
      expect(result.parsed).toEqual({
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: 'bash ~/.dollhouse/hooks/pretooluse-vscode.sh',
                },
              ],
            },
          ],
        },
      });
    });
  });

  describe('ensureCodexPreToolUseHook', () => {
    it('adds a Bash-only PreToolUse command hook when missing', () => {
      const parsed = { hooks: {} } as Record<string, unknown>;

      const result = ensureCodexPreToolUseHook(parsed, 'bash ~/.dollhouse/hooks/pretooluse-codex.sh');

      expect(result.changed).toBe(true);
      expect(result.parsed).toEqual({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command: 'bash ~/.dollhouse/hooks/pretooluse-codex.sh',
                  statusMessage: 'Checking Bash permissions',
                },
              ],
            },
          ],
        },
      });
    });
  });

  describe('ensureCursorPreToolUseHook', () => {
    it('adds a preToolUse command hook when missing', () => {
      const parsed = { version: 1, hooks: {} } as Record<string, unknown>;

      const result = ensureCursorPreToolUseHook(parsed, 'bash ~/.dollhouse/hooks/pretooluse-cursor.sh');

      expect(result.changed).toBe(true);
      expect(result.parsed).toEqual({
        version: 1,
        hooks: {
          preToolUse: [
            {
              type: 'command',
              command: 'bash ~/.dollhouse/hooks/pretooluse-cursor.sh',
              matcher: '.*',
            },
          ],
        },
      });
    });
  });

  describe('ensureWindsurfHooks', () => {
    it('adds pre_run_command and pre_mcp_tool_use hooks when missing', () => {
      const parsed = { hooks: {} } as Record<string, unknown>;

      const result = ensureWindsurfHooks(parsed, 'bash ~/.dollhouse/hooks/pretooluse-windsurf.sh');

      expect(result.changed).toBe(true);
      expect(result.parsed).toEqual({
        hooks: {
          pre_run_command: [
            {
              type: 'command',
              command: 'bash ~/.dollhouse/hooks/pretooluse-windsurf.sh',
            },
          ],
          pre_mcp_tool_use: [
            {
              type: 'command',
              command: 'bash ~/.dollhouse/hooks/pretooluse-windsurf.sh',
            },
          ],
        },
      });
    });
  });

  describe('installPermissionHook', () => {
    it('installs the Claude Code hook script, updates settings, and writes a marker', async () => {
      const sourceScript = join(tempHome, 'pretooluse-dollhouse.sh');
      await writeFile(sourceScript, '#!/bin/bash\necho ok\n', 'utf-8');

      const result = await installPermissionHook('claude-code', {
        homeDir: tempHome,
        sourceScriptPath: sourceScript,
        now: new Date('2026-04-14T12:00:00.000Z'),
      });

      expect(result.supported).toBe(true);
      expect(result.configured).toBe(true);
      expect(result.scriptPath).toBe(getPermissionHookScriptPath(tempHome));
      expect(result.settingsPath).toBe(join(tempHome, '.claude', 'settings.json'));

      const settingsRaw = await readFile(join(tempHome, '.claude', 'settings.json'), 'utf-8');
      const settings = JSON.parse(settingsRaw);
      expect(settings.hooks.PreToolUse).toEqual([
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `bash ${getPermissionHookScriptPath(tempHome)}`,
            },
          ],
        },
      ]);

      const markerRaw = await readFile(getPermissionHookMarkerPath(tempHome, 'claude-code'), 'utf-8');
      expect(JSON.parse(markerRaw)).toEqual({
        host: 'claude-code',
        scriptPath: getPermissionHookScriptPath(tempHome),
        settingsPath: join(tempHome, '.claude', 'settings.json'),
        configured: true,
        assetsPrepared: true,
        installedAt: '2026-04-14T12:00:00.000Z',
      });

      const scriptStats = await stat(getPermissionHookScriptPath(tempHome));
      expect(scriptStats.isFile()).toBe(true);
    });

    it('installs Gemini CLI hook settings and writes a host-specific marker', async () => {
      const sourceScript = join(tempHome, 'pretooluse-dollhouse.sh');
      await writeFile(sourceScript, '#!/bin/bash\necho ok\n', 'utf-8');

      const result = await installPermissionHook('gemini-cli', {
        homeDir: tempHome,
        sourceScriptPath: sourceScript,
        now: new Date('2026-04-14T12:30:00.000Z'),
      });

      expect(result.supported).toBe(true);
      expect(result.configured).toBe(true);
      expect(result.scriptPath).toBe(join(tempHome, '.dollhouse', 'hooks', 'pretooluse-gemini.sh'));
      expect(result.settingsPath).toBe(getGeminiHookSettingsPath(tempHome));

      const settingsRaw = await readFile(getGeminiHookSettingsPath(tempHome), 'utf-8');
      const settings = JSON.parse(settingsRaw);
      expect(settings.hooks.BeforeTool).toEqual([
        {
          matcher: '.*',
          hooks: [
            {
              type: 'command',
              command: `bash ${join(tempHome, '.dollhouse', 'hooks', 'pretooluse-gemini.sh')}`,
            },
          ],
        },
      ]);

      expect(getPermissionHookStatus(tempHome, 'gemini-cli')).toEqual({
        installed: true,
        configured: true,
        assetsPrepared: true,
        host: 'gemini-cli',
        scriptPath: join(tempHome, '.dollhouse', 'hooks', 'pretooluse-gemini.sh'),
        settingsPath: getGeminiHookSettingsPath(tempHome),
      });
    });

    it('installs VS Code hook settings and updates chat.hookFilesLocations', async () => {
      const sourceScript = join(tempHome, 'pretooluse-dollhouse.sh');
      await writeFile(sourceScript, '#!/bin/bash\necho ok\n', 'utf-8');

      const result = await installPermissionHook('vscode', {
        homeDir: tempHome,
        sourceScriptPath: sourceScript,
        now: new Date('2026-04-14T12:15:00.000Z'),
      });

      expect(result.supported).toBe(true);
      expect(result.installed).toBe(true);
      expect(result.configured).toBe(true);
      expect(result.assetsPrepared).toBe(true);
      expect(result.scriptPath).toBe(join(tempHome, '.dollhouse', 'hooks', 'pretooluse-vscode.sh'));
      expect(result.settingsPath).toBe(getVsCodeHookSettingsPath(tempHome));
      expect(result.additionalPaths).toEqual([getVsCodeUserSettingsPath(tempHome)]);

      const hooksRaw = await readFile(getVsCodeHookSettingsPath(tempHome), 'utf-8');
      const hooks = JSON.parse(hooksRaw);
      expect(hooks.hooks.PreToolUse).toEqual([
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `bash ${join(tempHome, '.dollhouse', 'hooks', 'pretooluse-vscode.sh')}`,
            },
          ],
        },
      ]);

      const userSettingsRaw = await readFile(getVsCodeUserSettingsPath(tempHome), 'utf-8');
      const userSettings = JSON.parse(userSettingsRaw);
      expect(userSettings['chat.hookFilesLocations']).toEqual({
        '~/.copilot/hooks': true,
      });

      expect(getPermissionHookStatus(tempHome, 'vscode')).toEqual({
        installed: true,
        configured: true,
        assetsPrepared: true,
        host: 'vscode',
        scriptPath: join(tempHome, '.dollhouse', 'hooks', 'pretooluse-vscode.sh'),
        settingsPath: getVsCodeHookSettingsPath(tempHome),
        additionalPaths: [getVsCodeUserSettingsPath(tempHome)],
      });
    });

    it('installs Cursor hook settings and writes a host-specific marker', async () => {
      const sourceScript = join(tempHome, 'pretooluse-dollhouse.sh');
      await writeFile(sourceScript, '#!/bin/bash\necho ok\n', 'utf-8');

      const result = await installPermissionHook('cursor', {
        homeDir: tempHome,
        sourceScriptPath: sourceScript,
        now: new Date('2026-04-14T12:20:00.000Z'),
      });

      expect(result.supported).toBe(true);
      expect(result.installed).toBe(true);
      expect(result.configured).toBe(true);
      expect(result.assetsPrepared).toBe(true);
      expect(result.scriptPath).toBe(join(tempHome, '.dollhouse', 'hooks', 'pretooluse-cursor.sh'));
      expect(result.settingsPath).toBe(getCursorHookSettingsPath(tempHome));

      const settingsRaw = await readFile(getCursorHookSettingsPath(tempHome), 'utf-8');
      const settings = JSON.parse(settingsRaw);
      expect(settings).toEqual({
        version: 1,
        hooks: {
          preToolUse: [
            {
              type: 'command',
              command: `bash ${join(tempHome, '.dollhouse', 'hooks', 'pretooluse-cursor.sh')}`,
              matcher: '.*',
            },
          ],
        },
      });

      expect(getPermissionHookStatus(tempHome, 'cursor')).toEqual({
        installed: true,
        configured: true,
        assetsPrepared: true,
        host: 'cursor',
        scriptPath: join(tempHome, '.dollhouse', 'hooks', 'pretooluse-cursor.sh'),
        settingsPath: getCursorHookSettingsPath(tempHome),
      });
    });

    it('installs Windsurf hook settings and writes a host-specific marker', async () => {
      const sourceScript = join(tempHome, 'pretooluse-dollhouse.sh');
      await writeFile(sourceScript, '#!/bin/bash\necho ok\n', 'utf-8');

      const result = await installPermissionHook('windsurf', {
        homeDir: tempHome,
        sourceScriptPath: sourceScript,
        now: new Date('2026-04-14T12:25:00.000Z'),
      });

      expect(result.supported).toBe(true);
      expect(result.installed).toBe(true);
      expect(result.configured).toBe(true);
      expect(result.assetsPrepared).toBe(true);
      expect(result.scriptPath).toBe(join(tempHome, '.dollhouse', 'hooks', 'pretooluse-windsurf.sh'));
      expect(result.settingsPath).toBe(getWindsurfHookSettingsPath(tempHome));

      const settingsRaw = await readFile(getWindsurfHookSettingsPath(tempHome), 'utf-8');
      const settings = JSON.parse(settingsRaw);
      expect(settings).toEqual({
        hooks: {
          pre_run_command: [
            {
              type: 'command',
              command: `bash ${join(tempHome, '.dollhouse', 'hooks', 'pretooluse-windsurf.sh')}`,
            },
          ],
          pre_mcp_tool_use: [
            {
              type: 'command',
              command: `bash ${join(tempHome, '.dollhouse', 'hooks', 'pretooluse-windsurf.sh')}`,
            },
          ],
        },
      });

      expect(getPermissionHookStatus(tempHome, 'windsurf')).toEqual({
        installed: true,
        configured: true,
        assetsPrepared: true,
        host: 'windsurf',
        scriptPath: join(tempHome, '.dollhouse', 'hooks', 'pretooluse-windsurf.sh'),
        settingsPath: getWindsurfHookSettingsPath(tempHome),
      });
    });

    it('installs the Codex Bash hook, writes hooks.json, and enables codex_hooks', async () => {
      const sourceScript = join(tempHome, 'pretooluse-dollhouse.sh');
      await writeFile(sourceScript, '#!/bin/bash\necho ok\n', 'utf-8');

      const result = await installPermissionHook('codex', { homeDir: tempHome, sourceScriptPath: sourceScript });

      expect(result.supported).toBe(true);
      expect(result.installed).toBe(true);
      expect(result.configured).toBe(true);
      expect(result.assetsPrepared).toBe(true);
      expect(result.scriptPath).toBe(join(tempHome, '.dollhouse', 'hooks', 'pretooluse-codex.sh'));
      expect(result.settingsPath).toBe(getCodexHookSettingsPath(tempHome));
      expect(result.additionalPaths).toEqual([getCodexConfigPath(tempHome)]);

      const hooksRaw = await readFile(getCodexHookSettingsPath(tempHome), 'utf-8');
      const hooks = JSON.parse(hooksRaw);
      expect(hooks.hooks.PreToolUse).toEqual([
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `bash ${join(tempHome, '.dollhouse', 'hooks', 'pretooluse-codex.sh')}`,
              statusMessage: 'Checking Bash permissions',
            },
          ],
        },
      ]);

      const configRaw = await readFile(getCodexConfigPath(tempHome), 'utf-8');
      expect(configRaw).toContain('[features]');
      expect(configRaw).toContain('codex_hooks = true');

      expect(getPermissionHookStatus(tempHome, 'codex')).toEqual({
        installed: true,
        configured: true,
        assetsPrepared: true,
        host: 'codex',
        scriptPath: join(tempHome, '.dollhouse', 'hooks', 'pretooluse-codex.sh'),
        settingsPath: getCodexHookSettingsPath(tempHome),
        additionalPaths: [getCodexConfigPath(tempHome)],
      });
    });

    it('updates an existing Codex features block without duplicating it', async () => {
      const sourceScript = join(tempHome, 'pretooluse-dollhouse.sh');
      await writeFile(sourceScript, '#!/bin/bash\necho ok\n', 'utf-8');
      await mkdir(join(tempHome, '.codex'), { recursive: true });
      await writeFile(getCodexConfigPath(tempHome), '[model]\nname = "gpt-5-codex"\n\n[features]\ncodex_hooks = false\n', 'utf-8');

      await installPermissionHook('codex', { homeDir: tempHome, sourceScriptPath: sourceScript });
      await installPermissionHook('codex', { homeDir: tempHome, sourceScriptPath: sourceScript });

      const configRaw = await readFile(getCodexConfigPath(tempHome), 'utf-8');
      expect((configRaw.match(/\[features\]/g) || [])).toHaveLength(1);
      expect(configRaw).toContain('codex_hooks = true');
      expect(configRaw).toContain('[model]');
    });

    it('normalizes Unicode client names before installing hook assets', async () => {
      const sourceScript = join(tempHome, 'pretooluse-dollhouse.sh');
      await writeFile(sourceScript, '#!/bin/bash\necho ok\n', 'utf-8');

      const result = await installPermissionHook('Co\u0064e\u0078', {
        homeDir: tempHome,
        sourceScriptPath: sourceScript,
      });

      expect(result.host).toBe('codex');
      expect(result.settingsPath).toBe(getCodexHookSettingsPath(tempHome));
      expect(getPermissionHookStatus(tempHome, 'codex').configured).toBe(true);
    });

    it('rejects malformed existing Codex hooks configuration files', async () => {
      const sourceScript = join(tempHome, 'pretooluse-dollhouse.sh');
      await writeFile(sourceScript, '#!/bin/bash\necho ok\n', 'utf-8');
      await mkdir(join(tempHome, '.codex'), { recursive: true });
      await writeFile(getCodexHookSettingsPath(tempHome), '{not-json}\n', 'utf-8');

      await expect(
        installPermissionHook('codex', { homeDir: tempHome, sourceScriptPath: sourceScript }),
      ).rejects.toThrow();
    });

    it('rejects malformed existing Claude settings files instead of silently overwriting them', async () => {
      const sourceScript = join(tempHome, 'pretooluse-dollhouse.sh');
      await writeFile(sourceScript, '#!/bin/bash\necho ok\n', 'utf-8');
      await mkdir(join(tempHome, '.claude'), { recursive: true });
      await writeFile(join(tempHome, '.claude', 'settings.json'), '{not-json}\n', 'utf-8');

      await expect(
        installPermissionHook('claude-code', {
          homeDir: tempHome,
          sourceScriptPath: sourceScript,
        }),
      ).rejects.toThrow();
    });

    it('reports hook installation status from the marker file', async () => {
      const sourceScript = join(tempHome, 'pretooluse-dollhouse.sh');
      await writeFile(sourceScript, '#!/bin/bash\necho ok\n', 'utf-8');
      await installPermissionHook('claude-code', { homeDir: tempHome, sourceScriptPath: sourceScript });

      expect(getPermissionHookStatus(tempHome)).toEqual({
        installed: true,
        configured: true,
        assetsPrepared: true,
        host: 'claude-code',
        scriptPath: getPermissionHookScriptPath(tempHome),
        settingsPath: join(tempHome, '.claude', 'settings.json'),
      });
    });

    it('treats malformed hook markers as uninstalled', async () => {
      await mkdir(join(tempHome, '.dollhouse', 'run'), { recursive: true });
      await writeFile(getPermissionHookMarkerPath(tempHome, 'codex'), '{bad-json}\n', 'utf-8');

      expect(getPermissionHookStatus(tempHome, 'codex')).toEqual({ installed: false });
    });
  });
});
