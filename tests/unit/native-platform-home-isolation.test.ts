import { expect, it } from '@jest/globals';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataDirectory, type DataDirKey } from '../../src/paths/resolveDataDirectory.js';
import { PathService } from '../../src/paths/PathService.js';
import { PerUserPathResolver } from '../../src/paths/PerUserPathResolver.js';
import { PackageResourceLocator } from '../../src/paths/PackageResourceLocator.js';
import { ElementType } from '../../src/portfolio/types.js';
import { CONFIG_PATH_CLIENTS, getConfigPath } from '../../src/web/routes/setupRoutes.js';
import { clientConfigTarget } from '../../src/web/routes/clientConfigInstaller.js';
import * as hooks from '../../src/utils/permissionHookShared.js';

// Record makes a newly added DataDirKey a compile error until covered here.
const directoryKeys: Record<DataDirKey, true> = {
  config: true, cache: true, state: true, logs: true, run: true,
  'portfolio-root': true, 'shared-pool': true, 'shared-provenance': true,
};

function comparable(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function within(home: string, candidate: string): boolean {
  const relative = path.relative(comparable(home), comparable(candidate));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

it(`keeps all native ${process.platform} default home paths inside the isolated Jest home`, () => {
  const home = realpathSync.native(os.homedir());
  const account = realpathSync.native(os.userInfo().homedir);
  if (comparable(home) === comparable(account) || within(home, account)) {
    throw new Error(`${process.platform}: os.userInfo().homedir no longer identifies an account home outside the fixture`);
  }
  expect(comparable(os.homedir())).toBe(comparable(home));
  const assertInside = (name: string, value: string | undefined | null): void => {
    if (!value || !path.isAbsolute(value) || !within(home, value)) {
      throw new Error(`${process.platform}: ${name} escaped isolated home: ${String(value)} (home ${home})`);
    }
  };
  const variables = ['HOME', 'USERPROFILE', 'DOLLHOUSE_HOME_DIR', 'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA',
    'npm_config_cache', 'npm_config_logs_dir', 'npm_config_prefix',
    'npm_config_userconfig', 'npm_config_globalconfig'];
  const npmAliases = Object.keys(process.env).filter(key =>
    /^npm_config_(cache|logs[_-]dir|prefix|userconfig|globalconfig)$/i.test(key));
  for (const key of new Set([...variables, ...npmAliases])) assertInside(key, process.env[key]);

  const paths = new PathService({
    userResolver: new PerUserPathResolver(resolveDataDirectory('portfolio-root')),
    packageLocator: new PackageResourceLocator(), userIdResolver: () => 'native-isolation',
  });
  for (const key of Object.keys(directoryKeys) as DataDirKey[]) {
    assertInside(`resolveDataDirectory(${key})`, resolveDataDirectory(key));
    assertInside(`PathService.resolveDataDir(${key})`, paths.resolveDataDir(key));
  }
  for (const method of ['getUserPortfolioDir', 'getUserStateDir', 'getUserAuthDir',
    'getUserBackupsDir', 'getUserSecurityDir'] as const) assertInside(`PathService.${method}`, paths[method]());
  for (const type of Object.values(ElementType)) {
    assertInside(`PathService.getUserElementDir(${type})`, paths.getUserElementDir(type));
  }

  // clientConfigTarget exposes no client-ID list; retain the supported adapter cases.
  for (const client of ['claude', 'cline', 'roo-cline', 'windsurf', 'witsy', 'enconvo',
    'cursor', 'gemini-cli', 'vscode', 'claude-code', 'goose', 'zed', 'codex']) {
    assertInside(`clientConfigTarget(${client})`, clientConfigTarget(client).path);
  }
  for (const client of CONFIG_PATH_CLIENTS) {
    assertInside(`setupRoutes.getConfigPath(${client})`, getConfigPath(client));
  }
  // Hook path functions have no exported inventory; wrapper hosts below do.
  for (const method of ['getPermissionHookScriptPath', 'getPermissionHookDiagnosticsPath',
    'getPermissionHookMarkerPath', 'getClaudeHookSettingsPath', 'getVsCodeHookSettingsPath',
    'getVsCodeUserSettingsPath', 'getGeminiHookSettingsPath', 'getCursorHookSettingsPath',
    'getWindsurfHookSettingsPath', 'getCodexHookSettingsPath', 'getCodexConfigPath'] as const) {
    assertInside(`permissionHookShared.${method}`, hooks[method]());
  }
  for (const host of hooks.WRAPPER_HOOK_HOSTS) {
    assertInside(`getHookWrapperPath(${host})`, hooks.getHookWrapperPath(host));
    assertInside(`getPrimaryHookScriptPath(${host})`, hooks.getPrimaryHookScriptPath(host));
    assertInside(`getPermissionHookMarkerPath(${host})`, hooks.getPermissionHookMarkerPath(undefined, host));
  }
  expect(comparable(realpathSync.native(os.userInfo().homedir))).toBe(comparable(account));
});
