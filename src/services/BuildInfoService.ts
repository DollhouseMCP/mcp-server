/**
 * BuildInfoService - Provides build and runtime information
 * Separated from main index.ts to avoid making that file larger
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { logger } from '../utils/logger.js';

export interface BuildInfo {
  package: {
    name: string;
    version: string;
  };
  build: {
    timestamp?: string;
    type: 'git' | 'npm' | 'unknown';
    gitCommit?: string;
    gitBranch?: string;
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
}

export class BuildInfoService {
  private static instance: BuildInfoService;
  private readonly startTime: Date;
  private packageInfo?: { name: string; version: string };

  private constructor() {
    this.startTime = new Date();
  }

  public static getInstance(): BuildInfoService {
    if (!BuildInfoService.instance) {
      BuildInfoService.instance = new BuildInfoService();
    }
    return BuildInfoService.instance;
  }

  /**
   * Get comprehensive build information
   */
  public async getBuildInfo(): Promise<BuildInfo> {
    const [packageInfo, gitInfo, dockerInfo] = await Promise.all([
      this.getPackageInfo(),
      this.getGitInfo(),
      this.getDockerInfo()
    ]);

    const buildTimestamp = await this.getBuildTimestamp();

    return {
      package: packageInfo,
      build: {
        timestamp: buildTimestamp,
        type: gitInfo.commit ? 'git' : buildTimestamp ? 'npm' : 'unknown',
        gitCommit: gitInfo.commit,
        gitBranch: gitInfo.branch
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
      }
    };
  }

  /**
   * Format build info as user-friendly markdown
   */
  public formatBuildInfo(info: BuildInfo): string {
    const lines: string[] = [];
    
    lines.push('# 🔧 Build Information\n');
    
    // Package info
    lines.push('## 📦 Package');
    lines.push(`- **Name**: ${info.package.name}`);
    lines.push(`- **Version**: ${info.package.version}`);
    lines.push('');
    
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
    
    return lines.join('\n');
  }

  private async getPackageInfo(): Promise<{ name: string; version: string }> {
    if (this.packageInfo) {
      return this.packageInfo;
    }

    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const packagePath = path.join(__dirname, '..', '..', 'package.json');
      
      const content = await fs.readFile(packagePath, 'utf-8');
      const pkg = JSON.parse(content);
      
      this.packageInfo = {
        name: pkg.name || 'unknown',
        version: pkg.version || 'unknown'
      };
      
      return this.packageInfo;
    } catch (error) {
      logger.debug('Failed to read package.json:', error);
      return { name: 'unknown', version: 'unknown' };
    }
  }

  private async getBuildTimestamp(): Promise<string | undefined> {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const versionPath = path.join(__dirname, '..', '..', 'dist', 'version.json');
      
      const content = await fs.readFile(versionPath, 'utf-8');
      const version = JSON.parse(content);
      
      return version.buildTime || version.timestamp;
    } catch {
      // Version file might not exist, that's okay
      return undefined;
    }
  }

  private async getGitInfo(): Promise<{ commit?: string; branch?: string }> {
    try {
      const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
      
      return { commit, branch };
    } catch {
      // Not in a git repository or git not available
      return {};
    }
  }

  private async getDockerInfo(): Promise<{ isDocker: boolean; info?: string }> {
    try {
      const cgroupContent = await fs.readFile('/proc/1/cgroup', 'utf-8');
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