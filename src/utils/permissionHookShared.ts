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

/** Latest JSONL diagnostic event emitted by a local permission hook wrapper. */
export interface PermissionHookDiagnosticRecord {
  timestamp: string;
  invocationId: string;
  event: string;
  platform: string;
  stage: string;
  outcome?: string;
  reason?: string;
  hookPath?: string;
  diagnosticsLogPath?: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: string;
  rawInput?: string;
  authorityHost?: string;
  authorityMode?: string;
  endpoint?: string;
  port?: string;
  payload?: string;
  response?: string;
  normalizedResponse?: string;
  emittedResponse?: string;
  attempt?: string;
  maxRetries?: string;
  timeoutSeconds?: string;
  curlExit?: string;
  rawInputLength?: number;
  normalizedResponseLength?: number;
  emittedResponseLength?: number;
  responseLength?: number;
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

/** Aggregate health and repair state for all managed local hook hosts. */
export interface PermissionHookAuditSummary {
  installedHosts: string[];
  currentHosts: string[];
  repairedHosts: string[];
  needsRepairHosts: string[];
  diagnosticsPath: string;
  lastDiagnostic: PermissionHookDiagnosticRecord | null;
  lastStartupRepair: PermissionHookStartupRepairSummary | null;
}

/** Condensed health view surfaced in setup, permissions, and build info. */
export interface PermissionHookHealthSummary {
  status: 'ok' | 'warning' | 'error';
  message: string;
  repairedCount: number;
  needsRepairCount: number;
  lastCheckedAt?: string;
}

export interface PermissionHookStartupRepairHostResult extends PermissionHookStatus {
  host: string;
  outcome: 'current' | 'repaired' | 'needs_repair' | 'not_installed' | 'error';
}

/** Result summary for the most recent startup-time hook asset repair pass. */
export interface PermissionHookStartupRepairSummary {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  repairedCount: number;
  needsRepairCount: number;
  hostResults: PermissionHookStartupRepairHostResult[];
}

export interface HookAssetDescriptor {
  kind: 'bridge' | 'port-helper' | 'config-helper' | 'wrapper';
  sourcePath: string;
  targetPath: string;
}

export interface HookAssetAuditResult {
  assetsPrepared: boolean;
  assetsCurrent: boolean;
  staleAssets: HookAssetDescriptor[];
}

export const MANAGED_HOOK_WRAPPER_BASENAMES = {
  'vscode': 'pretooluse-vscode.sh',
  'cursor': 'pretooluse-cursor.sh',
  'windsurf': 'pretooluse-windsurf.sh',
  'gemini-cli': 'pretooluse-gemini.sh',
  'codex': 'pretooluse-codex.sh',
} as const;

export const WRAPPER_HOOK_HOSTS = Object.keys(MANAGED_HOOK_WRAPPER_BASENAMES) as Array<keyof typeof MANAGED_HOOK_WRAPPER_BASENAMES>;

export const AUTO_REPAIRABLE_HOOK_HOSTS = ['claude-code', ...WRAPPER_HOOK_HOSTS] as const;

function repoRootFromModule(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return dirname(dirname(dirname(currentFile)));
}

export function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT',
  );
}

export function detectIndent(raw: string): number | string {
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

export function getPermissionHookDiagnosticsPath(homeDir = homedir()): string {
  return join(getPermissionHookRunDir(homeDir), 'permission-hook-diagnostics.jsonl');
}

export function normalizeHookHost(host: string): string {
  return UnicodeValidator.normalize(host).normalizedContent.trim().toLowerCase();
}

function isHookMarkerFilename(entry: string): boolean {
  return entry.startsWith('hook-installed-') && entry.endsWith('.json');
}

export function readHostSpecificHookStatus(homeDir: string, host: string): PermissionHookStatus {
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

export function collectHookMarkerPaths(homeDir: string): Set<string> {
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

export async function collectHookMarkerPathsAsync(homeDir: string): Promise<Set<string>> {
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

export function summarizeMarkerStatuses(markerPaths: Iterable<string>): PermissionHookStatus {
  let fallback: PermissionHookStatus = { installed: false };
  for (const markerPath of markerPaths) {
    const status = readMarkerStatus(markerPath);
    if (status.installed) return status;
    if (!fallback.assetsPrepared && status.assetsPrepared) fallback = status;
  }
  return fallback;
}

export function getHookWrapperBasename(host: string): string | null {
  const normalizedHost = normalizeHookHost(host);
  return MANAGED_HOOK_WRAPPER_BASENAMES[normalizedHost as keyof typeof MANAGED_HOOK_WRAPPER_BASENAMES] ?? null;
}

export function getHookWrapperPath(host: string, homeDir = homedir()): string | null {
  const basename = getHookWrapperBasename(host);
  return basename ? join(homeDir, '.dollhouse', 'hooks', basename) : null;
}

export function getHookSourcePath(host: string): string {
  const root = repoRootFromModule();
  const basename = getHookWrapperBasename(host);
  return basename ? join(root, 'scripts', basename) : join(root, 'scripts', 'pretooluse-dollhouse.sh');
}

export function supportsManagedHookAssets(host: string): boolean {
  const normalized = normalizeHookHost(host);
  return normalized === 'claude-code' || getHookWrapperBasename(normalized) !== null;
}

export function getPrimaryHookScriptPath(host: string, homeDir = homedir()): string {
  return getHookWrapperPath(host, homeDir) ?? getPermissionHookScriptPath(homeDir);
}

export async function readLastPermissionHookDiagnostic(
  homeDir = homedir(),
): Promise<PermissionHookDiagnosticRecord | null> {
  const diagnosticsPath = getPermissionHookDiagnosticsPath(homeDir);

  try {
    const raw = await readFile(diagnosticsPath, 'utf-8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const lastLine = lines.at(-1);
    if (!lastLine) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(lastLine) as unknown;
    } catch (error) {
      logger.warn(
        `[PermissionHooks] Failed to parse hook diagnostics JSON from ${diagnosticsPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn(
        `[PermissionHooks] Ignoring malformed hook diagnostics entry from ${diagnosticsPath}: expected JSON object.`,
      );
      return null;
    }

    return parsed as PermissionHookDiagnosticRecord;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    logger.warn(
      `[PermissionHooks] Failed to read hook diagnostics from ${diagnosticsPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export function getManagedHookAssets(
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
    {
      kind: 'config-helper',
      sourcePath: join(repoRootFromModule(), 'scripts', 'permission-hook-config.sh'),
      targetPath: join(hooksDir, 'permission-hook-config.sh'),
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

export async function auditHookAssets(
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

export function normalizeHooksRoot(parsed: Record<string, unknown>): Record<string, unknown[]> {
  const hooksValue = parsed.hooks;
  if (!hooksValue || typeof hooksValue !== 'object' || Array.isArray(hooksValue)) {
    parsed.hooks = {};
  }
  return parsed.hooks as Record<string, unknown[]>;
}

export function ensureCommandHook(
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

export async function readOptionalUtf8(filePath: string, fallback: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return fallback;
    }
    throw error;
  }
}

export async function writeBackupIfPresent(filePath: string, raw: string): Promise<string | undefined> {
  if (!existsSync(filePath)) {
    return undefined;
  }

  const backupPath = `${filePath}.dollhouse.bak`;
  await writeFile(backupPath, raw, 'utf-8');
  return backupPath;
}

export async function writeHookMarker(
  homeDir: string,
  marker: PermissionHookMarker,
): Promise<string> {
  const markerPath = getPermissionHookMarkerPath(homeDir, marker.host);
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf-8');
  return markerPath;
}

export async function installHookAssetsForHost(
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
  const configHelperSourcePath = join(repoRootFromModule(), 'scripts', 'permission-hook-config.sh');
  const configHelperTargetPath = join(hooksDir, 'permission-hook-config.sh');

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

  const configHelperStat = statSync(configHelperSourcePath);
  if (!configHelperStat.isFile()) {
    logger.warn(`[PermissionHooks] Config helper missing for ${normalizedClient}: ${configHelperSourcePath}`);
    throw new Error(`Permission hook config helper not found: ${configHelperSourcePath}`);
  }
  await copyHookAsset(configHelperSourcePath, configHelperTargetPath);

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
