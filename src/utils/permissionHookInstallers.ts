import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  type InstallPermissionHookOptions,
  type InstallPermissionHookResult,
  detectIndent,
  ensureCommandHook,
  getClaudeHookSettingsPath,
  getCodexConfigPath,
  getCodexHookSettingsPath,
  getCursorHookSettingsPath,
  getGeminiHookSettingsPath,
  getHookWrapperBasename,
  normalizeHooksRoot,
  getVsCodeHookSettingsPath,
  getVsCodeUserSettingsPath,
  getWindsurfHookSettingsPath,
  installHookAssetsForHost,
  normalizeHookHost,
  readOptionalUtf8,
  writeHookMarker,
  writeBackupIfPresent,
} from './permissionHookShared.js';

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
