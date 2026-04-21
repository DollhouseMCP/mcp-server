import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { logger } from './logger.js';

export interface PermissionHookMarker {
  host: string;
  scriptPath: string;
  settingsPath?: string;
  additionalPaths?: string[];
  configured?: boolean;
  assetsPrepared?: boolean;
  installedAt: string;
}

export interface PermissionHookStatus {
  installed: boolean;
  configured?: boolean;
  assetsPrepared?: boolean;
  assetsCurrent?: boolean;
  autoRepaired?: boolean;
  needsRepair?: boolean;
  repairError?: string;
  host?: string;
  scriptPath?: string;
  settingsPath?: string;
  additionalPaths?: string[];
}

export interface InstallPermissionHookResult {
  supported: boolean;
  installed: boolean;
  configured: boolean;
  assetsPrepared?: boolean;
  host: string;
  scriptPath?: string;
  settingsPath?: string;
  additionalPaths?: string[];
  markerPath?: string;
  backupPath?: string;
  message: string;
}

export interface InstallPermissionHookOptions {
  homeDir?: string;
  sourceScriptPath?: string;
  now?: Date;
}

export interface ReconcilePermissionHookOptions {
  homeDir?: string;
  sourceScriptPath?: string;
  autoRepair?: boolean;
}

export interface PermissionHookAuditSummary {
  installedHosts: string[];
  currentHosts: string[];
  repairedHosts: string[];
  needsRepairHosts: string[];
  lastStartupRepair: PermissionHookStartupRepairSummary | null;
}

export interface PermissionHookStartupRepairHostResult extends PermissionHookStatus {
  host: string;
  outcome: 'current' | 'repaired' | 'needs_repair' | 'not_installed' | 'error';
}

export interface PermissionHookStartupRepairSummary {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  repairedCount: number;
  needsRepairCount: number;
  hostResults: PermissionHookStartupRepairHostResult[];
}

interface HookAssetDescriptor {
  kind: 'bridge' | 'port-helper' | 'wrapper';
  sourcePath: string;
  targetPath: string;
}

interface HookAssetAuditResult {
  assetsPrepared: boolean;
  assetsCurrent: boolean;
  staleAssets: HookAssetDescriptor[];
}

const MANAGED_HOOK_WRAPPER_BASENAMES = {
  'vscode': 'pretooluse-vscode.sh',
  'cursor': 'pretooluse-cursor.sh',
  'windsurf': 'pretooluse-windsurf.sh',
  'gemini-cli': 'pretooluse-gemini.sh',
  'codex': 'pretooluse-codex.sh',
} as const;

const WRAPPER_HOOK_HOSTS = Object.keys(MANAGED_HOOK_WRAPPER_BASENAMES) as Array<keyof typeof MANAGED_HOOK_WRAPPER_BASENAMES>;

const AUTO_REPAIRABLE_HOOK_HOSTS = ['claude-code', ...WRAPPER_HOOK_HOSTS] as const;

let lastPermissionHookStartupRepairSummary: PermissionHookStartupRepairSummary | null = null;

function repoRootFromModule(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return dirname(dirname(dirname(currentFile)));
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT',
  );
}

function detectIndent(raw: string): number | string {
  for (const line of raw.split('\n')) {
    if (line.length === 0 || line.startsWith('{') || line.startsWith('}')) continue;
    if (line.startsWith('\t')) return '\t';
    if (line.startsWith(' ')) {
      const spaces = line.length - line.trimStart().length;
      if (spaces >= 2) return spaces;
    }
  }
  return 2;
}

export function getPermissionHookScriptPath(homeDir = homedir()): string {
  return join(homeDir, '.dollhouse', 'hooks', 'pretooluse-dollhouse.sh');
}

function getPermissionHookRunDir(homeDir = homedir()): string {
  return join(homeDir, '.dollhouse', 'run');
}

function normalizeHookHost(host: string): string {
  return UnicodeValidator.normalize(host).normalizedContent.trim().toLowerCase();
}

function isHookMarkerFilename(entry: string): boolean {
  return entry.startsWith('hook-installed-') && entry.endsWith('.json');
}

function readHostSpecificHookStatus(homeDir: string, host: string): PermissionHookStatus {
  const normalized = normalizeHookHost(host);
  const status = readMarkerStatus(getPermissionHookMarkerPath(homeDir, normalized));
  if (status.installed || status.assetsPrepared) {
    return status;
  }
  if (normalized === 'claude-code') {
    return readMarkerStatus(getPermissionHookMarkerPath(homeDir));
  }
  return { installed: false };
}

function collectHookMarkerPaths(homeDir: string): Set<string> {
  const markerPaths = new Set<string>([getPermissionHookMarkerPath(homeDir)]);
  const runDir = getPermissionHookRunDir(homeDir);
  try {
    for (const entry of readdirSync(runDir)) {
      if (isHookMarkerFilename(entry)) {
        markerPaths.add(join(runDir, entry));
      }
    }
  } catch {
    // No run dir yet — fall through to default false.
  }
  return markerPaths;
}

async function collectHookMarkerPathsAsync(homeDir: string): Promise<Set<string>> {
  const markerPaths = new Set<string>([getPermissionHookMarkerPath(homeDir)]);
  const runDir = getPermissionHookRunDir(homeDir);
  try {
    for (const entry of await readdir(runDir)) {
      if (isHookMarkerFilename(entry)) {
        markerPaths.add(join(runDir, entry));
      }
    }
  } catch {
    // No run dir yet — fall through to default false.
  }
  return markerPaths;
}

function summarizeMarkerStatuses(markerPaths: Iterable<string>): PermissionHookStatus {
  let fallback: PermissionHookStatus = { installed: false };
  for (const markerPath of markerPaths) {
    const status = readMarkerStatus(markerPath);
    if (status.installed) return status;
    if (!fallback.assetsPrepared && status.assetsPrepared) fallback = status;
  }
  return fallback;
}

function getHookWrapperBasename(host: string): string | null {
  const normalizedHost = normalizeHookHost(host);
  return MANAGED_HOOK_WRAPPER_BASENAMES[normalizedHost as keyof typeof MANAGED_HOOK_WRAPPER_BASENAMES] ?? null;
}

function getHookWrapperPath(host: string, homeDir = homedir()): string | null {
  const basename = getHookWrapperBasename(host);
  return basename ? join(homeDir, '.dollhouse', 'hooks', basename) : null;
}

function getHookSourcePath(host: string): string {
  const root = repoRootFromModule();
  const basename = getHookWrapperBasename(host);
  return basename ? join(root, 'scripts', basename) : join(root, 'scripts', 'pretooluse-dollhouse.sh');
}

function supportsManagedHookAssets(host: string): boolean {
  const normalized = normalizeHookHost(host);
  return normalized === 'claude-code' || getHookWrapperBasename(normalized) !== null;
}

function getPrimaryHookScriptPath(host: string, homeDir = homedir()): string {
  return getHookWrapperPath(host, homeDir) ?? getPermissionHookScriptPath(homeDir);
}

function getManagedHookAssets(
  host: string,
  homeDir = homedir(),
  sourceScriptPath?: string,
): HookAssetDescriptor[] {
  const normalized = normalizeHookHost(host);
  const hooksDir = dirname(getPermissionHookScriptPath(homeDir));
  const assets: HookAssetDescriptor[] = [
    {
      kind: 'bridge',
      sourcePath: sourceScriptPath ?? join(repoRootFromModule(), 'scripts', 'pretooluse-dollhouse.sh'),
      targetPath: getPermissionHookScriptPath(homeDir),
    },
    {
      kind: 'port-helper',
      sourcePath: join(repoRootFromModule(), 'scripts', 'permission-port-discovery.sh'),
      targetPath: join(hooksDir, 'permission-port-discovery.sh'),
    },
  ];

  const wrapperTargetPath = getHookWrapperPath(normalized, homeDir);
  if (wrapperTargetPath) {
    assets.push({
      kind: 'wrapper',
      sourcePath: getHookSourcePath(normalized),
      targetPath: wrapperTargetPath,
    });
  }

  return assets;
}

async function readOptionalUtf8File(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function auditHookAssets(
  host: string,
  homeDir = homedir(),
  sourceScriptPath?: string,
): Promise<HookAssetAuditResult> {
  const assets = getManagedHookAssets(host, homeDir, sourceScriptPath);
  const staleAssets: HookAssetDescriptor[] = [];
  let assetsPrepared = true;

  for (const asset of assets) {
    const sourceRaw = await readFile(asset.sourcePath, 'utf-8');
    const targetRaw = await readOptionalUtf8File(asset.targetPath);
    if (targetRaw === undefined) {
      assetsPrepared = false;
      staleAssets.push(asset);
      continue;
    }
    if (targetRaw !== sourceRaw) {
      staleAssets.push(asset);
    }
  }

  return {
    assetsPrepared,
    assetsCurrent: staleAssets.length === 0,
    staleAssets,
  };
}

export function getPermissionHookMarkerPath(homeDir = homedir(), host?: string): string {
  if (!host) {
    return join(getPermissionHookRunDir(homeDir), 'hook-installed.json');
  }
  return join(getPermissionHookRunDir(homeDir), `hook-installed-${normalizeHookHost(host)}.json`);
}

export function getClaudeHookSettingsPath(homeDir = homedir()): string {
  return join(homeDir, '.claude', 'settings.json');
}

export function getVsCodeHookSettingsPath(homeDir = homedir()): string {
  return join(homeDir, '.copilot', 'hooks', 'dollhouse-permissions.json');
}

export function getVsCodeUserSettingsPath(homeDir = homedir()): string {
  const currentPlatform = platform();
  if (currentPlatform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }
  if (currentPlatform === 'win32') {
    const appData = process.env.APPDATA || join(homeDir, 'AppData', 'Roaming');
    return join(appData, 'Code', 'User', 'settings.json');
  }
  return join(homeDir, '.config', 'Code', 'User', 'settings.json');
}

export function getGeminiHookSettingsPath(homeDir = homedir()): string {
  return join(homeDir, '.gemini', 'settings.json');
}

export function getCursorHookSettingsPath(homeDir = homedir()): string {
  return join(homeDir, '.cursor', 'hooks.json');
}

export function getWindsurfHookSettingsPath(homeDir = homedir()): string {
  return join(homeDir, '.codeium', 'windsurf', 'hooks.json');
}

export function getCodexHookSettingsPath(homeDir = homedir()): string {
  return join(homeDir, '.codex', 'hooks.json');
}

export function getCodexConfigPath(homeDir = homedir()): string {
  return join(homeDir, '.codex', 'config.toml');
}

function toPermissionHookStatus(raw: PermissionHookMarker): PermissionHookStatus {
  if (
    typeof raw.host !== 'string' ||
    typeof raw.scriptPath !== 'string'
  ) {
    return { installed: false };
  }

  const scriptReady = existsSync(raw.scriptPath);
  const settingsReady = !raw.settingsPath || existsSync(raw.settingsPath);
  const additionalPathsReady = !raw.additionalPaths || raw.additionalPaths.every((path) => existsSync(path));
  const assetsPrepared = (raw.assetsPrepared ?? raw.configured ?? true) && scriptReady;
  const configured = (raw.configured ?? true) && scriptReady && settingsReady && additionalPathsReady;

  return {
    installed: configured,
    configured,
    assetsPrepared,
    host: raw.host,
    scriptPath: raw.scriptPath,
    settingsPath: raw.settingsPath,
    additionalPaths: raw.additionalPaths,
  };
}

function readMarkerStatus(markerPath: string): PermissionHookStatus {
  try {
    const raw = readFileSync(markerPath, 'utf-8');
    return toPermissionHookStatus(JSON.parse(raw) as PermissionHookMarker);
  } catch (error) {
    if (!isMissingFileError(error)) {
      logger.warn(`[Permissions] Failed to read hook marker at ${markerPath}: ${String(error)}`);
    }
    return { installed: false };
  }
}

export function getPermissionHookStatus(homeDir = homedir(), host?: string): PermissionHookStatus {
  if (host) {
    return readHostSpecificHookStatus(homeDir, host);
  }

  return summarizeMarkerStatuses(collectHookMarkerPaths(homeDir));
}

export async function getPermissionHookStatusAsync(homeDir = homedir(), host?: string): Promise<PermissionHookStatus> {
  if (host) {
    return readHostSpecificHookStatus(homeDir, host);
  }

  return summarizeMarkerStatuses(await collectHookMarkerPathsAsync(homeDir));
}

function shouldAttemptHookAssetRepair(
  status: PermissionHookStatus,
  audit: HookAssetAuditResult,
): boolean {
  return Boolean(
    status.installed
    || status.assetsPrepared
    || status.scriptPath
    || audit.assetsPrepared
    || audit.staleAssets.length > 0,
  );
}

function buildFallbackPermissionHookStatus(
  baseStatus: PermissionHookStatus,
  normalizedHost: string,
  homeDir: string,
): PermissionHookStatus {
  return {
    ...baseStatus,
    host: baseStatus.host ?? normalizedHost,
    scriptPath: baseStatus.scriptPath ?? getPrimaryHookScriptPath(normalizedHost, homeDir),
  };
}

async function auditAndMaybeRepairHookAssets(
  normalizedHost: string,
  homeDir: string,
  sourceScriptPath: string | undefined,
  autoRepair: boolean,
  fallbackStatus: PermissionHookStatus,
): Promise<{ audit: HookAssetAuditResult; autoRepaired: boolean }> {
  let audit = await auditHookAssets(normalizedHost, homeDir, sourceScriptPath);
  let autoRepaired = false;

  if (!audit.assetsCurrent && autoRepair && shouldAttemptHookAssetRepair(fallbackStatus, audit)) {
    await installHookAssetsForHost(normalizedHost, homeDir, sourceScriptPath);
    audit = await auditHookAssets(normalizedHost, homeDir, sourceScriptPath);
    autoRepaired = audit.assetsCurrent;
  }

  return { audit, autoRepaired };
}

function buildHookRepairFailureStatus(
  fallbackStatus: PermissionHookStatus,
  error: unknown,
): PermissionHookStatus {
  const message = error instanceof Error ? error.message : String(error);
  logger.warn(`[PermissionHooks] Failed to reconcile hook assets for ${fallbackStatus.host}: ${message}`);

  return {
    ...fallbackStatus,
    assetsCurrent: false,
    autoRepaired: false,
    needsRepair: true,
    repairError: message,
  };
}

function toStartupRepairOutcome(status: PermissionHookStatus): PermissionHookStartupRepairHostResult['outcome'] {
  if (status.repairError) return 'error';
  if (status.autoRepaired) return 'repaired';
  if (status.needsRepair && (status.installed || status.assetsPrepared)) return 'needs_repair';
  if (status.assetsCurrent) return 'current';
  return 'not_installed';
}

function toStartupRepairHostResult(
  host: string,
  status: PermissionHookStatus,
): PermissionHookStartupRepairHostResult {
  return {
    ...status,
    host,
    outcome: toStartupRepairOutcome(status),
  };
}

function cloneStartupRepairSummary(
  summary: PermissionHookStartupRepairSummary | null,
): PermissionHookStartupRepairSummary | null {
  if (!summary) return null;
  return {
    ...summary,
    hostResults: summary.hostResults.map((result) => ({ ...result })),
  };
}

export function getLastPermissionHookStartupRepairSummary(): PermissionHookStartupRepairSummary | null {
  return cloneStartupRepairSummary(lastPermissionHookStartupRepairSummary);
}

export function _resetPermissionHookStartupRepairSummaryForTests(): void {
  lastPermissionHookStartupRepairSummary = null;
}

export async function reconcilePermissionHookStatus(
  host: string,
  options: ReconcilePermissionHookOptions = {},
): Promise<PermissionHookStatus> {
  const normalizedHost = normalizeHookHost(host);
  const homeDir = options.homeDir ?? homedir();
  const sourceScriptPath = options.sourceScriptPath;
  const autoRepair = options.autoRepair ?? false;
  const baseStatus = readHostSpecificHookStatus(homeDir, normalizedHost);

  if (!supportsManagedHookAssets(normalizedHost)) {
    return baseStatus;
  }

  const fallbackStatus = buildFallbackPermissionHookStatus(baseStatus, normalizedHost, homeDir);

  try {
    const { audit, autoRepaired } = await auditAndMaybeRepairHookAssets(
      normalizedHost,
      homeDir,
      sourceScriptPath,
      autoRepair,
      fallbackStatus,
    );

    return {
      ...fallbackStatus,
      assetsPrepared: audit.assetsPrepared,
      assetsCurrent: audit.assetsCurrent,
      autoRepaired,
      needsRepair: !audit.assetsCurrent,
    };
  } catch (error) {
    return buildHookRepairFailureStatus(fallbackStatus, error);
  }
}

export async function getPermissionHookAuditSummary(homeDir = homedir()): Promise<PermissionHookAuditSummary> {
  const statuses = await Promise.all(
    AUTO_REPAIRABLE_HOOK_HOSTS.map(async (host) => ({
      host,
      status: await reconcilePermissionHookStatus(host, { homeDir }),
    })),
  );

  const installedHosts = statuses
    .filter(({ status }) => status.installed || status.assetsPrepared)
    .map(({ host }) => host);
  const currentHosts = statuses
    .filter(({ status }) => status.assetsCurrent)
    .map(({ host }) => host);
  const repairedHosts = statuses
    .filter(({ status }) => status.autoRepaired)
    .map(({ host }) => host);
  const needsRepairHosts = statuses
    .filter(({ status }) => status.needsRepair)
    .map(({ host }) => host);

  return {
    installedHosts,
    currentHosts,
    repairedHosts,
    needsRepairHosts,
    lastStartupRepair: getLastPermissionHookStartupRepairSummary(),
  };
}

export async function repairPermissionHooksOnStartup(
  homeDir = homedir(),
  sourceScriptPath?: string,
): Promise<PermissionHookStartupRepairSummary> {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const hostResults: PermissionHookStartupRepairHostResult[] = [];

  // Process sequentially because several hosts share the same bridge/helper
  // targets under ~/.dollhouse/hooks, and concurrent writes are flaky on Windows.
  for (const host of AUTO_REPAIRABLE_HOOK_HOSTS) {
    try {
      const status = await reconcilePermissionHookStatus(host, {
        homeDir,
        autoRepair: true,
        sourceScriptPath,
      });

      if (status.autoRepaired) {
        logger.info(`[PermissionHooks] Refreshed installed hook assets for ${host}`);
      } else if (status.needsRepair && status.installed) {
        logger.warn(
          `[PermissionHooks] Hook assets still need repair for ${host}` +
          (status.repairError ? `: ${status.repairError}` : ''),
        );
      }

      hostResults.push(toStartupRepairHostResult(host, status));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[PermissionHooks] Startup hook repair failed for ${host}: ${message}`);
      hostResults.push({
        host,
        installed: false,
        assetsPrepared: false,
        assetsCurrent: false,
        autoRepaired: false,
        needsRepair: true,
        repairError: message,
        outcome: 'error',
      } satisfies PermissionHookStartupRepairHostResult);
    }
  }
  const repairedCount = hostResults.filter((result) => result.outcome === 'repaired').length;
  const needsRepairCount = hostResults.filter((result) =>
    result.outcome === 'needs_repair' || result.outcome === 'error').length;
  const completedAt = Date.now();
  const summary: PermissionHookStartupRepairSummary = {
    startedAt: startedAtIso,
    completedAt: new Date(completedAt).toISOString(),
    durationMs: completedAt - startedAt,
    repairedCount,
    needsRepairCount,
    hostResults,
  };
  lastPermissionHookStartupRepairSummary = cloneStartupRepairSummary(summary);
  logger.info(
    `[PermissionHooks] Startup hook asset audit completed in ${summary.durationMs}ms ` +
    `(repaired=${repairedCount}, needsRepair=${needsRepairCount})`,
  );
  return summary;
}

function normalizeHooksRoot(parsed: Record<string, unknown>): Record<string, unknown[]> {
  const hooksValue = parsed.hooks;
  if (!hooksValue || typeof hooksValue !== 'object' || Array.isArray(hooksValue)) {
    parsed.hooks = {};
  }
  return parsed.hooks as Record<string, unknown[]>;
}

function ensureCommandHook(
  parsed: Record<string, unknown>,
  eventName: string,
  command: string,
  matcher: string,
  extraHookFields: Record<string, unknown> = {},
): { changed: boolean; parsed: Record<string, unknown> } {
  const hooksRoot = normalizeHooksRoot(parsed);
  const existingEntries: Array<Record<string, unknown>> = Array.isArray(hooksRoot[eventName])
    ? hooksRoot[eventName].filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    : [];
  hooksRoot[eventName] = existingEntries;

  const commandExists = existingEntries.some((entry) => {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks as Array<Record<string, unknown>> : [];
    return hooks.some((hook) => hook?.type === 'command' && hook?.command === command);
  });
  if (commandExists) {
    return { changed: false, parsed };
  }

  const wildcardEntry = existingEntries.find((entry): entry is Record<string, unknown> =>
    (entry?.matcher === matcher || entry?.matcher === undefined) && Array.isArray(entry?.hooks),
  );

  if (wildcardEntry) {
    const hooks = wildcardEntry.hooks as Array<Record<string, unknown>>;
    hooks.push({
      type: 'command',
      command,
      ...extraHookFields,
    });
  } else {
    existingEntries.push({
      matcher,
      hooks: [
        {
          type: 'command',
          command,
          ...extraHookFields,
        },
      ],
    });
  }

  return { changed: true, parsed };
}

export function ensureClaudePreToolUseHook(
  parsed: Record<string, unknown>,
  command: string,
): { changed: boolean; parsed: Record<string, unknown> } {
  return ensureCommandHook(parsed, 'PreToolUse', command, '*');
}

export function ensureVsCodePreToolUseHook(
  parsed: Record<string, unknown>,
  command: string,
): { changed: boolean; parsed: Record<string, unknown> } {
  return ensureCommandHook(parsed, 'PreToolUse', command, '*');
}

export function ensureGeminiBeforeToolHook(
  parsed: Record<string, unknown>,
  command: string,
): { changed: boolean; parsed: Record<string, unknown> } {
  return ensureCommandHook(parsed, 'BeforeTool', command, '.*');
}

export function ensureCodexPreToolUseHook(
  parsed: Record<string, unknown>,
  command: string,
): { changed: boolean; parsed: Record<string, unknown> } {
  return ensureCommandHook(parsed, 'PreToolUse', command, 'Bash', {
    statusMessage: 'Checking Bash permissions',
  });
}

export function ensureCursorPreToolUseHook(
  parsed: Record<string, unknown>,
  command: string,
): { changed: boolean; parsed: Record<string, unknown> } {
  if (parsed.version !== 1) {
    parsed.version = 1;
  }
  const hooksRoot = normalizeHooksRoot(parsed);
  const existingEntries: Array<Record<string, unknown>> = Array.isArray(hooksRoot.preToolUse)
    ? hooksRoot.preToolUse.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    : [];
  hooksRoot.preToolUse = existingEntries;

  const commandExists = existingEntries.some((entry) =>
    entry.command === command
    && (entry.type === 'command' || entry.type === undefined),
  );
  if (commandExists) {
    return { changed: false, parsed };
  }

  existingEntries.push({
    type: 'command',
    command,
    matcher: '.*',
  });

  return { changed: true, parsed };
}

export function ensureWindsurfHooks(
  parsed: Record<string, unknown>,
  command: string,
): { changed: boolean; parsed: Record<string, unknown> } {
  const hooksRoot = normalizeHooksRoot(parsed);
  let changed = false;

  const ensureEventHook = (eventName: string) => {
    const existingEntries: Array<Record<string, unknown>> = Array.isArray(hooksRoot[eventName])
      ? hooksRoot[eventName].filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      : [];
    hooksRoot[eventName] = existingEntries;

    const commandExists = existingEntries.some((entry) =>
      entry.command === command && (entry.type === 'command' || entry.type === undefined),
    );
    if (commandExists) {
      return;
    }

    existingEntries.push({
      type: 'command',
      command,
    });
    changed = true;
  };

  ensureEventHook('pre_run_command');
  ensureEventHook('pre_mcp_tool_use');

  return { changed, parsed };
}

async function copyHookAsset(sourcePath: string, targetPath: string): Promise<boolean> {
  await mkdir(dirname(targetPath), { recursive: true });

  const sourceRaw = await readFile(sourcePath, 'utf-8');

  let targetRaw: string | undefined;
  try {
    targetRaw = await readFile(targetPath, 'utf-8');
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  const changed = targetRaw === undefined || sourceRaw !== targetRaw;

  if (changed) {
    await copyFile(sourcePath, targetPath);
  } else {
    await access(targetPath);
  }

  await chmod(targetPath, 0o755);
  return changed;
}

async function readOptionalUtf8(filePath: string, fallback: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return fallback;
    }
    throw error;
  }
}

async function writeBackupIfPresent(filePath: string, raw: string): Promise<string | undefined> {
  if (!existsSync(filePath)) {
    return undefined;
  }

  const backupPath = `${filePath}.dollhouse.bak`;
  await writeFile(backupPath, raw, 'utf-8');
  return backupPath;
}

async function mergeClaudeSettings(settingsPath: string, command: string): Promise<{ changed: boolean; backupPath?: string }> {
  await mkdir(dirname(settingsPath), { recursive: true });

  const raw = await readOptionalUtf8(settingsPath, '{}\n');

  const indent = detectIndent(raw);
  const parsed = raw.trim().length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
  const { changed, parsed: updated } = ensureClaudePreToolUseHook(parsed, command);
  if (!changed) {
    return { changed: false };
  }

  const backupPath = await writeBackupIfPresent(settingsPath, raw);

  await writeFile(settingsPath, JSON.stringify(updated, null, indent) + '\n', 'utf-8');
  return { changed: true, backupPath };
}

async function mergeVsCodeHookSettings(settingsPath: string, command: string): Promise<{ changed: boolean; backupPath?: string }> {
  await mkdir(dirname(settingsPath), { recursive: true });

  const raw = await readOptionalUtf8(settingsPath, '{}\n');

  const indent = detectIndent(raw);
  const parsed = raw.trim().length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
  const { changed, parsed: updated } = ensureVsCodePreToolUseHook(parsed, command);
  if (!changed) {
    return { changed: false };
  }

  const backupPath = await writeBackupIfPresent(settingsPath, raw);

  await writeFile(settingsPath, JSON.stringify(updated, null, indent) + '\n', 'utf-8');
  return { changed: true, backupPath };
}

async function mergeVsCodeUserSettings(settingsPath: string): Promise<{ changed: boolean; backupPath?: string }> {
  await mkdir(dirname(settingsPath), { recursive: true });

  const raw = await readOptionalUtf8(settingsPath, '{}\n');
  const indent = detectIndent(raw);
  const parsed = raw.trim().length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
  const current = parsed['chat.hookFilesLocations'];
  const locations = (current && typeof current === 'object' && !Array.isArray(current))
    ? { ...(current as Record<string, unknown>) }
    : {};

  if (locations['~/.copilot/hooks'] === true) {
    return { changed: false };
  }

  locations['~/.copilot/hooks'] = true;
  parsed['chat.hookFilesLocations'] = locations;

  const backupPath = await writeBackupIfPresent(settingsPath, raw);
  await writeFile(settingsPath, JSON.stringify(parsed, null, indent) + '\n', 'utf-8');
  return { changed: true, backupPath };
}

async function mergeGeminiSettings(settingsPath: string, command: string): Promise<{ changed: boolean; backupPath?: string }> {
  await mkdir(dirname(settingsPath), { recursive: true });

  const raw = await readOptionalUtf8(settingsPath, '{}\n');

  const indent = detectIndent(raw);
  const parsed = raw.trim().length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
  const { changed, parsed: updated } = ensureGeminiBeforeToolHook(parsed, command);
  if (!changed) {
    return { changed: false };
  }

  const backupPath = await writeBackupIfPresent(settingsPath, raw);

  await writeFile(settingsPath, JSON.stringify(updated, null, indent) + '\n', 'utf-8');
  return { changed: true, backupPath };
}

async function mergeCursorHooks(settingsPath: string, command: string): Promise<{ changed: boolean; backupPath?: string }> {
  await mkdir(dirname(settingsPath), { recursive: true });

  const raw = await readOptionalUtf8(settingsPath, '{\n  "version": 1,\n  "hooks": {}\n}\n');

  const indent = detectIndent(raw);
  const parsed = raw.trim().length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
  const { changed, parsed: updated } = ensureCursorPreToolUseHook(parsed, command);
  if (!changed) {
    return { changed: false };
  }

  const backupPath = await writeBackupIfPresent(settingsPath, raw);

  await writeFile(settingsPath, JSON.stringify(updated, null, indent) + '\n', 'utf-8');
  return { changed: true, backupPath };
}

async function mergeWindsurfHooks(settingsPath: string, command: string): Promise<{ changed: boolean; backupPath?: string }> {
  await mkdir(dirname(settingsPath), { recursive: true });

  const raw = await readOptionalUtf8(settingsPath, '{\n  "hooks": {}\n}\n');

  const indent = detectIndent(raw);
  const parsed = raw.trim().length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
  const { changed, parsed: updated } = ensureWindsurfHooks(parsed, command);
  if (!changed) {
    return { changed: false };
  }

  const backupPath = await writeBackupIfPresent(settingsPath, raw);

  await writeFile(settingsPath, JSON.stringify(updated, null, indent) + '\n', 'utf-8');
  return { changed: true, backupPath };
}

async function mergeCodexHooks(hooksPath: string, command: string): Promise<{ changed: boolean; backupPath?: string }> {
  await mkdir(dirname(hooksPath), { recursive: true });

  const raw = await readOptionalUtf8(hooksPath, '{}\n');

  const indent = detectIndent(raw);
  const parsed = raw.trim().length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
  const { changed, parsed: updated } = ensureCodexPreToolUseHook(parsed, command);
  if (!changed) {
    return { changed: false };
  }

  const backupPath = await writeBackupIfPresent(hooksPath, raw);

  await writeFile(hooksPath, JSON.stringify(updated, null, indent) + '\n', 'utf-8');
  return { changed: true, backupPath };
}

function getTomlLineContent(line: string): string {
  const commentIndex = line.indexOf('#');
  return (commentIndex >= 0 ? line.slice(0, commentIndex) : line).trim();
}

function isTomlSectionLine(line: string, section: string): boolean {
  return getTomlLineContent(line) === `[${section}]`;
}

function parseTomlBooleanAssignment(line: string, key: string): boolean | null {
  const content = getTomlLineContent(line);
  if (!content.startsWith(`${key} = `)) {
    return null;
  }
  const value = content.slice(`${key} = `.length).trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function updateTomlBooleanAssignment(line: string, key: string, nextValue: boolean): string {
  const commentIndex = line.indexOf('#');
  const commentSuffix = commentIndex >= 0 ? line.slice(commentIndex) : '';
  let prefixLength = 0;
  while (prefixLength < line.length && /\s/.test(line.charAt(prefixLength))) {
    prefixLength += 1;
  }
  const prefix = line.slice(0, prefixLength);
  const assignment = `${prefix}${key} = ${nextValue ? 'true' : 'false'}`;
  const trimmedCommentSuffix = commentSuffix.trimStart();
  const suffix = trimmedCommentSuffix.length > 0 ? ` ${trimmedCommentSuffix}` : '';
  return `${assignment}${suffix}`.trimEnd();
}

function stripTrailingNewlines(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '\n') {
    end -= 1;
  }
  return value.slice(0, end);
}

function ensureCodexHooksEnabled(raw: string): { changed: boolean; content: string } {
  const lines = raw.length > 0 ? raw.split('\n') : [];
  const dottedIndex = lines.findIndex((line) => parseTomlBooleanAssignment(line, 'features.codex_hooks') !== null);
  if (dottedIndex >= 0) {
    if (parseTomlBooleanAssignment(lines[dottedIndex], 'features.codex_hooks') === true) {
      return { changed: false, content: raw };
    }
    const updatedLines = [...lines];
    updatedLines[dottedIndex] = updateTomlBooleanAssignment(updatedLines[dottedIndex], 'features.codex_hooks', true);
    return { changed: true, content: `${stripTrailingNewlines(updatedLines.join('\n'))}\n` };
  }

  const sectionIndex = lines.findIndex((line) => isTomlSectionLine(line, 'features'));
  if (sectionIndex >= 0) {
    const nextSectionIndex = lines.findIndex((line, index) => index > sectionIndex && getTomlLineContent(line).startsWith('[') && getTomlLineContent(line).endsWith(']'));
    const sectionEnd = nextSectionIndex >= 0 ? nextSectionIndex : lines.length;
    const keyIndex = lines.findIndex((line, index) => index > sectionIndex && index < sectionEnd && parseTomlBooleanAssignment(line, 'codex_hooks') !== null);

    if (keyIndex >= 0) {
      if (parseTomlBooleanAssignment(lines[keyIndex], 'codex_hooks') === true) {
        return { changed: false, content: raw };
      }
      const updatedLines = [...lines];
      updatedLines[keyIndex] = updateTomlBooleanAssignment(updatedLines[keyIndex], 'codex_hooks', true);
      return { changed: true, content: `${stripTrailingNewlines(updatedLines.join('\n'))}\n` };
    }

    const updatedLines = [...lines];
    updatedLines.splice(sectionIndex + 1, 0, 'codex_hooks = true');
    return { changed: true, content: `${stripTrailingNewlines(updatedLines.join('\n'))}\n` };
  }

  const prefix = raw.trim().length > 0 ? `${stripTrailingNewlines(raw)}\n\n` : '';
  return {
    changed: true,
    content: `${prefix}[features]\ncodex_hooks = true\n`,
  };
}

async function mergeCodexConfig(configPath: string): Promise<{ changed: boolean; backupPath?: string }> {
  await mkdir(dirname(configPath), { recursive: true });

  const raw = await readOptionalUtf8(configPath, '');

  const { changed, content } = ensureCodexHooksEnabled(raw);
  if (!changed) {
    return { changed: false };
  }

  const backupPath = await writeBackupIfPresent(configPath, raw);

  await writeFile(configPath, content, 'utf-8');
  return { changed: true, backupPath };
}

async function writeHookMarker(
  homeDir: string,
  marker: PermissionHookMarker,
): Promise<string> {
  const markerPath = getPermissionHookMarkerPath(homeDir, marker.host);
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf-8');
  return markerPath;
}

async function installHookAssetsForHost(
  client: string,
  homeDir: string,
  sourceScriptPath?: string,
): Promise<{ scriptPath: string }> {
  const normalizedClient = normalizeHookHost(client);
  const hooksDir = dirname(getPermissionHookScriptPath(homeDir));
  const sharedTargetPath = getPermissionHookScriptPath(homeDir);
  const sharedSourcePath = sourceScriptPath ?? join(repoRootFromModule(), 'scripts', 'pretooluse-dollhouse.sh');
  const portHelperSourcePath = join(repoRootFromModule(), 'scripts', 'permission-port-discovery.sh');
  const portHelperTargetPath = join(hooksDir, 'permission-port-discovery.sh');

  const sharedStat = statSync(sharedSourcePath);
  if (!sharedStat.isFile()) {
    logger.warn(`[PermissionHooks] Shared hook bridge missing for ${normalizedClient}: ${sharedSourcePath}`);
    throw new Error(`Permission hook source script not found: ${sharedSourcePath}`);
  }
  await copyHookAsset(sharedSourcePath, sharedTargetPath);

  const portHelperStat = statSync(portHelperSourcePath);
  if (!portHelperStat.isFile()) {
    logger.warn(`[PermissionHooks] Port discovery helper missing for ${normalizedClient}: ${portHelperSourcePath}`);
    throw new Error(`Permission hook helper script not found: ${portHelperSourcePath}`);
  }
  await copyHookAsset(portHelperSourcePath, portHelperTargetPath);

  const wrapperTargetPath = getHookWrapperPath(normalizedClient, homeDir);
  if (!wrapperTargetPath) {
    return { scriptPath: sharedTargetPath };
  }

  const wrapperSourcePath = getHookSourcePath(normalizedClient);
  const wrapperStat = statSync(wrapperSourcePath);
  if (!wrapperStat.isFile()) {
    logger.warn(`[PermissionHooks] Wrapper hook script missing for ${normalizedClient}: ${wrapperSourcePath}`);
    throw new Error(`Permission hook wrapper script not found: ${wrapperSourcePath}`);
  }
  await copyHookAsset(wrapperSourcePath, wrapperTargetPath);
  return { scriptPath: wrapperTargetPath };
}

async function installClaudeCodePermissionHook(
  homeDir: string,
  installedAt: string,
  sourceScriptPath?: string,
): Promise<InstallPermissionHookResult> {
  const host = 'claude-code';
  const { scriptPath } = await installHookAssetsForHost(host, homeDir, sourceScriptPath);
  const settingsPath = getClaudeHookSettingsPath(homeDir);
  const settingsResult = await mergeClaudeSettings(settingsPath, `bash ${scriptPath}`);
  const markerPath = await writeHookMarker(homeDir, {
    host,
    scriptPath,
    settingsPath,
    configured: true,
    assetsPrepared: true,
    installedAt,
  });

  return {
    supported: true,
    installed: true,
    configured: true,
    assetsPrepared: true,
    host,
    scriptPath,
    settingsPath,
    markerPath,
    backupPath: settingsResult.backupPath,
    message: 'Installed Claude Code permission hook and updated settings.json.',
  };
}

async function installVsCodePermissionHook(
  homeDir: string,
  installedAt: string,
  sourceScriptPath?: string,
): Promise<InstallPermissionHookResult> {
  const host = 'vscode';
  const { scriptPath } = await installHookAssetsForHost(host, homeDir, sourceScriptPath);
  const settingsPath = getVsCodeHookSettingsPath(homeDir);
  const userSettingsPath = getVsCodeUserSettingsPath(homeDir);
  const hookResult = await mergeVsCodeHookSettings(settingsPath, `bash ${scriptPath}`);
  const userSettingsResult = await mergeVsCodeUserSettings(userSettingsPath);
  const markerPath = await writeHookMarker(homeDir, {
    host,
    scriptPath,
    settingsPath,
    additionalPaths: [userSettingsPath],
    configured: true,
    assetsPrepared: true,
    installedAt,
  });

  return {
    supported: true,
    installed: true,
    configured: true,
    assetsPrepared: true,
    host,
    scriptPath,
    settingsPath,
    additionalPaths: [userSettingsPath],
    markerPath,
    backupPath: hookResult.backupPath ?? userSettingsResult.backupPath,
    message: 'Installed VS Code permission hook and enabled chat.hookFilesLocations for ~/.copilot/hooks.',
  };
}

async function installGeminiCliPermissionHook(
  homeDir: string,
  installedAt: string,
  sourceScriptPath?: string,
): Promise<InstallPermissionHookResult> {
  const host = 'gemini-cli';
  const { scriptPath } = await installHookAssetsForHost(host, homeDir, sourceScriptPath);
  const settingsPath = getGeminiHookSettingsPath(homeDir);
  const settingsResult = await mergeGeminiSettings(settingsPath, `bash ${scriptPath}`);
  const markerPath = await writeHookMarker(homeDir, {
    host,
    scriptPath,
    settingsPath,
    configured: true,
    assetsPrepared: true,
    installedAt,
  });

  return {
    supported: true,
    installed: true,
    configured: true,
    assetsPrepared: true,
    host,
    scriptPath,
    settingsPath,
    markerPath,
    backupPath: settingsResult.backupPath,
    message: 'Installed Gemini CLI permission hook and updated settings.json.',
  };
}

async function installCursorPermissionHook(
  homeDir: string,
  installedAt: string,
  sourceScriptPath?: string,
): Promise<InstallPermissionHookResult> {
  const host = 'cursor';
  const { scriptPath } = await installHookAssetsForHost(host, homeDir, sourceScriptPath);
  const settingsPath = getCursorHookSettingsPath(homeDir);
  const settingsResult = await mergeCursorHooks(settingsPath, `bash ${scriptPath}`);
  const markerPath = await writeHookMarker(homeDir, {
    host,
    scriptPath,
    settingsPath,
    configured: true,
    assetsPrepared: true,
    installedAt,
  });

  return {
    supported: true,
    installed: true,
    configured: true,
    assetsPrepared: true,
    host,
    scriptPath,
    settingsPath,
    markerPath,
    backupPath: settingsResult.backupPath,
    message: 'Installed Cursor permission hook and updated hooks.json.',
  };
}

async function installWindsurfPermissionHook(
  homeDir: string,
  installedAt: string,
  sourceScriptPath?: string,
): Promise<InstallPermissionHookResult> {
  const host = 'windsurf';
  const { scriptPath } = await installHookAssetsForHost(host, homeDir, sourceScriptPath);
  const settingsPath = getWindsurfHookSettingsPath(homeDir);
  const settingsResult = await mergeWindsurfHooks(settingsPath, `bash ${scriptPath}`);
  const markerPath = await writeHookMarker(homeDir, {
    host,
    scriptPath,
    settingsPath,
    configured: true,
    assetsPrepared: true,
    installedAt,
  });

  return {
    supported: true,
    installed: true,
    configured: true,
    assetsPrepared: true,
    host,
    scriptPath,
    settingsPath,
    markerPath,
    backupPath: settingsResult.backupPath,
    message: 'Installed Windsurf permission hooks and updated hooks.json.',
  };
}

async function installCodexPermissionHook(
  homeDir: string,
  installedAt: string,
  sourceScriptPath?: string,
): Promise<InstallPermissionHookResult> {
  const host = 'codex';
  const { scriptPath } = await installHookAssetsForHost(host, homeDir, sourceScriptPath);
  const settingsPath = getCodexHookSettingsPath(homeDir);
  const configPath = getCodexConfigPath(homeDir);
  const hooksResult = await mergeCodexHooks(settingsPath, `bash ${scriptPath}`);
  const configResult = await mergeCodexConfig(configPath);
  const markerPath = await writeHookMarker(homeDir, {
    host,
    scriptPath,
    settingsPath,
    additionalPaths: [configPath],
    configured: true,
    assetsPrepared: true,
    installedAt,
  });

  return {
    supported: true,
    installed: true,
    configured: true,
    assetsPrepared: true,
    host,
    scriptPath,
    settingsPath,
    additionalPaths: [configPath],
    markerPath,
    backupPath: hooksResult.backupPath ?? configResult.backupPath,
    message: 'Installed Codex Bash permission hook, created hooks.json, and enabled features.codex_hooks in config.toml.',
  };
}

async function installManualPermissionHookAssets(
  normalizedClient: string,
  homeDir: string,
  installedAt: string,
  sourceScriptPath?: string,
): Promise<InstallPermissionHookResult> {
  const { scriptPath } = await installHookAssetsForHost(normalizedClient, homeDir, sourceScriptPath);
  const markerPath = await writeHookMarker(homeDir, {
    host: normalizedClient,
    scriptPath,
    settingsPath: undefined,
    configured: false,
    assetsPrepared: true,
    installedAt,
  });

  return {
    supported: true,
    installed: true,
    configured: false,
    assetsPrepared: true,
    host: normalizedClient,
    scriptPath,
    markerPath,
    message: `Installed Dollhouse permission hook assets for ${normalizedClient}. Finish the client-specific hook registration manually.`,
  };
}

export async function installPermissionHook(
  client: string,
  options: InstallPermissionHookOptions = {},
): Promise<InstallPermissionHookResult> {
  const normalizedClient = normalizeHookHost(client);
  const homeDir = options.homeDir ?? homedir();
  const installedAt = (options.now ?? new Date()).toISOString();

  if (normalizedClient === 'claude-code') {
    return installClaudeCodePermissionHook(homeDir, installedAt, options.sourceScriptPath);
  }

  if (normalizedClient === 'vscode') {
    return installVsCodePermissionHook(homeDir, installedAt, options.sourceScriptPath);
  }

  if (normalizedClient === 'gemini-cli') {
    return installGeminiCliPermissionHook(homeDir, installedAt, options.sourceScriptPath);
  }

  if (normalizedClient === 'cursor') {
    return installCursorPermissionHook(homeDir, installedAt, options.sourceScriptPath);
  }

  if (normalizedClient === 'windsurf') {
    return installWindsurfPermissionHook(homeDir, installedAt, options.sourceScriptPath);
  }

  if (normalizedClient === 'codex') {
    return installCodexPermissionHook(homeDir, installedAt, options.sourceScriptPath);
  }

  if (getHookWrapperBasename(normalizedClient)) {
    return installManualPermissionHookAssets(normalizedClient, homeDir, installedAt, options.sourceScriptPath);
  }

  return {
    supported: false,
    installed: false,
    configured: false,
    host: normalizedClient,
    message: `Automatic permission hook wiring is not yet supported for ${normalizedClient}.`,
  };
}
