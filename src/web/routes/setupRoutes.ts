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
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { logger } from '../../utils/logger.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { PACKAGE_VERSION } from '../../generated/version.js';

const GITHUB_REPO = 'DollhouseMCP/mcp-server';
const MCPB_ASSET_PATTERN = /^dollhousemcp-.*\.mcpb$/;
import { SlidingWindowRateLimiter } from '../../utils/SlidingWindowRateLimiter.js';
import { PostHog } from 'posthog-node';
import { v4 as uuidv4 } from 'uuid';

// PostHog project key (write-only, safe to expose) — same key as OperationalTelemetry
const POSTHOG_PROJECT_KEY = process.env.POSTHOG_API_KEY || 'phc_xFJKIHAqRX1YLa0TSdTGwGj19d1JeoXDKjJNYq492vq';

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
interface DetectResult {
  installed: boolean;
  configPath: string | null;
  currentConfig?: Record<string, unknown>;
  serverKey?: string;
}

/** Parse a TOML config file for a DollhouseMCP server entry */
function parseTomlConfig(raw: string): Omit<DetectResult, 'configPath'> {
  if (!raw.toLowerCase().includes('dollhousemcp')) {
    return { installed: false };
  }

  const tomlConfig: Record<string, unknown> = {};
  const sectionMatch = /\[mcp_servers\.([^\]]*dollhousemcp[^\]]*)\]/i.exec(raw);
  if (!sectionMatch) return { installed: true, currentConfig: tomlConfig, serverKey: 'mcp_servers' };

  tomlConfig.serverName = sectionMatch[1];
  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const nextSection = raw.indexOf('\n[', sectionStart);
  const sectionContent = nextSection > -1 ? raw.slice(sectionStart, nextSection) : raw.slice(sectionStart);

  const commandMatch = /command\s*=\s*"([^"]+)"/.exec(sectionContent);
  const argsMatch = /args\s*=\s*\[([^\]]*)\]/.exec(sectionContent);
  if (commandMatch) tomlConfig.command = commandMatch[1];
  if (argsMatch) {
    tomlConfig.args = argsMatch[1].split(',').map(s => s.trim().replaceAll('"', ''));
  }
  return { installed: true, currentConfig: tomlConfig, serverKey: 'mcp_servers' };
}

/** Parse a JSON config file for a DollhouseMCP server entry */
function parseJsonConfig(raw: string): Omit<DetectResult, 'configPath'> {
  const parsed = JSON.parse(raw);
  for (const key of ['mcpServers', 'servers']) {
    if (parsed[key]?.dollhousemcp) {
      return { installed: true, currentConfig: parsed[key].dollhousemcp, serverKey: key };
    }
  }
  return { installed: false };
}

/** Check a single client config file for an existing DollhouseMCP entry */
async function detectClient(client: string): Promise<DetectResult | null> {
  const configPath = getConfigPath(client);
  if (!configPath) return null;

  try {
    await access(configPath);
  } catch {
    return { installed: false, configPath };
  }

  try {
    const raw = await readFile(configPath, 'utf-8');
    const result = configPath.endsWith('.toml') ? parseTomlConfig(raw) : parseJsonConfig(raw);
    return { configPath, ...result };
  } catch {
    return { installed: false, configPath };
  }
}

/**
 * Validate and normalize a client name from request body.
 * Returns the normalized client name or null (with error response sent).
 */
function validateClient(
  req: Request, res: Response, allowedSet: Set<string>,
): string | null {
  const { client } = req.body as { client?: string };
  if (!client || typeof client !== 'string') {
    res.status(400).json({ error: 'Missing required field: client' });
    return null;
  }
  const normalized = UnicodeValidator.normalize(client).normalizedContent.toLowerCase().trim();
  if (!allowedSet.has(normalized)) {
    res.status(400).json({
      error: `Unsupported client: ${client}`,
      supported: Array.from(allowedSet),
    });
    return null;
  }
  return normalized;
}

// ── License helpers (module scope for SonarCloud S7721) ──────────────

const VALID_LICENSE_TIERS = new Set(['agpl', 'free-commercial', 'paid-commercial']);
const VALID_REVENUE_SCALES = new Set(['$1M–$5M', '$5M–$25M', '$25M–$100M', '$100M+']);
// Safe from ReDoS: input is pre-checked to ≤254 chars, and {1,64}/{1,253}/{2,63}
// bounds prevent catastrophic backtracking on any input within that length.
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;

/** Sanitize a string field: trim, truncate, return undefined if empty. */
function sanitize(val: unknown, maxLen: number): string | undefined {
  if (typeof val !== 'string' || !val.trim()) return undefined;
  return val.trim().slice(0, maxLen);
}

/** Validate license form input. Returns error string or null if valid. */
function validateLicenseInput(body: Record<string, unknown>): string | null {
  const { tier, email, revenueScale, companyName, useCase } = body;
  if (!tier || !VALID_LICENSE_TIERS.has(tier as string)) {
    return `Invalid license tier. Must be one of: ${[...VALID_LICENSE_TIERS].join(', ')}`;
  }
  if (tier !== 'agpl') {
    if (!email || typeof email !== 'string') {
      return 'Email address is required for commercial licenses';
    }
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      return 'Please provide a valid email address';
    }
  }
  if (tier === 'paid-commercial') {
    if (!revenueScale || !VALID_REVENUE_SCALES.has(revenueScale as string)) {
      return `Revenue scale is required. Must be one of: ${[...VALID_REVENUE_SCALES].join(', ')}`;
    }
    if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
      return 'Company name is required for Enterprise licenses';
    }
    if (!useCase || typeof useCase !== 'string' || !useCase.trim()) {
      return 'Use case is required for Enterprise licenses';
    }
  }
  return null;
}

/** Build license data object from validated input. */
function buildLicenseData(body: Record<string, unknown>): Record<string, unknown> {
  const { tier, email, revenueScale, companyName, useCase } = body;
  const data: Record<string, unknown> = { tier };
  if (tier !== 'agpl') {
    data.email = sanitize(email, 254);
    data.attestedAt = new Date().toISOString();
  }
  if (tier === 'paid-commercial') {
    if (revenueScale) data.revenueScale = revenueScale;
    if (companyName) data.companyName = sanitize(companyName, 200);
    if (useCase) data.useCase = sanitize(useCase, 500);
  }
  return data;
}

/** Send license_activation event to PostHog for commercial tiers. */
async function capturePostHogLicenseEvent(licenseData: Record<string, unknown>): Promise<void> {
  const posthog = new PostHog(POSTHOG_PROJECT_KEY, {
    host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
    flushAt: 1,
    flushInterval: 5000,
  });
  let installId: string;
  try {
    const idPath = join(homedir(), '.dollhouse', '.telemetry-id');
    installId = (await readFile(idPath, 'utf-8')).trim();
  } catch {
    installId = uuidv4();
  }
  posthog.capture({
    distinctId: installId,
    event: 'license_activation',
    properties: {
      tier: licenseData.tier,
      email: licenseData.email,
      server_version: PACKAGE_VERSION,
      os: platform(),
      ...(licenseData.tier === 'paid-commercial' ? {
        revenue_scale: licenseData.revenueScale,
        company_name: licenseData.companyName,
        use_case: licenseData.useCase,
      } : {}),
    },
  });
  await posthog.shutdown();
}

export function createSetupRoutes(): {
  installHandler: (req: Request, res: Response) => Promise<void>;
  openConfigHandler: (req: Request, res: Response) => Promise<void>;
  versionHandler: (req: Request, res: Response) => Promise<void>;
  mcpbRedirectHandler: (req: Request, res: Response) => Promise<void>;
  detectHandler: (req: Request, res: Response) => Promise<void>;
  getLicenseHandler: (req: Request, res: Response) => Promise<void>;
  setLicenseHandler: (req: Request, res: Response) => Promise<void>;
} {
  // ── Detect existing installations ───────────────────────────────────
  const detectHandler = async (_req: Request, res: Response): Promise<void> => {
    const clients = [
      { id: 'claude', name: 'Claude Desktop' },
      { id: 'claude-code', name: 'Claude Code' },
      { id: 'cursor', name: 'Cursor' },
      { id: 'windsurf', name: 'Windsurf' },
      { id: 'lmstudio', name: 'LM Studio' },
      { id: 'gemini-cli', name: 'Gemini CLI' },
      { id: 'codex', name: 'Codex' },
    ];

    const results: Record<string, unknown> = {};
    await Promise.all(clients.map(async ({ id, name }) => {
      const detection = await detectClient(id);
      if (detection) {
        results[id] = { name, ...detection };
      }
    }));

    res.json(results);
  };

  // ── Open config file in editor ──────────────────────────────────────
  const openConfigHandler = async (req: Request, res: Response): Promise<void> => {
    const normalizedClient = validateClient(req, res, OPENABLE_CLIENTS);
    if (!normalizedClient) return;

    const configPath = getConfigPath(normalizedClient);
    if (!configPath) {
      res.status(400).json({ error: `Config path unknown for: ${normalizedClient}` });
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

    const normalizedClient = validateClient(req, res, ALLOWED_CLIENTS);
    if (!normalizedClient) return;

    // Validate version if provided — must be semver-like (no shell injection)
    const { version } = req.body as { version?: string };
    const normalizedVersion = version ? UnicodeValidator.normalize(version).normalizedContent : undefined;
    if (normalizedVersion && !/^\d+\.\d+\.\d+/.test(normalizedVersion)) {
      res.status(400).json({ error: 'Invalid version format. Expected semver (e.g., 2.0.2)' });
      return;
    }

    const tag = normalizedVersion ? `@${normalizedVersion}` : '@latest';
    logger.info(`[Setup] Installing DollhouseMCP${tag} to client: ${normalizedClient}`);

    try {
      const output = await runInstallMcp(normalizedClient, normalizedVersion);
      logger.info(`[Setup] Successfully installed to ${normalizedClient}`);
      res.json({ success: true, output, client: normalizedClient, version: normalizedVersion || 'latest' });
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

  // ── License selection ────────────────────────────────────────────────
  const licenseConfigPath = join(homedir(), '.dollhouse', 'license.json');

  async function readLicense(): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(licenseConfigPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { tier: 'agpl' };
    }
  }

  async function writeLicense(data: Record<string, unknown>): Promise<void> {
    const dir = join(homedir(), '.dollhouse');
    await mkdir(dir, { recursive: true });
    await writeFile(licenseConfigPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  const getLicenseHandler = async (_req: Request, res: Response): Promise<void> => {
    res.json(await readLicense());
  };

  const licenseRateLimiter = new SlidingWindowRateLimiter(5, 60_000); // 5 requests/minute

  const setLicenseHandler = async (req: Request, res: Response): Promise<void> => {
    if (!licenseRateLimiter.tryAcquire()) {
      res.status(429).json({ error: 'Too many license requests. Please try again in a minute.' });
      return;
    }

    const body = req.body ?? {};
    const validationError = validateLicenseInput(body);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const licenseData = buildLicenseData(body);

    try {
      await writeLicense(licenseData);
      logger.info(`[Setup] License updated to: ${licenseData.tier}`);

      if (licenseData.tier !== 'agpl') {
        try {
          await capturePostHogLicenseEvent(licenseData);
          logger.info(`[Setup] License event sent to PostHog: ${licenseData.tier}`);
        } catch (posthogError) {
          logger.debug(`[Setup] PostHog capture failed: ${posthogError instanceof Error ? posthogError.message : String(posthogError)}`);
        }
      }

      res.json({ success: true, license: licenseData });
    } catch (error) {
      logger.error('[Setup] Failed to save license', { error });
      res.status(500).json({ error: 'Failed to save license configuration' });
    }
  };

  return { installHandler, openConfigHandler, versionHandler, mcpbRedirectHandler, detectHandler, getLicenseHandler, setLicenseHandler };
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
function runInstallMcp(client: string, version?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { cmd, prefixArgs } = resolveInstallMcpBin();
    const tag = version ? `@${version}` : '@latest';
    const args = [
      ...prefixArgs,
      `@dollhousemcp/mcp-server${tag}`,
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
