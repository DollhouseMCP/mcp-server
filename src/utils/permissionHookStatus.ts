import { homedir } from 'node:os';
import { logger } from './logger.js';
import {
  type PermissionHookAuditSummary,
  type PermissionHookHealthSummary,
  type HookAssetAuditResult,
  type PermissionHookStartupRepairHostResult,
  type PermissionHookStartupRepairSummary,
  type PermissionHookStatus,
  type ReconcilePermissionHookOptions,
  AUTO_REPAIRABLE_HOOK_HOSTS,
  auditHookAssets,
  collectHookMarkerPaths,
  collectHookMarkerPathsAsync,
  getPrimaryHookScriptPath,
  installHookAssetsForHost,
  normalizeHookHost,
  readHostSpecificHookStatus,
  summarizeMarkerStatuses,
  supportsManagedHookAssets,
} from './permissionHookShared.js';

let lastPermissionHookStartupRepairSummary: PermissionHookStartupRepairSummary | null = null;

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

export function summarizePermissionHookHealth(
  summary: PermissionHookAuditSummary,
): PermissionHookHealthSummary {
  const lastStartupRepair = summary.lastStartupRepair;
  const hadErrors = Boolean(
    lastStartupRepair?.hostResults.some((result) => result.outcome === 'error'),
  );
  const needsRepairCount = lastStartupRepair?.needsRepairCount ?? summary.needsRepairHosts.length;
  const repairedCount = lastStartupRepair?.repairedCount ?? summary.repairedHosts.length;

  if (hadErrors) {
    return {
      status: 'error',
      message: needsRepairCount > 0
        ? `${needsRepairCount} hook host${needsRepairCount === 1 ? '' : 's'} still ${needsRepairCount === 1 ? 'needs' : 'need'} attention after startup repair`
        : 'A startup hook repair failed and needs attention',
      repairedCount,
      needsRepairCount,
      lastCheckedAt: lastStartupRepair?.completedAt,
    };
  }

  if (needsRepairCount > 0) {
    return {
      status: 'warning',
      message: `${needsRepairCount} hook host${needsRepairCount === 1 ? '' : 's'} still ${needsRepairCount === 1 ? 'needs' : 'need'} repair`,
      repairedCount,
      needsRepairCount,
      lastCheckedAt: lastStartupRepair?.completedAt,
    };
  }

  if (repairedCount > 0) {
    return {
      status: 'ok',
      message: `${repairedCount} hook host${repairedCount === 1 ? '' : 's'} repaired on startup`,
      repairedCount,
      needsRepairCount,
      lastCheckedAt: lastStartupRepair?.completedAt,
    };
  }

  return {
    status: 'ok',
    message: summary.currentHosts.length > 0
      ? 'Managed hook assets are current'
      : 'No managed hook assets currently installed',
    repairedCount,
    needsRepairCount,
    lastCheckedAt: lastStartupRepair?.completedAt,
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
