import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getPermissionAuthorityStatePath,
  readPermissionAuthorityState,
  setPermissionAuthorityMode,
} from '../../../src/utils/permissionAuthority.js';

describe('permissionAuthority', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'permission-authority-'));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it('defaults to shared mode when no state file exists', async () => {
    const state = await readPermissionAuthorityState(tempHome);

    expect(state.defaultMode).toBe('shared');
    expect(state.hosts).toEqual({});
  });

  it('writes authoritative Claude Code permissions with managed metadata and strips conflicting ask entries', async () => {
    const settingsPath = join(tempHome, '.claude', 'settings.json');
    await mkdir(join(tempHome, '.claude'), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      permissions: {
        allow: ['Read'],
        ask: ['Bash', 'Write'],
        deny: ['Delete'],
      },
    }, null, 2) + '\n', 'utf-8');

    const state = await setPermissionAuthorityMode({
      homeDir: tempHome,
      host: 'claude-code',
      mode: 'authoritative',
      reason: 'test sync',
      now: new Date('2026-04-17T14:00:00.000Z'),
      policies: {
        combinedAllowPatterns: ['Bash:git status*'],
        combinedConfirmPatterns: ['Write:README.md'],
        combinedDenyPatterns: ['Bash:rm -rf*'],
      },
    });

    expect(state.hosts['claude-code']?.mode).toBe('authoritative');

    const raw = await readFile(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.permissions).toEqual({
      allow: ['Read', 'Bash:git status*'],
      ask: ['Write', 'Write:README.md', 'mcp__DollhouseMCP__mcp_aql_execute*'],
      deny: ['Delete', 'Bash:rm -rf*'],
    });
    expect(parsed['_dollhousePermissionAuthority']).toMatchObject({
      version: 1,
      host: 'claude-code',
      managedPermissions: {
        allow: ['Bash:git status*'],
        ask: ['Write:README.md', 'mcp__DollhouseMCP__mcp_aql_execute*'],
        deny: ['Bash:rm -rf*'],
      },
    });
  });

  it('restores the original Claude Code settings when leaving authoritative mode', async () => {
    const settingsPath = join(tempHome, '.claude', 'settings.json');
    await mkdir(join(tempHome, '.claude'), { recursive: true });
    const original = JSON.stringify({
      permissions: {
        ask: ['Bash'],
      },
    }, null, 2) + '\n';
    await writeFile(settingsPath, original, 'utf-8');

    await setPermissionAuthorityMode({
      homeDir: tempHome,
      host: 'claude-code',
      mode: 'authoritative',
      now: new Date('2026-04-17T14:10:00.000Z'),
      policies: {
        combinedAllowPatterns: ['Bash:git status*'],
      },
    });

    const reverted = await setPermissionAuthorityMode({
      homeDir: tempHome,
      host: 'claude-code',
      mode: 'shared',
      now: new Date('2026-04-17T14:11:00.000Z'),
    });

    expect(reverted.hosts['claude-code']?.mode).toBe('shared');
    expect(await readFile(settingsPath, 'utf-8')).toBe(original);
  });

  it('persists off mode for hooks to read from the authority state file', async () => {
    await setPermissionAuthorityMode({
      homeDir: tempHome,
      host: 'claude-code',
      mode: 'off',
      now: new Date('2026-04-17T14:12:00.000Z'),
    });

    const raw = await readFile(getPermissionAuthorityStatePath(tempHome), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect((parsed.hosts as Record<string, { mode: string }>)['claude-code'].mode).toBe('off');
  });

  it('normalizes authority mode reasons before persisting them', async () => {
    const state = await setPermissionAuthorityMode({
      homeDir: tempHome,
      host: 'claude-code',
      mode: 'shared',
      reason: 'Cafe\u0301 review',
      now: new Date('2026-04-17T14:15:00.000Z'),
    });

    expect(state.hosts['claude-code']?.reason).toBe('Café review');
  });
});
