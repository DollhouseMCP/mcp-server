import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { logger } from './logger.js';
import { getClaudeHookSettingsPath } from './permissionHooks.js';

// These modes intentionally describe who has the final say when Dollhouse and the host disagree:
// - off: the host permission system is fully in charge
// - shared: both systems participate, but the host can still be stricter
// - authoritative: Dollhouse is the source of truth for the managed host slice
export const PERMISSION_AUTHORITY_MODES = ['off', 'shared', 'authoritative'] as const;
export type PermissionAuthorityMode = typeof PERMISSION_AUTHORITY_MODES[number];

export const PERMISSION_AUTHORITY_HOSTS = [
  'claude-code',
  'codex',
  'cursor',
  'vscode',
  'windsurf',
  'gemini-cli',
] as const;
export type PermissionAuthorityHost = typeof PERMISSION_AUTHORITY_HOSTS[number];

export interface PermissionAuthorityHostState {
  mode: PermissionAuthorityMode;
  reason?: string;
  updatedAt: string;
  backupPath?: string;
  lastSyncedAt?: string;
  scope?: 'user';
}

export interface PermissionAuthorityState {
  version: 1;
  defaultMode: PermissionAuthorityMode;
  updatedAt: string;
  hosts: Partial<Record<PermissionAuthorityHost, PermissionAuthorityHostState>>;
}

export interface AuthorityPolicySnapshot {
  combinedAllowPatterns?: string[];
  combinedConfirmPatterns?: string[];
  combinedDenyPatterns?: string[];
}

interface PermissionAuthorityMetadata {
  version: 1;
  host: PermissionAuthorityHost;
  managedPermissions: {
    allow: string[];
    ask: string[];
    deny: string[];
  };
  syncedAt: string;
}

interface PermissionAuthorityBackup {
  version: 1;
  existed: boolean;
  raw?: string;
}

export interface SetPermissionAuthorityModeInput {
  host: PermissionAuthorityHost;
  mode: PermissionAuthorityMode;
  reason?: string;
  policies?: AuthorityPolicySnapshot;
  homeDir?: string;
  now?: Date;
}

export function getPermissionAuthorityStatePath(homeDir = homedir()): string {
  return join(homeDir, '.dollhouse', 'run', 'permission-authority.json');
}

function getPermissionAuthorityBackupDir(homeDir = homedir()): string {
  return join(homeDir, '.dollhouse', 'run', 'permission-authority-backups');
}

export function getDefaultPermissionAuthorityState(now = new Date()): PermissionAuthorityState {
  return {
    version: 1,
    defaultMode: 'shared',
    updatedAt: now.toISOString(),
    hosts: {},
  };
}

export async function readPermissionAuthorityState(homeDir = homedir()): Promise<PermissionAuthorityState> {
  const statePath = getPermissionAuthorityStatePath(homeDir);
  try {
    const raw = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PermissionAuthorityState>;
    return {
      version: 1,
      defaultMode: isPermissionAuthorityMode(parsed.defaultMode) ? parsed.defaultMode : 'shared',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      hosts: normalizeHostStateMap(parsed.hosts),
    };
  } catch (error) {
    if (!isMissingFileError(error)) {
      logger.warn(`[PermissionAuthority] Failed to read ${statePath}: ${String(error)}`);
    }
    return getDefaultPermissionAuthorityState();
  }
}

export async function writePermissionAuthorityState(
  state: PermissionAuthorityState,
  homeDir = homedir(),
): Promise<void> {
  const statePath = getPermissionAuthorityStatePath(homeDir);
  await mkdir(dirname(statePath), { recursive: true });
  await writeTextFileAtomically(statePath, JSON.stringify(state, null, 2) + '\n');
}

export function getHostAuthorityMode(
  state: PermissionAuthorityState,
  host: PermissionAuthorityHost,
): PermissionAuthorityMode {
  return state.hosts[host]?.mode ?? state.defaultMode;
}

export async function setPermissionAuthorityMode(input: SetPermissionAuthorityModeInput): Promise<PermissionAuthorityState> {
  const homeDir = input.homeDir ?? homedir();
  const now = input.now ?? new Date();
  const state = await readPermissionAuthorityState(homeDir);
  const normalizedHost = normalizeAuthorityHostInput(input.host);
  const normalizedMode = normalizeAuthorityModeInput(input.mode);
  const normalizedReason = normalizeAuthorityReason(input.reason);
  const previousHostState = state.hosts[normalizedHost];
  const previousMode = previousHostState?.mode ?? state.defaultMode;
  try {
    if (normalizedMode === 'authoritative') {
      if (normalizedHost !== 'claude-code') {
        throw new Error(`Authoritative mode is not implemented yet for ${normalizedHost}.`);
      }
      if (!input.policies) {
        throw new Error('Authoritative mode requires a policy snapshot.');
      }

      const syncResult = await syncClaudeCodeAuthoritativeMode({
        homeDir,
        host: normalizedHost,
        previousBackupPath: previousHostState?.backupPath,
        policies: input.policies,
        now,
      });

      state.hosts[normalizedHost] = {
        mode: 'authoritative',
        reason: normalizedReason,
        updatedAt: now.toISOString(),
        backupPath: syncResult.backupPath,
        lastSyncedAt: syncResult.syncedAt,
        scope: 'user',
      };
    } else {
      if (previousMode === 'authoritative' && previousHostState?.backupPath) {
        await restoreAuthorityBackup(previousHostState.backupPath, getHostSettingsPath(normalizedHost, homeDir));
      }

      state.hosts[normalizedHost] = {
        mode: normalizedMode,
        reason: normalizedReason,
        updatedAt: now.toISOString(),
        scope: 'user',
      };
    }

    state.updatedAt = now.toISOString();
    await writePermissionAuthorityState(state, homeDir);

    SecurityMonitor.logSecurityEvent({
      type: 'CONFIG_UPDATED',
      severity: 'LOW',
      source: 'permissionAuthority.setPermissionAuthorityMode',
      details: `Permission authority for ${normalizedHost} changed from ${previousMode} to ${normalizedMode}`,
      additionalData: {
        host: normalizedHost,
        previousMode,
        mode: normalizedMode,
        reason: normalizedReason,
      },
    });

    return state;
  } catch (error) {
    throw withAuthorityContext(error, `Failed to set permission authority for ${normalizedHost} to ${normalizedMode}`);
  }
}

function normalizeAuthorityText(value: string): string {
  return UnicodeValidator.normalize(value).normalizedContent.trim();
}

function normalizeAuthorityHostInput(value: PermissionAuthorityHost): PermissionAuthorityHost {
  const normalized = normalizeAuthorityText(value).toLowerCase();
  if (!isPermissionAuthorityHost(normalized)) {
    throw new Error(`Unsupported permission authority host: ${value}`);
  }
  return normalized;
}

function normalizeAuthorityModeInput(value: PermissionAuthorityMode): PermissionAuthorityMode {
  const normalized = normalizeAuthorityText(value).toLowerCase();
  if (!isPermissionAuthorityMode(normalized)) {
    throw new Error(`Unsupported permission authority mode: ${value}`);
  }
  return normalized;
}

function normalizeAuthorityReason(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = normalizeAuthorityText(value);
  return normalized === '' ? undefined : normalized;
}

function normalizeHostStateMap(
  rawHosts: unknown,
): Partial<Record<PermissionAuthorityHost, PermissionAuthorityHostState>> {
  if (!rawHosts || typeof rawHosts !== 'object' || Array.isArray(rawHosts)) {
    return {};
  }

  const normalized: Partial<Record<PermissionAuthorityHost, PermissionAuthorityHostState>> = {};
  for (const [rawHost, rawState] of Object.entries(rawHosts as Record<string, unknown>)) {
    if (!isPermissionAuthorityHost(rawHost)) {
      continue;
    }

    const hostState = normalizeHostState(rawState);
    if (!hostState) {
      continue;
    }

    normalized[rawHost] = hostState;
  }

  return normalized;
}

function normalizeHostState(rawState: unknown): PermissionAuthorityHostState | null {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
    return null;
  }

  const hostState = rawState as Partial<PermissionAuthorityHostState>;
  if (!isPermissionAuthorityMode(hostState.mode)) {
    return null;
  }

  return {
    mode: hostState.mode,
    reason: typeof hostState.reason === 'string' ? hostState.reason : undefined,
    updatedAt: typeof hostState.updatedAt === 'string' ? hostState.updatedAt : new Date().toISOString(),
    backupPath: typeof hostState.backupPath === 'string' ? hostState.backupPath : undefined,
    lastSyncedAt: typeof hostState.lastSyncedAt === 'string' ? hostState.lastSyncedAt : undefined,
    scope: hostState.scope === 'user' ? 'user' : undefined,
  };
}

function isPermissionAuthorityMode(value: unknown): value is PermissionAuthorityMode {
  return typeof value === 'string' && PERMISSION_AUTHORITY_MODES.includes(value as PermissionAuthorityMode);
}

function isPermissionAuthorityHost(value: string): value is PermissionAuthorityHost {
  return (PERMISSION_AUTHORITY_HOSTS as readonly string[]).includes(value);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}

function getHostSettingsPath(host: PermissionAuthorityHost, homeDir: string): string {
  if (host === 'claude-code') {
    return getClaudeHookSettingsPath(homeDir);
  }

  throw new Error(`No host settings path registered for ${host}.`);
}

async function syncClaudeCodeAuthoritativeMode(input: {
  homeDir: string;
  host: PermissionAuthorityHost;
  previousBackupPath?: string;
  policies: AuthorityPolicySnapshot;
  now: Date;
}): Promise<{ backupPath: string; syncedAt: string }> {
  const settingsPath = getHostSettingsPath(input.host, input.homeDir);
  await mkdir(dirname(settingsPath), { recursive: true });

  try {
    const currentRaw = existsSync(settingsPath) ? await readFile(settingsPath, 'utf-8') : null;
    const backupPath = input.previousBackupPath
      ?? await createAuthorityBackup(input.homeDir, input.host, currentRaw, input.now);

    const parsed = currentRaw && currentRaw.trim().length > 0
      ? JSON.parse(currentRaw) as Record<string, unknown>
      : {};

    const syncedAt = input.now.toISOString();
    const synced = buildClaudeAuthoritySettings(parsed, input.policies, syncedAt);
    await writeTextFileAtomically(settingsPath, JSON.stringify(synced, null, 2) + '\n');

    return { backupPath, syncedAt };
  } catch (error) {
    throw withAuthorityContext(error, `Failed to sync authoritative Claude Code settings at ${settingsPath}`);
  }
}

function buildClaudeAuthoritySettings(
  parsed: Record<string, unknown>,
  policies: AuthorityPolicySnapshot,
  syncedAt: string,
): Record<string, unknown> {
  const priorMetadata = getAuthorityMetadata(parsed);
  const priorManaged = priorMetadata?.managedPermissions ?? { allow: [], ask: [], deny: [] };
  const permissions = getPermissionsRoot(parsed);

  const managedAllow = uniquePatterns(
    (policies.combinedAllowPatterns ?? []).filter((pattern) => !CLAUDE_REQUIRED_ASK_PATTERNS.includes(pattern)),
  );
  const managedAsk = uniquePatterns([
    ...(policies.combinedConfirmPatterns ?? []),
    ...CLAUDE_REQUIRED_ASK_PATTERNS,
  ]);
  const managedDeny = uniquePatterns(policies.combinedDenyPatterns ?? []);

  const userAllow = removeManagedEntries(permissions.allow, priorManaged.allow);
  const userAsk = removeManagedEntries(permissions.ask, priorManaged.ask)
    .filter((entry) => !shouldStripClaudeAskEntry(entry, managedAllow));
  const userDeny = removeManagedEntries(permissions.deny, priorManaged.deny);

  parsed.permissions = {
    allow: uniquePatterns([...userAllow, ...managedAllow]),
    ask: uniquePatterns([...userAsk, ...managedAsk]),
    deny: uniquePatterns([...userDeny, ...managedDeny]),
  };
  parsed['_dollhousePermissionAuthority'] = {
    version: 1,
    host: 'claude-code',
    managedPermissions: {
      allow: managedAllow,
      ask: managedAsk,
      deny: managedDeny,
    },
    syncedAt,
  } satisfies PermissionAuthorityMetadata;

  return parsed;
}

function getAuthorityMetadata(parsed: Record<string, unknown>): PermissionAuthorityMetadata | null {
  const metadata = parsed['_dollhousePermissionAuthority'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const raw = metadata as Partial<PermissionAuthorityMetadata>;
  if (raw.version !== 1 || raw.host !== 'claude-code') {
    return null;
  }
  return {
    version: 1,
    host: 'claude-code',
    syncedAt: typeof raw.syncedAt === 'string' ? raw.syncedAt : new Date().toISOString(),
    managedPermissions: {
      allow: Array.isArray(raw.managedPermissions?.allow) ? raw.managedPermissions.allow.filter(isString) : [],
      ask: Array.isArray(raw.managedPermissions?.ask) ? raw.managedPermissions.ask.filter(isString) : [],
      deny: Array.isArray(raw.managedPermissions?.deny) ? raw.managedPermissions.deny.filter(isString) : [],
    },
  };
}

function getPermissionsRoot(parsed: Record<string, unknown>): { allow: string[]; ask: string[]; deny: string[] } {
  const permissionsValue = parsed.permissions;
  if (!permissionsValue || typeof permissionsValue !== 'object' || Array.isArray(permissionsValue)) {
    return { allow: [], ask: [], deny: [] };
  }

  const permissions = permissionsValue as Record<string, unknown>;
  return {
    allow: Array.isArray(permissions.allow) ? permissions.allow.filter(isString) : [],
    ask: Array.isArray(permissions.ask) ? permissions.ask.filter(isString) : [],
    deny: Array.isArray(permissions.deny) ? permissions.deny.filter(isString) : [],
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniquePatterns(patterns: string[]): string[] {
  return Array.from(new Set(patterns));
}

function removeManagedEntries(entries: string[], managedEntries: string[]): string[] {
  const managed = new Set(managedEntries);
  return entries.filter((entry) => !managed.has(entry));
}

const CLAUDE_REQUIRED_ASK_PATTERNS = ['mcp__DollhouseMCP__mcp_aql_execute*'];

function shouldStripClaudeAskEntry(entry: string, allowPatterns: string[]): boolean {
  if (allowPatterns.includes(entry)) {
    return true;
  }

  const normalizedEntry = entry.endsWith('*') ? entry.slice(0, -1) : entry;
  if (!normalizedEntry.includes(':') && allowPatterns.some((pattern) => pattern.startsWith(`${normalizedEntry}:`))) {
    return true;
  }

  if (!entry.endsWith('*')) {
    return false;
  }

  return allowPatterns.some((pattern) => pattern.startsWith(normalizedEntry));
}

async function createAuthorityBackup(
  homeDir: string,
  host: PermissionAuthorityHost,
  raw: string | null,
  now: Date,
): Promise<string> {
  const backupDir = getPermissionAuthorityBackupDir(homeDir);
  await mkdir(backupDir, { recursive: true });

  const filename = `${host}-${now.toISOString().replaceAll(':', '-')}.json`;
  const backupPath = join(backupDir, filename);
  const backup: PermissionAuthorityBackup = raw === null
    ? { version: 1, existed: false }
    : { version: 1, existed: true, raw };

  await writeTextFileAtomically(backupPath, JSON.stringify(backup, null, 2) + '\n');
  return backupPath;
}

async function restoreAuthorityBackup(backupPath: string, targetPath: string): Promise<void> {
  try {
    const raw = await readFile(backupPath, 'utf-8');
    const backup = JSON.parse(raw) as PermissionAuthorityBackup;

    if (backup.existed) {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeTextFileAtomically(targetPath, backup.raw ?? '');
      return;
    }

    await rm(targetPath, { force: true });
  } catch (error) {
    throw withAuthorityContext(error, `Failed to restore authority backup ${backupPath} to ${targetPath}`);
  }
}

async function writeTextFileAtomically(filePath: string, contents: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, contents, 'utf-8');
  await rename(tempPath, filePath);
}

function withAuthorityContext(error: unknown, context: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${context}: ${message}`);
}
