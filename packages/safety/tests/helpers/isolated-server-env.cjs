const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const realHome = os.userInfo().homedir;
// Directory names are discovered by pattern, including future product overrides.
// These additional file overrides come from the src environment-path inventory.
const FILE_OVERRIDES = new Set([
  'DOLLHOUSE_AUTH_ALLOWLIST_SEED_FILE', 'DOLLHOUSE_AUTH_LOCAL_KEY_FILE',
  'DOLLHOUSE_CONSOLE_LEADER_LOCK_FILE', 'DOLLHOUSE_CONSOLE_TOKEN_FILE',
  'DOLLHOUSE_LOG_FILE', 'DOLLHOUSE_OAUTH_HELPER_LOG_FILE',
  'DOLLHOUSE_TLS_CERT_PATH', 'DOLLHOUSE_TLS_KEY_PATH', 'DOLLHOUSE_GH_PATH',
]);
const PLATFORM_KEYS = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'XDG_STATE_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA'];
function isPathOverride(key) {
  return /^DOLLHOUSE_.+_DIR$/.test(key) || FILE_OVERRIDES.has(key);
}
// Capture shell inheritance before tests supply their own fixture paths.
const inheritedPaths = new Map(Object.entries(process.env).filter(([key]) => isPathOverride(key)));

const NPM_PATHS = {
  cache: ['.npm'], logs_dir: ['.npm', '_logs'], prefix: ['.npm-prefix'],
  userconfig: ['.npmrc'], globalconfig: ['.npm', 'etc', 'npmrc'],
};
function npmPathSetting(key) {
  const name = key.toLowerCase().replaceAll('-', '_');
  return name.startsWith('npm_config_') && Object.hasOwn(NPM_PATHS, name.slice(11))
    ? name.slice(11) : undefined;
}
// npm destinations need not exist yet. Resolve the existing ancestor so aliases
// of the fixture (including macOS /var) work without creating cache files.
function canonicalDestination(value) {
  let ancestor = path.resolve(value);
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(ancestor), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return undefined;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
function fixturePath(home, value) {
  if (!value || !path.isAbsolute(value)) return undefined;
  const canonical = canonicalDestination(value);
  if (!canonical) return undefined;
  const relative = path.relative(home, canonical);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    ? canonical : undefined;
}
function npmFixturePaths(home, environment) {
  const result = {};
  for (const [setting, suffix] of Object.entries(NPM_PATHS)) {
    const aliases = Object.keys(environment).filter(key => npmPathSetting(key) === setting);
    const explicit = aliases.map(key => fixturePath(home, environment[key])).find(value => value !== undefined);
    const value = explicit ?? path.join(home, ...suffix);
    result[`npm_config_${setting}`] = value;
    for (const alias of aliases) result[alias] = value;
  }
  return result;
}

function canonicalHome(directory) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('Test server home must be an absolute fixture directory');
  let home;
  try { home = fs.realpathSync.native(directory); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Test server home does not exist: ${directory}`, { cause: error });
    throw error;
  }
  const accountHome = fs.realpathSync.native(realHome);
  const isRealHome = process.platform === 'win32'
    ? home.toLowerCase() === accountHome.toLowerCase() : home === accountHome;
  if (isRealHome) throw new Error('Test server home must not be the real user home');
  return home;
}

function environmentForHome(home, environment) {
  const defined = Object.fromEntries(Object.entries(environment).filter(([key, value]) =>
    value !== undefined && !(isPathOverride(key) && inheritedPaths.get(key) === value)));
  return { ...defined, HOME: home, DOLLHOUSE_HOME_DIR: home, USERPROFILE: home,
    DOLLHOUSE_SUPPRESS_VERIFICATION_DIALOG: 'true',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ...npmFixturePaths(home, environment) };
}

/** Explicit test paths survive; inherited shell paths and platform homes do not. */
function isolatedServerEnv(directory, environment = process.env) {
  const home = canonicalHome(directory);
  return environmentForHome(home, environment);
}

/** Native process mutation is required before Jest creates its process.env clone. */
function isolateNativeHome(directory) {
  const home = canonicalHome(directory);
  const npmPaths = npmFixturePaths(home, process.env);
  const keys = new Set([
    ...PLATFORM_KEYS, 'DOLLHOUSE_HOME_DIR', 'DOLLHOUSE_SUPPRESS_VERIFICATION_DIALOG',
    ...Object.keys(process.env).filter(isPathOverride), ...Object.keys(npmPaths),
  ]);
  const previous = Object.fromEntries([...keys].map(key => [key, process.env[key]]));
  const isolated = { ...environmentForHome(home, {}), ...npmPaths };
  for (const key of keys) {
    if (isolated[key] === undefined) delete process.env[key];
    else process.env[key] = isolated[key];
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
module.exports = { isolatedServerEnv, isolateNativeHome };
