import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureClaudePreToolUseHook,
  ensureCodexPreToolUseHook,
  ensureGeminiBeforeToolHook,
  getCodexConfigPath,
  getCodexHookSettingsPath,
  getGeminiHookSettingsPath,
  getPermissionHookMarkerPath,
  getPermissionHookScriptPath,
  getPermissionHookStatus,
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
