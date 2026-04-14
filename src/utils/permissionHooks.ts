import { accessSync, constants as fsConstants, copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

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
  return host.normalize('NFC').trim().toLowerCase();
}

function getHookWrapperBasename(host: string): string | null {
  switch (normalizeHookHost(host)) {
    case 'cursor':
      return 'pretooluse-cursor.sh';
    case 'windsurf':
      return 'pretooluse-windsurf.sh';
    case 'gemini-cli':
      return 'pretooluse-gemini.sh';
    case 'codex':
      return 'pretooluse-codex.sh';
    default:
      return null;
  }
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

export function getPermissionHookMarkerPath(homeDir = homedir(), host?: string): string {
  if (!host) {
    return join(getPermissionHookRunDir(homeDir), 'hook-installed.json');
  }
  return join(getPermissionHookRunDir(homeDir), `hook-installed-${normalizeHookHost(host)}.json`);
}

export function getClaudeHookSettingsPath(homeDir = homedir()): string {
  return join(homeDir, '.claude', 'settings.json');
}

export function getGeminiHookSettingsPath(homeDir = homedir()): string {
  return join(homeDir, '.gemini', 'settings.json');
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
  } catch {
    return { installed: false };
  }
}

export function getPermissionHookStatus(homeDir = homedir(), host?: string): PermissionHookStatus {
  if (host) {
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

  const runDir = getPermissionHookRunDir(homeDir);
  const markerPaths = new Set<string>([getPermissionHookMarkerPath(homeDir)]);
  try {
    for (const entry of readdirSync(runDir)) {
      if (entry.startsWith('hook-installed-') && entry.endsWith('.json')) {
        markerPaths.add(join(runDir, entry));
      }
    }
  } catch {
    // No run dir yet — fall through to default false.
  }

  let fallback: PermissionHookStatus = { installed: false };
  for (const markerPath of markerPaths) {
    const status = readMarkerStatus(markerPath);
    if (status.installed) return status;
    if (!fallback.assetsPrepared && status.assetsPrepared) fallback = status;
  }
  return fallback;
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
    copyFileSync(sourcePath, targetPath);
  } else {
    accessSync(targetPath, fsConstants.F_OK);
  }

  await chmod(targetPath, 0o755);
  return changed;
}

async function mergeClaudeSettings(settingsPath: string, command: string): Promise<{ changed: boolean; backupPath?: string }> {
  await mkdir(dirname(settingsPath), { recursive: true });

  let raw = '{}\n';
  try {
    raw = await readFile(settingsPath, 'utf-8');
  } catch {
    raw = '{}\n';
  }

  const indent = detectIndent(raw);
  const parsed = raw.trim().length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
  const { changed, parsed: updated } = ensureClaudePreToolUseHook(parsed, command);
  if (!changed) {
    return { changed: false };
  }

  let backupPath: string | undefined;
  if (existsSync(settingsPath)) {
    backupPath = `${settingsPath}.dollhouse.bak`;
    writeFileSync(backupPath, raw, 'utf-8');
  }

  await writeFile(settingsPath, JSON.stringify(updated, null, indent) + '\n', 'utf-8');
  return { changed: true, backupPath };
}

async function mergeGeminiSettings(settingsPath: string, command: string): Promise<{ changed: boolean; backupPath?: string }> {
  await mkdir(dirname(settingsPath), { recursive: true });

  let raw = '{}\n';
  try {
    raw = await readFile(settingsPath, 'utf-8');
  } catch {
    raw = '{}\n';
  }

  const indent = detectIndent(raw);
  const parsed = raw.trim().length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
  const { changed, parsed: updated } = ensureGeminiBeforeToolHook(parsed, command);
  if (!changed) {
    return { changed: false };
  }

  let backupPath: string | undefined;
  if (existsSync(settingsPath)) {
    backupPath = `${settingsPath}.dollhouse.bak`;
    writeFileSync(backupPath, raw, 'utf-8');
  }

  await writeFile(settingsPath, JSON.stringify(updated, null, indent) + '\n', 'utf-8');
  return { changed: true, backupPath };
}

async function mergeCodexHooks(hooksPath: string, command: string): Promise<{ changed: boolean; backupPath?: string }> {
  await mkdir(dirname(hooksPath), { recursive: true });

  let raw = '{}\n';
  try {
    raw = await readFile(hooksPath, 'utf-8');
  } catch {
    raw = '{}\n';
  }

  const indent = detectIndent(raw);
  const parsed = raw.trim().length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
  const { changed, parsed: updated } = ensureCodexPreToolUseHook(parsed, command);
  if (!changed) {
    return { changed: false };
  }

  let backupPath: string | undefined;
  if (existsSync(hooksPath)) {
    backupPath = `${hooksPath}.dollhouse.bak`;
    writeFileSync(backupPath, raw, 'utf-8');
  }

  await writeFile(hooksPath, JSON.stringify(updated, null, indent) + '\n', 'utf-8');
  return { changed: true, backupPath };
}

function ensureCodexHooksEnabled(raw: string): { changed: boolean; content: string } {
  const lines = raw.length > 0 ? raw.split('\n') : [];
  const dottedKeyPattern = /^\s*features\.codex_hooks\s*=\s*(true|false)(\s*(?:#.*)?)?$/;
  const dottedIndex = lines.findIndex((line) => dottedKeyPattern.test(line));
  if (dottedIndex >= 0) {
    if (/=\s*true\b/.test(lines[dottedIndex])) {
      return { changed: false, content: raw };
    }
    const updatedLines = [...lines];
    updatedLines[dottedIndex] = updatedLines[dottedIndex].replace(/=\s*false\b/, '= true');
    return { changed: true, content: `${updatedLines.join('\n').replace(/\n*$/, '')}\n` };
  }

  const sectionPattern = /^\[features\]\s*$/;
  const sectionIndex = lines.findIndex((line) => sectionPattern.test(line));
  if (sectionIndex >= 0) {
    const nextSectionIndex = lines.findIndex((line, index) => index > sectionIndex && /^\[[^\]]+\]\s*$/.test(line));
    const sectionEnd = nextSectionIndex >= 0 ? nextSectionIndex : lines.length;
    const keyPattern = /^\s*codex_hooks\s*=\s*(true|false)(\s*(?:#.*)?)?$/;
    const keyIndex = lines.findIndex((line, index) => index > sectionIndex && index < sectionEnd && keyPattern.test(line));

    if (keyIndex >= 0) {
      if (/=\s*true\b/.test(lines[keyIndex])) {
        return { changed: false, content: raw };
      }
      const updatedLines = [...lines];
      updatedLines[keyIndex] = updatedLines[keyIndex].replace(/=\s*false\b/, '= true');
      return { changed: true, content: `${updatedLines.join('\n').replace(/\n*$/, '')}\n` };
    }

    const updatedLines = [...lines];
    updatedLines.splice(sectionIndex + 1, 0, 'codex_hooks = true');
    return { changed: true, content: `${updatedLines.join('\n').replace(/\n*$/, '')}\n` };
  }

  const prefix = raw.trim().length > 0 ? `${raw.replace(/\n*$/, '')}\n\n` : '';
  return {
    changed: true,
    content: `${prefix}[features]\ncodex_hooks = true\n`,
  };
}

async function mergeCodexConfig(configPath: string): Promise<{ changed: boolean; backupPath?: string }> {
  await mkdir(dirname(configPath), { recursive: true });

  let raw = '';
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch {
    raw = '';
  }

  const { changed, content } = ensureCodexHooksEnabled(raw);
  if (!changed) {
    return { changed: false };
  }

  let backupPath: string | undefined;
  if (existsSync(configPath)) {
    backupPath = `${configPath}.dollhouse.bak`;
    writeFileSync(backupPath, raw, 'utf-8');
  }

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
  const sharedTargetPath = getPermissionHookScriptPath(homeDir);
  const sharedSourcePath = sourceScriptPath ?? join(repoRootFromModule(), 'scripts', 'pretooluse-dollhouse.sh');

  const sharedStat = statSync(sharedSourcePath);
  if (!sharedStat.isFile()) {
    throw new Error(`Permission hook source script not found: ${sharedSourcePath}`);
  }
  await copyHookAsset(sharedSourcePath, sharedTargetPath);

  const wrapperTargetPath = getHookWrapperPath(normalizedClient, homeDir);
  if (!wrapperTargetPath) {
    return { scriptPath: sharedTargetPath };
  }

  const wrapperSourcePath = getHookSourcePath(normalizedClient);
  const wrapperStat = statSync(wrapperSourcePath);
  if (!wrapperStat.isFile()) {
    throw new Error(`Permission hook wrapper script not found: ${wrapperSourcePath}`);
  }
  await copyHookAsset(wrapperSourcePath, wrapperTargetPath);
  return { scriptPath: wrapperTargetPath };
}

export async function installPermissionHook(
  client: string,
  options: InstallPermissionHookOptions = {},
): Promise<InstallPermissionHookResult> {
  const normalizedClient = client.normalize('NFC').trim().toLowerCase();
  const homeDir = options.homeDir ?? homedir();
  const installedAt = (options.now ?? new Date()).toISOString();

  if (normalizedClient === 'claude-code') {
    const { scriptPath } = await installHookAssetsForHost(normalizedClient, homeDir, options.sourceScriptPath);
    const settingsPath = getClaudeHookSettingsPath(homeDir);
    const settingsResult = await mergeClaudeSettings(settingsPath, `bash ${scriptPath}`);
    const markerPath = await writeHookMarker(homeDir, {
      host: normalizedClient,
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
      host: normalizedClient,
      scriptPath,
      settingsPath,
      markerPath,
      backupPath: settingsResult.backupPath,
      message: 'Installed Claude Code permission hook and updated settings.json.',
    };
  }

  if (normalizedClient === 'gemini-cli') {
    const { scriptPath } = await installHookAssetsForHost(normalizedClient, homeDir, options.sourceScriptPath);
    const settingsPath = getGeminiHookSettingsPath(homeDir);
    const settingsResult = await mergeGeminiSettings(settingsPath, `bash ${scriptPath}`);
    const markerPath = await writeHookMarker(homeDir, {
      host: normalizedClient,
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
      host: normalizedClient,
      scriptPath,
      settingsPath,
      markerPath,
      backupPath: settingsResult.backupPath,
      message: 'Installed Gemini CLI permission hook and updated settings.json.',
    };
  }

  if (normalizedClient === 'codex') {
    const { scriptPath } = await installHookAssetsForHost(normalizedClient, homeDir, options.sourceScriptPath);
    const settingsPath = getCodexHookSettingsPath(homeDir);
    const configPath = getCodexConfigPath(homeDir);
    const hooksResult = await mergeCodexHooks(settingsPath, `bash ${scriptPath}`);
    const configResult = await mergeCodexConfig(configPath);
    const markerPath = await writeHookMarker(homeDir, {
      host: normalizedClient,
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
      host: normalizedClient,
      scriptPath,
      settingsPath,
      additionalPaths: [configPath],
      markerPath,
      backupPath: hooksResult.backupPath ?? configResult.backupPath,
      message: 'Installed Codex Bash permission hook, created hooks.json, and enabled features.codex_hooks in config.toml.',
    };
  }

  if (getHookWrapperBasename(normalizedClient)) {
    const { scriptPath } = await installHookAssetsForHost(normalizedClient, homeDir, options.sourceScriptPath);
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

  return {
    supported: false,
    installed: false,
    configured: false,
    host: normalizedClient,
    message: `Automatic permission hook wiring is not yet supported for ${normalizedClient}.`,
  };
}
