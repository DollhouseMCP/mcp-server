/**
 * Setup Routes — Auto-install DollhouseMCP to MCP clients
 *
 * Uses `install-mcp` (https://github.com/supermemoryai/install-mcp)
 * to inject server configuration into supported MCP client config files.
 *
 * Security: localhost-only binding (enforced by server.ts), rate-limited,
 * and command arguments are hardcoded — no user-supplied shell input.
 */

import type { Request, Response } from 'express';
import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { logger } from '../../utils/logger.js';
import { PACKAGE_VERSION } from '../../generated/version.js';

const GITHUB_REPO = 'DollhouseMCP/mcp-server';
const MCPB_ASSET_PATTERN = /^dollhousemcp-.*\.mcpb$/;
import { SlidingWindowRateLimiter } from '../../utils/SlidingWindowRateLimiter.js';

/** Allowed client identifiers — must match install-mcp's --client values */
const ALLOWED_CLIENTS = new Set([
  'claude',
  'claude-code',
  'cursor',
  'vscode',
  'cline',
  'roo-cline',
  'windsurf',
  'witsy',
  'enconvo',
  'gemini-cli',
  'goose',
  'zed',
  'warp',
  'codex',
]);

/** Rate limit: 5 installs per minute */
const installLimiter = new SlidingWindowRateLimiter(5, 60_000);

/**
 * Known config file paths per client.
 * Returns the absolute path for the current platform.
 */
function getConfigPath(client: string): string | null {
  const home = homedir();
  const plat = platform();

  const paths: Record<string, () => string | null> = {
    'claude': () => {
      if (plat === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      if (plat === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
      return join(home, '.config', 'Claude', 'claude_desktop_config.json');
    },
    'claude-code': () => join(home, '.claude.json'),
    'cursor': () => join(home, '.cursor', 'mcp.json'),
    'windsurf': () => join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    'lmstudio': () => join(home, '.lmstudio', 'mcp.json'),
    'gemini-cli': () => join(home, '.gemini', 'settings.json'),
    'codex': () => join(home, '.codex', 'config.toml'),
  };

  const resolver = paths[client];
  return resolver ? resolver() : null;
}

/**
 * Open a file in the system's default text editor.
 */
function openInEditor(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const plat = platform();
    let cmd: string;
    let args: string[];

    if (plat === 'darwin') {
      cmd = 'open';
      args = ['-t', filePath];
    } else if (plat === 'win32') {
      cmd = 'notepad';
      args = [filePath];
    } else {
      cmd = 'xdg-open';
      args = [filePath];
    }

    execFile(cmd, args, { timeout: 10_000 }, (err) => {
      if (err) {
        reject(new Error(`Could not open editor: ${err.message}`));
        return;
      }
      resolve('Opened in editor.');
    });
  });
}

/** Clients whose config files we can locate and open */
const OPENABLE_CLIENTS = new Set([
  'claude', 'claude-code', 'cursor', 'windsurf', 'lmstudio', 'gemini-cli', 'codex',
]);

/**
 * Create setup handlers (Express 5 compatible — plain handler functions, not Router).
 */
export function createSetupRoutes(): {
  installHandler: (req: Request, res: Response) => Promise<void>;
  openConfigHandler: (req: Request, res: Response) => Promise<void>;
  versionHandler: (req: Request, res: Response) => Promise<void>;
  mcpbRedirectHandler: (req: Request, res: Response) => Promise<void>;
} {
  // ── Open config file in editor ──────────────────────────────────────
  const openConfigHandler = async (req: Request, res: Response): Promise<void> => {
    const { client } = req.body as { client?: string };

    if (!client || typeof client !== 'string') {
      res.status(400).json({ error: 'Missing required field: client' });
      return;
    }

    const normalizedClient = client.toLowerCase().trim();
    if (!OPENABLE_CLIENTS.has(normalizedClient)) {
      res.status(400).json({ error: `Cannot open config for: ${client}` });
      return;
    }

    const configPath = getConfigPath(normalizedClient);
    if (!configPath) {
      res.status(400).json({ error: `Config path unknown for: ${client}` });
      return;
    }

    // Create the file with empty content if it doesn't exist yet
    try {
      await access(configPath);
    } catch {
      try {
        await mkdir(dirname(configPath), { recursive: true });
        const content = configPath.endsWith('.toml') ? '' : '{}';
        await writeFile(configPath, content + '\n', 'utf-8');
        logger.info(`[Setup] Created empty config: ${configPath}`);
      } catch (mkErr) {
        const msg = mkErr instanceof Error ? mkErr.message : String(mkErr);
        res.status(500).json({ error: `Could not create config file: ${msg}` });
        return;
      }
    }

    logger.info(`[Setup] Opening config for ${normalizedClient}: ${configPath}`);

    try {
      await openInEditor(configPath);
      res.json({ success: true, path: configPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message, path: configPath });
    }
  };

  // ── Auto-install via install-mcp ────────────────────────────────────
  const installHandler = async (req: Request, res: Response): Promise<void> => {
    if (!installLimiter.tryAcquire()) {
      res.status(429).json({ error: 'Too many install requests. Try again in a minute.' });
      return;
    }

    const { client } = req.body as { client?: string };

    if (!client || typeof client !== 'string') {
      res.status(400).json({ error: 'Missing required field: client' });
      return;
    }

    const normalizedClient = client.toLowerCase().trim();
    if (!ALLOWED_CLIENTS.has(normalizedClient)) {
      res.status(400).json({
        error: `Unsupported client: ${client}`,
        supported: Array.from(ALLOWED_CLIENTS),
      });
      return;
    }

    logger.info(`[Setup] Installing DollhouseMCP to client: ${normalizedClient}`);

    try {
      const output = await runInstallMcp(normalizedClient);
      logger.info(`[Setup] Successfully installed to ${normalizedClient}`);
      res.json({ success: true, output, client: normalizedClient });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[Setup] Install failed for ${normalizedClient}: ${message}`);
      res.status(500).json({ success: false, error: message, client: normalizedClient });
    }
  };

  // ── Version info ─────────────────────────────────────────────────────
  const versionHandler = async (_req: Request, res: Response): Promise<void> => {
    const local = {
      version: PACKAGE_VERSION,
      mcpbUrl: `https://github.com/${GITHUB_REPO}/releases/download/v${PACKAGE_VERSION}/dollhousemcp-${PACKAGE_VERSION}.mcpb`,
    };

    // Query GitHub for the actual latest release
    let latest = local;
    try {
      const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'DollhouseMCP-Setup' },
        signal: AbortSignal.timeout(5000),
      });
      if (ghRes.ok) {
        const release = await ghRes.json() as { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
        const mcpbAsset = release.assets.find(a => MCPB_ASSET_PATTERN.test(a.name));
        latest = {
          version: release.tag_name.replace(/^v/, ''),
          mcpbUrl: mcpbAsset?.browser_download_url ||
            `https://github.com/${GITHUB_REPO}/releases/download/${release.tag_name}/dollhousemcp-${release.tag_name.replace(/^v/, '')}.mcpb`,
        };
      }
    } catch {
      // GitHub unreachable — use local version info
    }

    res.json({
      running: local,
      latest,
      isLatest: local.version === latest.version,
    });
  };

  // ── .mcpb download redirect ─────────────────────────────────────────
  const mcpbRedirectHandler = async (_req: Request, res: Response): Promise<void> => {
    // Try GitHub API for the actual latest .mcpb asset URL
    try {
      const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'DollhouseMCP-Setup' },
        signal: AbortSignal.timeout(5000),
      });
      if (ghRes.ok) {
        const release = await ghRes.json() as { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
        const mcpbAsset = release.assets.find(a => MCPB_ASSET_PATTERN.test(a.name));
        if (mcpbAsset) {
          res.redirect(mcpbAsset.browser_download_url);
          return;
        }
      }
    } catch {
      // Fall through to constructed URL
    }

    // Fallback: construct URL from running version
    const url = `https://github.com/${GITHUB_REPO}/releases/download/v${PACKAGE_VERSION}/dollhousemcp-${PACKAGE_VERSION}.mcpb`;
    res.redirect(url);
  };

  return { installHandler, openConfigHandler, versionHandler, mcpbRedirectHandler };
}

/**
 * Resolve the install-mcp binary path.
 * Uses the local dependency (node_modules/.bin/install-mcp) first,
 * falls back to npx if not found.
 */
function resolveInstallMcpBin(): { cmd: string; prefixArgs: string[] } {
  const localBin = join(dirname(dirname(dirname(__dirname))), 'node_modules', '.bin', 'install-mcp');
  try {
    accessSync(localBin, fsConstants.X_OK);
    return { cmd: localBin, prefixArgs: [] };
  } catch {
    return { cmd: 'npx', prefixArgs: ['install-mcp'] };
  }
}

/**
 * Run install-mcp to configure a specific MCP client.
 *
 * Uses the bundled install-mcp dependency (MIT, https://github.com/supermemoryai/install-mcp).
 * Command arguments are fully hardcoded — no user input reaches the shell.
 * execFile is used (not exec) to prevent shell injection.
 */
function runInstallMcp(client: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { cmd, prefixArgs } = resolveInstallMcpBin();
    const args = [
      ...prefixArgs,
      '@dollhousemcp/mcp-server@latest',
      '--client', client,
      '--name', 'dollhousemcp',
      '--yes',
    ];

    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout || 'Installation completed.');
    });
  });
}
