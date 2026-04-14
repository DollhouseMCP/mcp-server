import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureClaudePreToolUseHook,
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

      const markerRaw = await readFile(getPermissionHookMarkerPath(tempHome), 'utf-8');
      expect(JSON.parse(markerRaw)).toEqual({
        host: 'claude-code',
        scriptPath: getPermissionHookScriptPath(tempHome),
        settingsPath: join(tempHome, '.claude', 'settings.json'),
        installedAt: '2026-04-14T12:00:00.000Z',
      });

      const scriptStats = await stat(getPermissionHookScriptPath(tempHome));
      expect(scriptStats.isFile()).toBe(true);
    });

    it('returns unsupported for clients without validated auto-hook wiring', async () => {
      const result = await installPermissionHook('codex', { homeDir: tempHome });

      expect(result.supported).toBe(false);
      expect(result.configured).toBe(false);
    });

    it('reports hook installation status from the marker file', async () => {
      const sourceScript = join(tempHome, 'pretooluse-dollhouse.sh');
      await writeFile(sourceScript, '#!/bin/bash\necho ok\n', 'utf-8');
      await installPermissionHook('claude-code', { homeDir: tempHome, sourceScriptPath: sourceScript });

      expect(getPermissionHookStatus(tempHome)).toEqual({
        installed: true,
        host: 'claude-code',
        scriptPath: getPermissionHookScriptPath(tempHome),
        settingsPath: join(tempHome, '.claude', 'settings.json'),
      });
    });
  });
});
