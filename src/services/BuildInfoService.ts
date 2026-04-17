/**
 * BuildInfoService - Provides build and runtime information
 * Separated from main index.ts to avoid making that file larger
 * 
 * SECURITY FIX (PR #614):
 * 1. DMCP-SEC-004: FALSE POSITIVE SUPPRESSION - No user input Unicode normalization needed
 *    This service only processes system information (git, package.json, environment variables)
 *    The MCP tool 'get_build_info' takes NO parameters (empty inputSchema)
 *    No user-provided data flows through this service that requires Unicode normalization
 */

import * as child_process from 'child_process';
import { logger } from '../utils/logger.js';
import { IFileOperationsService } from './FileOperationsService.js';
import { PACKAGE_NAME, PACKAGE_VERSION, BUILD_TIMESTAMP, BUILD_TYPE } from '../generated/version.js';
import type { StartupTimer, StartupReport } from '../telemetry/StartupTimer.js';
import { resolveSessionIdentity } from './sessionIdentity.js';

export interface BuildInfo {
  sessionId: string;
  runtimeSessionId: string;
  sessionSource: 'env' | 'derived';
  package: {
    name: string;
    version: string;
  };
  build: {
    timestamp?: string;
    type: 'git' | 'npm' | 'unknown';
    gitCommit?: string;
    gitBranch?: string;
    collectionFix?: string;  // Version identifier for verification
  };
  runtime: {
    nodeVersion: string;
    platform: string;
    arch: string;
    uptime: number;
    memoryUsage: NodeJS.MemoryUsage;
  };
  environment: {
    nodeEnv?: string;
    isProduction: boolean;
    isDevelopment: boolean;
    isDebug: boolean;
    isDocker: boolean;
    dockerInfo?: string;
  };
  server: {
    startTime: Date;
    uptime: number;
    mcpConnection: boolean;
  };
  /** Issue #706: Startup timing and readiness status. */
  startup?: {
    status: 'ready' | 'initializing';
    deferredSetupComplete: boolean;
    uptimeMs: number;
    startupTimingMs?: StartupReport;
  };
}

export class BuildInfoService {
  private readonly startTime: Date;
  private readonly fileOperations: IFileOperationsService;
  /** Issue #706: Optional startup timer for timing instrumentation. */
  private startupTimer: StartupTimer | null = null;
  /** Issue #706: Callback to check deferred setup status. */
  private deferredSetupChecker: (() => boolean) | null = null;

  constructor(fileOperations: IFileOperationsService) {
    this.startTime = new Date();
    this.fileOperations = fileOperations;
  }

  /**
   * Issue #706: Wire in startup instrumentation after DI is ready.
   * Called from Container to avoid circular dependency at registration time.
   */
  setStartupTimer(timer: StartupTimer): void {
    this.startupTimer = timer;
  }

  /**
   * Issue #706: Wire in deferred setup status checker.
   */
  setDeferredSetupChecker(checker: () => boolean): void {
    this.deferredSetupChecker = checker;
  }

  /**
   * Get comprehensive build information
   * SECURITY NOTE: This method processes only system-generated data
   * No user input is involved - all data comes from filesystem, git, and Node.js process
   *
   * Uses Promise.allSettled to collect partial results even if some sources fail,
   * providing maximum information availability with graceful degradation.
   */
  public async getBuildInfo(): Promise<BuildInfo> {
    // Use Promise.allSettled to collect all available info, even if some sources fail
    const results = await Promise.allSettled([
      this.getGitInfo(),
      this.getDockerInfo()
    ]);

    // Package info comes from build-time generated constants
    const packageInfo = { name: PACKAGE_NAME, version: PACKAGE_VERSION };

    const gitInfo = results[0].status === 'fulfilled'
      ? results[0].value
      : { commit: undefined, branch: undefined };

    const dockerInfo = results[1].status === 'fulfilled'
      ? results[1].value
      : { isDocker: false, info: undefined };

    // Log any failures for diagnostics
    const failures: string[] = [];
    if (results[0].status === 'rejected') {
      failures.push(`git info: ${results[0].reason}`);
    }
    if (results[1].status === 'rejected') {
      failures.push(`docker info: ${results[1].reason}`);
    }

    if (failures.length > 0) {
      logger.debug(`Build info collection had ${failures.length} failure(s): ${failures.join('; ')}`);
    }

    // Build timestamp comes from build-time generated constants
    const buildTimestamp = BUILD_TIMESTAMP;

    // Issue #706: Startup timing and readiness
    const deferredComplete = this.deferredSetupChecker ? this.deferredSetupChecker() : true;
    const startupInfo: BuildInfo['startup'] = {
      status: deferredComplete ? 'ready' : 'initializing',
      deferredSetupComplete: deferredComplete,
      uptimeMs: Date.now() - this.startTime.getTime(),
      startupTimingMs: this.startupTimer?.getReport(),
    };
    const sessionIdentity = resolveSessionIdentity();

    return {
      sessionId: sessionIdentity.sessionId,
      runtimeSessionId: sessionIdentity.runtimeSessionId,
      sessionSource: sessionIdentity.source,
      package: packageInfo,
      build: {
        timestamp: buildTimestamp,
        type: BUILD_TYPE,
        gitCommit: gitInfo.commit,
        gitBranch: gitInfo.branch,
        collectionFix: 'v1.6.9-beta1-collection-fix'  // Version identifier for verification
      },
      runtime: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage()
      },
      environment: {
        nodeEnv: process.env.NODE_ENV,
        isProduction: process.env.NODE_ENV === 'production',
        isDevelopment: process.env.NODE_ENV === 'development',
        isDebug: process.env.DEBUG === 'true' || process.env.DEBUG === '1',
        isDocker: dockerInfo.isDocker,
        dockerInfo: dockerInfo.info
      },
      server: {
        startTime: this.startTime,
        uptime: Date.now() - this.startTime.getTime(),
        mcpConnection: true // We're connected if this method is being called via MCP
      },
      startup: startupInfo,
    };
  }

  /**
   * Format build info as user-friendly markdown
   * SECURITY NOTE: Only formats system-generated data - no user input processing
   * All input data comes from getBuildInfo() which only reads system information
   */
  public formatBuildInfo(info: BuildInfo): string {
    const lines: string[] = [];
    
    lines.push('# 🔧 Build Information\n');
    
    // Package info
    lines.push('## 📦 Package');
    lines.push(`- **Name**: ${info.package.name}`);
    lines.push(`- **Version**: ${info.package.version}`);
    lines.push('');

    const identitySourceLabel = info.sessionSource === 'env'
      ? 'Explicit environment'
      : 'Derived from workspace context';
    const sessionLines = [
      '## 🪪 Session',
      `- **Session ID**: ${info.sessionId}`,
      `- **Identity Source**: ${identitySourceLabel}`,
    ];
    if (info.runtimeSessionId !== info.sessionId) {
      sessionLines.splice(2, 0, `- **Runtime Session ID**: ${info.runtimeSessionId}`);
    }
    lines.push(...sessionLines, '');
    
    // Build info
    lines.push('## 🏗️ Build');
    lines.push(`- **Type**: ${info.build.type}`);
    if (info.build.timestamp) {
      lines.push(`- **Timestamp**: ${info.build.timestamp}`);
    }
    if (info.build.gitCommit) {
      lines.push(`- **Git Commit**: \`${info.build.gitCommit}\``);
    }
    if (info.build.gitBranch) {
      lines.push(`- **Git Branch**: ${info.build.gitBranch}`);
    }
    lines.push('');
    
    // Runtime info
    lines.push('## 💻 Runtime');
    lines.push(`- **Node.js**: ${info.runtime.nodeVersion}`);
    lines.push(`- **Platform**: ${info.runtime.platform}`);
    lines.push(`- **Architecture**: ${info.runtime.arch}`);
    lines.push(`- **Process Uptime**: ${this.formatUptime(info.runtime.uptime)}`);
    lines.push(`- **Memory Usage**: ${this.formatMemory(info.runtime.memoryUsage.heapUsed)} / ${this.formatMemory(info.runtime.memoryUsage.heapTotal)}`);
    lines.push('');
    
    // Environment info
    lines.push('## ⚙️ Environment');
    lines.push(`- **NODE_ENV**: ${info.environment.nodeEnv || 'not set'}`);
    lines.push(`- **Mode**: ${info.environment.isProduction ? 'Production' : info.environment.isDevelopment ? 'Development' : 'Unknown'}`);
    lines.push(`- **Debug**: ${info.environment.isDebug ? 'Enabled' : 'Disabled'}`);
    lines.push(`- **Docker**: ${info.environment.isDocker ? 'Yes' : 'No'}`);
    if (info.environment.dockerInfo) {
      lines.push(`- **Container**: ${info.environment.dockerInfo}`);
    }
    lines.push('');
    
    // Server info
    lines.push('## 🚀 Server');
    lines.push(`- **Started**: ${info.server.startTime.toISOString()}`);
    lines.push(`- **Uptime**: ${this.formatUptime(info.server.uptime / 1000)}`);
    lines.push(`- **MCP Connection**: ${info.server.mcpConnection ? '✅ Connected' : '❌ Disconnected'}`);

    // Issue #706: Startup timing
    if (info.startup) {
      lines.push('');
      lines.push('## ⏱️ Startup');
      lines.push(`- **Status**: ${info.startup.status === 'ready' ? '✅ Ready' : '⏳ Initializing'}`);
      lines.push(`- **Deferred Setup**: ${info.startup.deferredSetupComplete ? 'Complete' : 'In Progress'}`);
      if (info.startup.startupTimingMs) {
        const timing = info.startup.startupTimingMs;
        lines.push(`- **Critical Path**: ${timing.criticalPathMs}ms`);
        lines.push(`- **Deferred Work**: ${timing.deferredMs}ms`);
        lines.push(`- **Total Startup**: ${timing.totalMs}ms`);
        if (timing.connectAtMs !== null) {
          lines.push(`- **Time to Connect**: ${timing.connectAtMs}ms`);
        }
        if (timing.phases.length > 0) {
          lines.push('- **Phases**:');
          for (const phase of timing.phases) {
            const tag = phase.critical ? 'critical' : 'deferred';
            lines.push(`  - ${phase.name}: ${phase.durationMs}ms (${tag})`);
          }
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * SECURITY NOTE: No Unicode normalization needed - executes system git commands
   * Data source: Git CLI output (system-controlled), no user input
   */
  private async getGitInfo(): Promise<{ commit?: string; branch?: string }> {
    try {
      // SECURITY NOTE: Git commands return system-controlled data - not user input
      // Git commit hashes and branch names are controlled by git, no Unicode normalization needed
      const commit = child_process.execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
      const branch = child_process.execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
      
      return { commit, branch };
    } catch {
      // Not in a git repository or git not available
      return {};
    }
  }

  /**
   * SECURITY NOTE: No Unicode normalization needed - reads container runtime files
   * Data source: System cgroup files (container-controlled), no user input
   */
  private async getDockerInfo(): Promise<{ isDocker: boolean; info?: string }> {
    try {
      // SECURITY NOTE: Reading system cgroup file - controlled by container runtime, not user input
      // Container runtime generates this file content, no Unicode normalization needed
      const cgroupContent = await this.fileOperations.readFile('/proc/1/cgroup', {
        source: 'BuildInfoService.getDockerInfo'
      });
      const isDocker = cgroupContent.includes('docker') || cgroupContent.includes('containerd');
      
      if (isDocker) {
        // Try to get container ID
        const containerId = cgroupContent
          .split('\n')
          .find(line => line.includes('docker'))
          ?.split('/')
          .pop()
          ?.substring(0, 12);
        
        return {
          isDocker: true,
          info: containerId ? `Container ID: ${containerId}` : 'Running in Docker'
        };
      }
      
      return { isDocker: false };
    } catch {
      // Not in Docker or /proc not available
      return { isDocker: false };
    }
  }

  private formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    
    return parts.join(' ');
  }

  private formatMemory(bytes: number): string {
    const mb = bytes / 1024 / 1024;
    return `${mb.toFixed(1)} MB`;
  }
}
