import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getPermissionHookAuditSummary,
  getPermissionHookScriptPath,
  installPermissionHook,
  reconcilePermissionHookStatus,
  repairPermissionHooksOnStartup,
} from '../../../src/utils/permissionHooks.js';

describe('permissionHooks repair flows', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'permission-hooks-repair-'));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it('reconciles stale installed hook assets and rewrites them automatically', async () => {
    await installPermissionHook('codex', { homeDir: tempHome });
    const sharedScriptPath = getPermissionHookScriptPath(tempHome);
    const wrapperScriptPath = join(tempHome, '.dollhouse', 'hooks', 'pretooluse-codex.sh');
    const expectedShared = await readFile(join(process.cwd(), 'scripts', 'pretooluse-dollhouse.sh'), 'utf-8');
    const expectedWrapper = await readFile(join(process.cwd(), 'scripts', 'pretooluse-codex.sh'), 'utf-8');

    await writeFile(sharedScriptPath, '#!/bin/bash\necho stale-shared\n', 'utf-8');
    await writeFile(wrapperScriptPath, '#!/bin/bash\necho stale-wrapper\n', 'utf-8');

    const status = await reconcilePermissionHookStatus('codex', {
      homeDir: tempHome,
      autoRepair: true,
    });

    expect(status.installed).toBe(true);
    expect(status.assetsPrepared).toBe(true);
    expect(status.assetsCurrent).toBe(true);
    expect(status.autoRepaired).toBe(true);
    expect(status.needsRepair).toBe(false);
    expect(await readFile(sharedScriptPath, 'utf-8')).toBe(expectedShared);
    expect(await readFile(wrapperScriptPath, 'utf-8')).toBe(expectedWrapper);
  });

  it('reports when stale hook assets still need repair after a failed reconciliation', async () => {
    await installPermissionHook('codex', { homeDir: tempHome });
    const sharedScriptPath = getPermissionHookScriptPath(tempHome);
    await writeFile(sharedScriptPath, '#!/bin/bash\necho stale-shared\n', 'utf-8');

    const status = await reconcilePermissionHookStatus('codex', {
      homeDir: tempHome,
      autoRepair: true,
      sourceScriptPath: join(tempHome, 'missing-shared-script.sh'),
    });

    expect(status.installed).toBe(true);
    expect(status.assetsCurrent).toBe(false);
    expect(status.autoRepaired).toBe(false);
    expect(status.needsRepair).toBe(true);
    expect(status.repairError).toContain('ENOENT');
  });

  it('repairs previously installed hook assets during startup reconciliation', async () => {
    await installPermissionHook('claude-code', { homeDir: tempHome });
    await writeFile(getPermissionHookScriptPath(tempHome), '#!/bin/bash\necho stale-shared\n', 'utf-8');

    await expect(repairPermissionHooksOnStartup(tempHome)).resolves.not.toThrow();

    const status = await reconcilePermissionHookStatus('claude-code', { homeDir: tempHome });
    expect(status.assetsCurrent).toBe(true);
    expect(status.needsRepair).toBe(false);
  });

  it('summarizes installed and repair-needed hook hosts for build info', async () => {
    await installPermissionHook('claude-code', { homeDir: tempHome });
    await installPermissionHook('codex', { homeDir: tempHome });
    await writeFile(getPermissionHookScriptPath(tempHome), '#!/bin/bash\necho stale-shared\n', 'utf-8');

    const summary = await getPermissionHookAuditSummary(tempHome);

    expect(summary.installedHosts).toEqual(expect.arrayContaining(['claude-code', 'codex']));
    expect(summary.currentHosts).not.toContain('claude-code');
    expect(summary.needsRepairHosts).toEqual(expect.arrayContaining(['claude-code', 'codex']));
  });
});
