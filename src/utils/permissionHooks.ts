import { accessSync, copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export interface PermissionHookMarker {
  host: string;
  scriptPath: string;
  settingsPath: string;
  installedAt: string;
}

export interface PermissionHookStatus {
  installed: boolean;
  host?: string;
  scriptPath?: string;
  settingsPath?: string;
}

export interface InstallPermissionHookResult {
  supported: boolean;
  installed: boolean;
  configured: boolean;
  host: string;
  scriptPath?: string;
  settingsPath?: string;
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

export function getPermissionHookMarkerPath(homeDir = homedir()): string {
  return join(homeDir, '.dollhouse', 'run', 'hook-installed.json');
}

export function getClaudeHookSettingsPath(homeDir = homedir()): string {
  return join(homeDir, '.claude', 'settings.json');
}

export function getPermissionHookStatus(homeDir = homedir()): PermissionHookStatus {
  const markerPath = getPermissionHookMarkerPath(homeDir);
  try {
    const raw = readFileSync(markerPath, 'utf-8');
    const parsed = JSON.parse(raw) as PermissionHookMarker;
    if (
      typeof parsed.host !== 'string' ||
      typeof parsed.scriptPath !== 'string' ||
      typeof parsed.settingsPath !== 'string'
    ) {
      return { installed: false };
    }

    if (!existsSync(parsed.scriptPath) || !existsSync(parsed.settingsPath)) {
      return { installed: false };
    }

    return {
      installed: true,
      host: parsed.host,
      scriptPath: parsed.scriptPath,
      settingsPath: parsed.settingsPath,
    };
  } catch {
    return { installed: false };
  }
}

function normalizeHooksRoot(parsed: Record<string, unknown>): Record<string, unknown[]> {
  const hooksValue = parsed.hooks;
  if (!hooksValue || typeof hooksValue !== 'object' || Array.isArray(hooksValue)) {
    parsed.hooks = {};
  }
  return parsed.hooks as Record<string, unknown[]>;
}

export function ensureClaudePreToolUseHook(
  parsed: Record<string, unknown>,
  command: string,
): { changed: boolean; parsed: Record<string, unknown> } {
  const hooksRoot = normalizeHooksRoot(parsed);
  const existingEntries = Array.isArray(hooksRoot.PreToolUse) ? hooksRoot.PreToolUse as Array<Record<string, unknown>> : [];
  hooksRoot.PreToolUse = existingEntries;

  const commandExists = existingEntries.some((entry) => {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks as Array<Record<string, unknown>> : [];
    return hooks.some((hook) => hook?.type === 'command' && hook?.command === command);
  });
  if (commandExists) {
    return { changed: false, parsed };
  }

  const wildcardEntry = existingEntries.find((entry) =>
    (entry?.matcher === '*' || entry?.matcher === undefined) && Array.isArray(entry?.hooks),
  ) as Record<string, unknown> | undefined;

  if (wildcardEntry) {
    const hooks = wildcardEntry.hooks as Array<Record<string, unknown>>;
    hooks.push({
      type: 'command',
      command,
    });
  } else {
    existingEntries.push({
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command,
        },
      ],
    });
  }

  return { changed: true, parsed };
}

async function copyHookScript(sourcePath: string, targetPath: string): Promise<boolean> {
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

export async function installPermissionHook(
  client: string,
  options: InstallPermissionHookOptions = {},
): Promise<InstallPermissionHookResult> {
  const normalizedClient = client.normalize('NFC').trim().toLowerCase();
  if (normalizedClient !== 'claude-code') {
    return {
      supported: false,
      installed: false,
      configured: false,
      host: normalizedClient,
      message: `Automatic permission hook wiring is not yet supported for ${normalizedClient}.`,
    };
  }

  const homeDir = options.homeDir ?? homedir();
  const sourceScriptPath = options.sourceScriptPath
    ?? join(repoRootFromModule(), 'scripts', 'pretooluse-dollhouse.sh');
  const targetScriptPath = getPermissionHookScriptPath(homeDir);
  const settingsPath = getClaudeHookSettingsPath(homeDir);
  const markerPath = getPermissionHookMarkerPath(homeDir);
  const command = `bash ${targetScriptPath}`;

  const sourceStat = statSync(sourceScriptPath);
  if (!sourceStat.isFile()) {
    throw new Error(`Permission hook source script not found: ${sourceScriptPath}`);
  }

  await copyHookScript(sourceScriptPath, targetScriptPath);
  const settingsResult = await mergeClaudeSettings(settingsPath, command);

  await mkdir(dirname(markerPath), { recursive: true });
  const installedAt = (options.now ?? new Date()).toISOString();
  const marker: PermissionHookMarker = {
    host: normalizedClient,
    scriptPath: targetScriptPath,
    settingsPath,
    installedAt,
  };
  await writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf-8');

  return {
    supported: true,
    installed: true,
    configured: true,
    host: normalizedClient,
    scriptPath: targetScriptPath,
    settingsPath,
    markerPath,
    backupPath: settingsResult.backupPath,
    message: 'Installed Claude Code permission hook and updated settings.json.',
  };
}
