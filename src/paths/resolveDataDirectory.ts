/**
 * resolveDataDirectory — canonical path resolution for DollhouseMCP subsystems.
 *
 * Pure function. No I/O, no side effects. Deterministic output given
 * platform, home directory, environment, and an optional legacy-root hint.
 *
 * Resolution precedence (highest first):
 *   1. `DOLLHOUSE_<KEY>_DIR` env override — always wins.
 *   2. Legacy-root mode — when `opts.legacyRoot` is supplied, preserves
 *      byte-identical paths under an existing `~/.dollhouse/` install.
 *   3. Platform-correct defaults — follows the env-paths convention
 *      (XDG on Linux, Library on macOS, LOCALAPPDATA on Windows) for
 *      app internals. Portfolio root defaults to a visible user-facing
 *      directory on all platforms.
 *
 * Consumers inject this via PathService rather than calling it directly.
 *
 * Env is read lazily on every call. Callers that capture `dataDirectoryOptions`
 * at bootstrap (e.g. `PathsServiceRegistrar`) do not freeze `env`; each
 * `resolveDataDir` invocation reads the current `process.env`. This matters
 * for hosted deployments that rotate env vars at runtime; operators expect
 * overrides to take effect without restart.
 *
 * **Trust boundary:** env vars are an *operator*-trusted surface. Never plumb
 * HTTP request headers, MCP tool input, or other user-controlled data into
 * `opts.env`. The function trusts its inputs and makes no attempt to sandbox
 * suspicious values — `PathValidator` is the sandbox.
 *
 * @since Step 4.5
 */

import * as os from 'node:os';
import path from 'node:path';

/**
 * Canonical subsystem keys. Every DollhouseMCP directory resolves under
 * one of these. Keys are stable across platforms; per-platform locations
 * vary (see platform-default sections below).
 */
export type DataDirKey =
  | 'config'
  | 'cache'
  | 'state'
  | 'logs'
  | 'run'
  | 'portfolio-root'
  | 'shared-pool'
  | 'shared-provenance';

export interface ResolveOptions {
  /** Override platform detection. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;

  /** Override home directory. Defaults to `env.DOLLHOUSE_HOME_DIR || os.homedir()`. */
  homeDir?: string;

  /**
   * Backward-compat anchor. When supplied, all keys resolve under this
   * root using the pre-Step-4.5 layout — existing installs continue to
   * work byte-identical. Callers determine legacy root by detecting
   * `~/.dollhouse/` on disk; the resolver itself stays pure.
   */
  legacyRoot?: string;

  /** Override process environment. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const APP_LOWER = 'dollhousemcp';
const APP_MIXED = 'DollhouseMCP';

/** Env-var name that overrides each key. Kept in one place for audit. */
const ENV_OVERRIDE: Readonly<Record<DataDirKey, string>> = Object.freeze({
  'config': 'DOLLHOUSE_CONFIG_DIR',
  'cache': 'DOLLHOUSE_CACHE_DIR',
  'state': 'DOLLHOUSE_STATE_DIR',
  'logs': 'DOLLHOUSE_LOG_DIR',
  'run': 'DOLLHOUSE_RUN_DIR',
  'portfolio-root': 'DOLLHOUSE_PORTFOLIO_DIR',
  'shared-pool': 'DOLLHOUSE_SHARED_POOL_DIR',
  'shared-provenance': 'DOLLHOUSE_SHARED_PROVENANCE_DIR',
});

/**
 * Resolve an absolute directory path for the given key.
 */
export function resolveDataDirectory(
  key: DataDirKey,
  opts: ResolveOptions = {}
): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const homeDir = opts.homeDir ?? sanitizedEnv('DOLLHOUSE_HOME_DIR', env.DOLLHOUSE_HOME_DIR) ?? os.homedir();

  const envValue = env[ENV_OVERRIDE[key]];
  if (envValue !== undefined && envValue.trim().length > 0) {
    const sanitized = sanitizedEnv(ENV_OVERRIDE[key], envValue);
    if (sanitized !== null) {
      if (!path.isAbsolute(sanitized)) {
        throw new Error(
          `${ENV_OVERRIDE[key]} must be an absolute path, got ${sanitized}`
        );
      }
      return path.resolve(sanitized);
    }
  }

  if (opts.legacyRoot) {
    return resolveLegacy(key, opts.legacyRoot);
  }

  return resolvePlatformDefault(key, platform, homeDir, env);
}

/**
 * Legacy mode — preserves pre-Step-4.5 layout under an existing
 * `~/.dollhouse/` install. The exact subdirectory names match what the
 * old ad-hoc path computations used so existing installs see no change.
 */
function resolveLegacy(key: DataDirKey, legacyRoot: string): string {
  const root = path.resolve(legacyRoot);
  switch (key) {
    case 'config':
      return root;
    case 'cache':
      return path.join(root, '.dollhousemcp', 'cache');
    case 'state':
      return path.join(root, 'state');
    case 'logs':
      return path.join(root, 'logs');
    case 'run':
      return path.join(root, 'run');
    case 'portfolio-root':
      return path.join(root, 'portfolio');
    case 'shared-pool':
      return path.join(root, 'shared');
    case 'shared-provenance':
      return path.join(root, 'shared', '.provenance');
  }
}

/**
 * Platform-correct defaults for a fresh install.
 */
function resolvePlatformDefault(
  key: DataDirKey,
  platform: NodeJS.Platform,
  homeDir: string,
  env: NodeJS.ProcessEnv
): string {
  switch (key) {
    case 'portfolio-root':
      return path.join(homeDir, APP_MIXED);
    case 'shared-pool':
      return path.join(homeDir, APP_MIXED, 'shared');
    case 'shared-provenance':
      return path.join(homeDir, APP_MIXED, 'shared', '.provenance');
  }

  if (platform === 'win32') {
    return resolveWindows(key, env, homeDir);
  }
  if (platform === 'darwin') {
    return resolveMacOS(key, homeDir);
  }
  return resolveXDG(key, env, homeDir);
}

type AppInternalKey = Exclude<DataDirKey, 'portfolio-root' | 'shared-pool' | 'shared-provenance'>;

function resolveXDG(key: AppInternalKey, env: NodeJS.ProcessEnv, homeDir: string): string {
  const xdgConfig = sanitizedEnv('XDG_CONFIG_HOME', env.XDG_CONFIG_HOME) ?? path.join(homeDir, '.config');
  const xdgCache = sanitizedEnv('XDG_CACHE_HOME', env.XDG_CACHE_HOME) ?? path.join(homeDir, '.cache');
  const xdgState = sanitizedEnv('XDG_STATE_HOME', env.XDG_STATE_HOME) ?? path.join(homeDir, '.local', 'state');
  switch (key) {
    case 'config': return path.join(xdgConfig, APP_LOWER);
    case 'cache':  return path.join(xdgCache, APP_LOWER);
    case 'state':  return path.join(xdgState, APP_LOWER);
    case 'logs':   return path.join(xdgState, APP_LOWER, 'logs');
    case 'run':    return path.join(xdgState, APP_LOWER, 'run');
    default: return assertNever(key);
  }
}

function resolveMacOS(key: AppInternalKey, homeDir: string): string {
  const library = path.join(homeDir, 'Library');
  switch (key) {
    case 'config': return path.join(library, 'Preferences', APP_MIXED);
    case 'cache':  return path.join(library, 'Caches', APP_MIXED);
    case 'state':  return path.join(library, 'Application Support', APP_MIXED);
    case 'logs':   return path.join(library, 'Logs', APP_MIXED);
    case 'run':    return path.join(library, 'Application Support', APP_MIXED, 'run');
    default: return assertNever(key);
  }
}

function resolveWindows(key: AppInternalKey, env: NodeJS.ProcessEnv, homeDir: string): string {
  const localAppData = sanitizedEnv('LOCALAPPDATA', env.LOCALAPPDATA) ?? path.join(homeDir, 'AppData', 'Local');
  const appData = sanitizedEnv('APPDATA', env.APPDATA) ?? path.join(homeDir, 'AppData', 'Roaming');
  switch (key) {
    case 'config': return path.join(appData, APP_MIXED, 'Config');
    case 'cache':  return path.join(localAppData, APP_MIXED, 'Cache');
    case 'state':  return path.join(localAppData, APP_MIXED, 'Data');
    case 'logs':   return path.join(localAppData, APP_MIXED, 'Log');
    case 'run':    return path.join(localAppData, APP_MIXED, 'Run');
    default: return assertNever(key);
  }
}

/**
 * Exhaustiveness helper. If a new `DataDirKey` is added and one of the
 * platform switches forgets to handle it, this will surface as a compile
 * error (the `never`-typed parameter can't be satisfied) rather than a
 * silent runtime fallthrough.
 */
function assertNever(x: never): never {
  throw new Error(`resolveDataDirectory: unhandled key ${x as string}`);
}

/**
 * Reject env-var values containing null bytes or ASCII control characters.
 * These can hide traversal payloads (null byte truncates on some syscalls),
 * confuse logging, and mess with shell escaping if the path is forwarded
 * to a subprocess. Whitespace-only values are rejected upstream by the
 * `trim().length > 0` check.
 */
function rejectControlChars(name: string, value: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} contains control characters — reject`);
  }
}

/**
 * Sanitize an env-var value for use as a path root. Returns the trimmed
 * value if it's a non-empty, control-char-free string; otherwise returns
 * `null` so the caller can fall through to its default. Applied to XDG
 * and Windows platform-native env vars (`XDG_CONFIG_HOME`, `LOCALAPPDATA`,
 * etc.) — the DollhouseMCP-specific `DOLLHOUSE_*_DIR` vars have their own
 * gate earlier in the pipeline.
 */
function sanitizedEnv(name: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  rejectControlChars(name, value);
  return trimmed;
}

/**
 * Exposed for tests and documentation — the env var that overrides a key.
 */
export function envOverrideFor(key: DataDirKey): string {
  return ENV_OVERRIDE[key];
}
