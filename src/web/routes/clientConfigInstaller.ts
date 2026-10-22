/**
 * Config-only adapter derived from install-mcp 1.10.2 client-config/install code.
 * Copyright (c) Dhravya Shah. MIT; see ../../vendor/install-mcp-LICENSE.
 * Only the global, named stdio installation used by setupRoutes is retained.
 * No downloads, command parsing, authentication, prompts, or child processes.
 */
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CORE_SCHEMA, dump, load } from 'js-yaml';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

interface InstallEnvironment {
  home?: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
}
type Config = Record<string, any>;
type Target = { path: string; keys: string[]; format?: 'yaml' | 'toml' };

export function clientConfigTarget(client: string, environment: InstallEnvironment = {}): Target {
  const home = environment.home ?? homedir();
  const os = environment.platform ?? platform();
  const env = environment.env ?? process.env;
  const base = os === 'darwin' ? join(home, 'Library', 'Application Support')
    : os === 'win32' ? env.APPDATA || join(home, 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME || join(home, '.config');
  const code = join(base, 'Code', 'User');
  const json = (path: string, keys = ['mcpServers']): Target => ({ path, keys });
  const targets: Record<string, Target> = {
    claude: json(join(base, 'Claude', 'claude_desktop_config.json')),
    cline: json(join(code, 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')),
    'roo-cline': json(join(code, 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json')),
    windsurf: json(join(home, '.codeium', 'windsurf', 'mcp_config.json')),
    witsy: json(join(base, 'Witsy', 'settings.json')),
    enconvo: json(join(home, '.config', 'enconvo', 'mcp_config.json')),
    cursor: json(join(home, '.cursor', 'mcp.json')),
    'gemini-cli': json(join(home, '.gemini', 'settings.json')),
    vscode: json(join(code, 'settings.json'), ['mcp', 'servers']),
    'claude-code': json(join(home, '.claude.json')),
    goose: { path: join(home, '.config', 'goose', 'config.yaml'), keys: ['extensions'], format: 'yaml' },
    zed: json(os === 'win32' ? join(base, 'Zed', 'settings.json') : join(home, '.config', 'zed', 'settings.json'), ['context_servers']),
    codex: { path: join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), keys: ['mcp_servers'], format: 'toml' },
  };
  if (!Object.hasOwn(targets, client)) throw new Error(`Unsupported MCP client: ${client}`);
  return targets[client];
}

function object(value: unknown): value is Config {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Preserve unrelated config; reject malformed files instead of replacing them. */
export async function installClientConfig(client: string, version = 'latest', environment: InstallEnvironment = {}): Promise<string> {
  if (!/^(latest|beta|rc|\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/.test(version)) throw new Error('Invalid install version');
  const server = { command: 'npx', args: [`@dollhousemcp/mcp-server@${version}`] };
  if (client === 'warp') {
    return 'Warp requires manual installation through its UI. Copy this configuration:\n' + JSON.stringify({
      dollhousemcp: { ...server, env: {}, working_directory: null, start_on_launch: true },
    }, null, 2);
  }
  const target = clientConfigTarget(client, environment);
  let destination = target.path;
  try {
    // Keep dotfile-manager symlinks intact. A dangling link is an error, since
    // replacing it would silently disconnect the user's managed configuration.
    const entry = await lstat(target.path);
    destination = await realpath(target.path).catch(error => {
      if (entry.isSymbolicLink()) throw new Error('Client config symlink target is unavailable', { cause: error });
      throw error;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let config: unknown = {};
  let mode = 0o600;
  try {
    const source = await readFile(destination, 'utf8');
    if (source.length > 2 * 1024 * 1024) throw new Error('Client config exceeds 2 MB');
    config = target.format === 'yaml' ? load(source, { schema: CORE_SCHEMA }) ?? {}
      : target.format === 'toml' ? parseToml(source) : JSON.parse(source);
    mode = (await stat(destination)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!object(config)) throw new Error('Client config must contain an object');
  // Bound expansion and reject cyclic aliases before serialization (noRefs).
  const ancestors = new WeakSet<object>();
  let nodes = 100_000;
  let text = 4 * 1024 * 1024;
  const validate = (value: unknown, depth = 0): void => {
    if (--nodes < 0 || depth > 64) throw new Error('Client config structure limit exceeded');
    if (typeof value === 'string') text -= value.length;
    if (text < 0) throw new Error('Client config text expansion limit exceeded');
    if (value === null || typeof value !== 'object') return;
    if (ancestors.has(value)) throw new Error('Cyclic client config');
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) {
      text -= key.length;
      if (text < 0) throw new Error('Client config text expansion limit exceeded');
      validate(child, depth + 1);
    }
    ancestors.delete(value);
  };
  validate(config);
  let servers = config;
  for (const key of target.keys) {
    if (!Object.hasOwn(servers, key)) Object.defineProperty(servers, key, { value: {}, enumerable: true, writable: true, configurable: true });
    if (!object(servers[key])) throw new Error(`Invalid client config section: ${key}`);
    servers = servers[key];
  }
  const previous = Object.hasOwn(servers, 'dollhousemcp') && object(servers.dollhousemcp) ? servers.dollhousemcp : {};
  const entry = client === 'goose'
    ? { ...previous, name: 'dollhousemcp', cmd: server.command, ...server, enabled: true, envs: previous.envs ?? {}, type: 'stdio', timeout: 300 }
    : client === 'zed' ? { ...previous, source: 'custom', env: previous.env ?? {}, ...server } : { ...previous, ...server };
  Object.defineProperty(servers, 'dollhousemcp', { value: entry, enumerable: true, writable: true, configurable: true });
  const content = target.format === 'yaml' ? dump(config, { schema: CORE_SCHEMA, noRefs: true, lineWidth: -1 })
    : target.format === 'toml' ? stringifyToml(config) : JSON.stringify(config, null, 2) + '\n';
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', mode);
    try { await file.writeFile(content, 'utf8'); } finally { await file.close(); }
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  return `Config written to: ${target.path}`;
}
