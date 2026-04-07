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
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { randomInt } from 'node:crypto';
import { PostHog } from 'posthog-node';
import { v4 as uuidv4 } from 'uuid';

// PostHog project capture key — write-only by design, safe to expose publicly.
// This key can ONLY send events to PostHog; it cannot read data, query analytics,
// configure destinations, or access any other PostHog API. Same key used in
// src/telemetry/OperationalTelemetry.ts. Verified write-only 2026-04-07.
// Can be overridden with POSTHOG_API_KEY env var for custom PostHog installations.
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

// ── License verification ─────────────────────────────────────────────

const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const VERIFICATION_MAX_ATTEMPTS = 5;

/** Generate a cryptographically random 6-digit verification code. */
function generateVerificationCode(): string {
  return String(randomInt(100000, 999999));
}

/** Check if a verification code has expired. */
function isCodeExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
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

/** Validate email format and commercial acknowledgments. */
function validateCommercialFields(body: Record<string, unknown>): string | null {
  const { email, telemetryAcknowledged } = body;
  if (!email || typeof email !== 'string') {
    return 'Email address is required for Commercial and Enterprise licenses';
  }
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return 'Please provide a valid email address';
  }
  if (!telemetryAcknowledged) {
    return 'Telemetry acknowledgment is required for Commercial and Enterprise licenses';
  }
  return null;
}

/** Validate free-commercial specific fields. */
function validateFreeCommercialFields(body: Record<string, unknown>): string | null {
  const { attributionAcknowledged, revenueAttested } = body;
  if (!attributionAcknowledged) {
    return 'Attribution acknowledgment is required for Commercial licenses';
  }
  if (!revenueAttested) {
    return 'Revenue attestation is required for Commercial licenses';
  }
  return null;
}

/** Validate enterprise specific fields. */
function validateEnterpriseFields(body: Record<string, unknown>): string | null {
  const { revenueScale, companyName, useCase } = body;
  if (!revenueScale || !VALID_REVENUE_SCALES.has(revenueScale as string)) {
    return `Revenue scale is required. Must be one of: ${[...VALID_REVENUE_SCALES].join(', ')}`;
  }
  if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
    return 'Company name is required for Enterprise licenses';
  }
  if (!useCase || typeof useCase !== 'string' || !useCase.trim()) {
    return 'Use case is required for Enterprise licenses';
  }
  return null;
}

/** Validate license form input. Returns error string or null if valid. */
function validateLicenseInput(body: Record<string, unknown>): string | null {
  const { tier } = body;
  if (!tier || !VALID_LICENSE_TIERS.has(tier as string)) {
    return `Invalid license tier. Must be one of: ${[...VALID_LICENSE_TIERS].join(', ')}`;
  }
  if (tier !== 'agpl') {
    const commercialError = validateCommercialFields(body);
    if (commercialError) return commercialError;
  }
  if (tier === 'free-commercial') {
    const freeError = validateFreeCommercialFields(body);
    if (freeError) return freeError;
  }
  if (tier === 'paid-commercial') {
    const enterpriseError = validateEnterpriseFields(body);
    if (enterpriseError) return enterpriseError;
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
    data.telemetryRequired = true;
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
  const eventType = (licenseData.eventType as string) ?? 'activation';
  posthog.capture({
    distinctId: installId,
    event: 'license_activation',
    properties: {
      tier: licenseData.tier,
      email: licenseData.email,
      event_type: eventType,
      server_version: PACKAGE_VERSION,
      os: platform(),
      ...(eventType === 'verification' ? {
        verification_code: licenseData.verificationCode,
      } : {}),
      ...(eventType === 'activation' ? {
        verification_time_ms: licenseData.verification_time_ms,
        verification_time_seconds: licenseData.verification_time_ms
          ? Math.round((licenseData.verification_time_ms as number) / 1000) : undefined,
        verification_attempts: licenseData.verification_attempts,
      } : {}),
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
  verifyLicenseHandler: (req: Request, res: Response) => Promise<void>;
  resendVerificationHandler: (req: Request, res: Response) => Promise<void>;
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
    const license = await readLicense();
    // Never expose verification internals to client
    const { verificationCode: _code, verificationAttempts: _attempts, ...publicLicense } = license;
    res.json(publicLicense);
  };

  const licenseRateLimiter = new SlidingWindowRateLimiter(5, 60_000); // 5 requests/minute

  const setLicenseHandler = async (req: Request, res: Response): Promise<void> => {
    if (!licenseRateLimiter.tryAcquire()) {
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_EXCEEDED',
        severity: 'MEDIUM',
        source: 'setupRoutes.setLicenseHandler',
        details: 'License endpoint rate limit exceeded (5 req/min)',
      });
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
      if (licenseData.tier === 'agpl') {
        // AGPL: activate immediately, no verification needed
        licenseData.status = 'active';
        await writeLicense(licenseData);
        logger.info('[Setup] License set to AGPL (active, no verification)');
        res.json({ success: true, license: licenseData });
        return;
      }

      // Commercial tiers: save as pending, generate verification code
      const code = generateVerificationCode();
      licenseData.status = 'pending';
      licenseData.verificationCode = code;
      licenseData.verificationExpiry = new Date(Date.now() + VERIFICATION_CODE_TTL_MS).toISOString();
      licenseData.verificationAttempts = 0;
      licenseData.verificationRequestedAt = new Date().toISOString();
      await writeLicense(licenseData);

      logger.info(`[Setup] License pending verification: ${licenseData.tier} (${licenseData.email})`);

      SecurityMonitor.logSecurityEvent({
        type: 'CONFIG_UPDATED',
        severity: 'LOW',
        source: 'setupRoutes.setLicenseHandler',
        details: `License verification initiated: ${licenseData.tier}`,
        additionalData: {
          tier: licenseData.tier,
          email: licenseData.email,
        },
      });

      // Send verification email directly to Worker for instant delivery.
      // PostHog event also fires for analytics, but the email can't wait for
      // PostHog's event pipeline (1-5 min delay).
      try {
        const workerUrl = process.env.DOLLHOUSE_LICENSE_WORKER_URL || 'https://dollhousemcp-license-email.mick-eba.workers.dev';
        const workerSecret = process.env.DOLLHOUSE_LICENSE_WORKER_SECRET || '';
        await fetch(workerUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(workerSecret ? { 'x-posthog-secret': workerSecret } : {}),
          },
          body: JSON.stringify({
            event: 'license_activation',
            distinct_id: 'direct-verification',
            properties: {
              tier: licenseData.tier,
              email: licenseData.email,
              event_type: 'verification',
              verification_code: code,
              server_version: PACKAGE_VERSION,
              os: platform(),
            },
          }),
        });
        logger.info(`[Setup] Verification email sent directly via Worker: ${licenseData.email}`);
      } catch (workerError) {
        logger.warn(`[Setup] Direct Worker call failed, falling back to PostHog pipeline: ${workerError instanceof Error ? workerError.message : String(workerError)}`);
      }

      // Also fire PostHog event for analytics (non-blocking, delay is fine)
      capturePostHogLicenseEvent({ ...licenseData, verificationCode: code, eventType: 'verification' }).catch(
        (err) => logger.debug(`[Setup] PostHog capture failed: ${err instanceof Error ? err.message : String(err)}`),
      );

      // Return success without exposing the code
      const { verificationCode: _c, verificationAttempts: _a, ...publicData } = licenseData;
      res.json({ success: true, license: publicData, verificationRequired: true });
    } catch (error) {
      logger.error('[Setup] Failed to save license', { error });
      res.status(500).json({ error: 'Failed to save license configuration' });
    }
  };

  const verifyRateLimiter = new SlidingWindowRateLimiter(5, 60_000); // 5 attempts/minute

  const verifyLicenseHandler = async (req: Request, res: Response): Promise<void> => {
    if (!verifyRateLimiter.tryAcquire()) {
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_EXCEEDED',
        severity: 'MEDIUM',
        source: 'setupRoutes.verifyLicenseHandler',
        details: 'Verification endpoint rate limit exceeded (5 req/min)',
      });
      res.status(429).json({ error: 'Too many verification attempts. Please try again in a minute.' });
      return;
    }

    const { code } = req.body ?? {};
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'Please enter a valid 6-digit verification code' });
      return;
    }

    const license = await readLicense();
    if (license.status !== 'pending') {
      res.status(400).json({ error: 'No pending license verification. Please submit the license form first.' });
      return;
    }

    // Check expiry
    if (!license.verificationExpiry || isCodeExpired(license.verificationExpiry as string)) {
      license.status = 'expired';
      await writeLicense(license);
      res.status(400).json({ error: 'Verification code has expired. Please submit the form again to receive a new code.' });
      return;
    }

    // Check max attempts
    const attempts = ((license.verificationAttempts as number) ?? 0) + 1;
    if (attempts > VERIFICATION_MAX_ATTEMPTS) {
      license.status = 'expired';
      await writeLicense(license);
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_EXCEEDED',
        severity: 'HIGH',
        source: 'setupRoutes.verifyLicenseHandler',
        details: `Verification max attempts exceeded for: ${license.email}`,
      });
      res.status(400).json({ error: 'Too many failed attempts. Please submit the form again to receive a new code.' });
      return;
    }

    // Validate code
    if (code !== license.verificationCode) {
      license.verificationAttempts = attempts;
      await writeLicense(license);
      const remaining = VERIFICATION_MAX_ATTEMPTS - attempts;
      res.status(400).json({ error: `Incorrect verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` });
      return;
    }

    // Code is correct — activate license
    const verifiedAt = new Date().toISOString();
    const requestedAt = license.verificationRequestedAt as string | undefined;
    const timeToVerifyMs = requestedAt ? Date.now() - new Date(requestedAt).getTime() : undefined;
    const attemptsUsed = ((license.verificationAttempts as number) ?? 0) + 1;

    license.status = 'active';
    license.verifiedAt = verifiedAt;
    delete license.verificationCode;
    delete license.verificationExpiry;
    delete license.verificationAttempts;
    delete license.verificationRequestedAt;
    await writeLicense(license);

    logger.info(`[Setup] License verified and activated: ${license.tier} (${license.email}) — ${timeToVerifyMs ? Math.round(timeToVerifyMs / 1000) + 's' : 'unknown'}, ${attemptsUsed} attempt(s)`);

    SecurityMonitor.logSecurityEvent({
      type: 'CONFIG_UPDATED',
      severity: 'LOW',
      source: 'setupRoutes.verifyLicenseHandler',
      details: `License activated after email verification: ${license.tier}`,
      additionalData: { tier: license.tier, email: license.email },
    });

    // Send confirmation email + PostHog activation event with analytics
    try {
      await capturePostHogLicenseEvent({
        ...license,
        eventType: 'activation',
        verification_time_ms: timeToVerifyMs,
        verification_attempts: attemptsUsed,
        verification_method: code.length === 6 ? 'code_or_click' : 'unknown',
      });
      logger.info(`[Setup] License activation event sent to PostHog: ${license.tier}`);
    } catch (posthogError) {
      logger.debug(`[Setup] PostHog capture failed: ${posthogError instanceof Error ? posthogError.message : String(posthogError)}`);
    }

    const { verificationCode: _c, verificationAttempts: _a, verificationExpiry: _e, ...publicLicense } = license;
    res.json({ success: true, license: publicLicense });
  };

  const resendRateLimiter = new SlidingWindowRateLimiter(3, 120_000); // 3 resends per 2 minutes

  const resendVerificationHandler = async (_req: Request, res: Response): Promise<void> => {
    if (!resendRateLimiter.tryAcquire()) {
      res.status(429).json({ error: 'Please wait before requesting another code.' });
      return;
    }

    const license = await readLicense();
    if (license.status !== 'pending' && license.status !== 'expired') {
      res.status(400).json({ error: 'No pending license verification.' });
      return;
    }

    // Generate new code and reset
    const code = generateVerificationCode();
    license.status = 'pending';
    license.verificationCode = code;
    license.verificationExpiry = new Date(Date.now() + VERIFICATION_CODE_TTL_MS).toISOString();
    license.verificationAttempts = 0;
    await writeLicense(license);

    // Send verification email directly to Worker for instant delivery
    try {
      const workerUrl = process.env.DOLLHOUSE_LICENSE_WORKER_URL || 'https://dollhousemcp-license-email.mick-eba.workers.dev';
      const workerSecret = process.env.DOLLHOUSE_LICENSE_WORKER_SECRET || '';
      await fetch(workerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(workerSecret ? { 'x-posthog-secret': workerSecret } : {}),
        },
        body: JSON.stringify({
          event: 'license_activation',
          distinct_id: 'direct-resend',
          properties: {
            tier: license.tier,
            email: license.email,
            event_type: 'verification',
            verification_code: code,
            server_version: PACKAGE_VERSION,
            os: platform(),
          },
        }),
      });
      logger.info(`[Setup] Verification code resent directly via Worker: ${license.email}`);
    } catch (workerError) {
      logger.warn(`[Setup] Direct Worker call failed: ${workerError instanceof Error ? workerError.message : String(workerError)}`);
    }

    res.json({ success: true, message: 'A new verification code has been sent to your email.' });
  };

  return { installHandler, openConfigHandler, versionHandler, mcpbRedirectHandler, detectHandler, getLicenseHandler, setLicenseHandler, verifyLicenseHandler, resendVerificationHandler };
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
