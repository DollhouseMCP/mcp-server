/**
 * Check and validate system dependencies
 */

import { safeExec } from '../utils/git.js';
import { VersionManager } from './VersionManager.js';
import { DEPENDENCY_REQUIREMENTS } from '../config/constants.js';

export interface DependencyStatus {
  git: {
    installed: boolean;
    version?: string;
    valid?: boolean;
    error?: string;
    warning?: string;
  };
  npm: {
    installed: boolean;
    version?: string;
    valid?: boolean;
    error?: string;
    warning?: string;
  };
}

export class DependencyChecker {
  private versionManager: VersionManager;
  
  constructor(versionManager: VersionManager) {
    this.versionManager = versionManager;
  }
  
  /**
   * Check all system dependencies
   */
  async checkDependencies(): Promise<DependencyStatus> {
    const [gitStatus, npmStatus] = await Promise.all([
      this.checkGit(),
      this.checkNpm()
    ]);
    
    return {
      git: gitStatus,
      npm: npmStatus
    };
  }
  
  /**
   * Check Git installation and version
   */
  private async checkGit(): Promise<DependencyStatus['git']> {
    try {
      const { stdout: gitOutput } = await safeExec('git', ['--version']);
      const gitVersion = this.versionManager.parseVersionFromOutput(gitOutput, 'git');
      
      if (!gitVersion) {
        return {
          installed: true,
          error: 'Could not parse Git version from output'
        };
      }
      
      const validation = this.versionManager.validateDependencyVersion(
        gitVersion, 
        DEPENDENCY_REQUIREMENTS.git,
        'Git'
      );
      
      return {
        installed: true,
        version: gitVersion,
        valid: validation.valid,
        error: validation.error,
        warning: validation.warning
      };
    } catch (error) {
      return {
        installed: false,
        error: 'Git is not installed or not accessible in PATH'
      };
    }
  }
  
  /**
   * Check npm installation and version
   */
  private async checkNpm(): Promise<DependencyStatus['npm']> {
    try {
      const { stdout: npmOutput } = await safeExec('npm', ['--version']);
      const npmVersion = this.versionManager.parseVersionFromOutput(npmOutput, 'npm');
      
      if (!npmVersion) {
        return {
          installed: true,
          error: 'Could not parse npm version from output'
        };
      }
      
      const validation = this.versionManager.validateDependencyVersion(
        npmVersion, 
        DEPENDENCY_REQUIREMENTS.npm,
        'npm'
      );
      
      return {
        installed: true,
        version: npmVersion,
        valid: validation.valid,
        error: validation.error,
        warning: validation.warning
      };
    } catch (error) {
      return {
        installed: false,
        error: 'npm is not installed or not accessible in PATH'
      };
    }
  }
  
  /**
   * Format dependency status for display
   */
  formatDependencyStatus(status: DependencyStatus): string {
    const lines: string[] = ['**Dependency Check Results:**\n'];
    
    // Git status
    lines.push('**Git:**');
    if (!status.git.installed) {
      lines.push(`❌ ${status.git.error}`);
    } else if (status.git.error) {
      lines.push(`❌ Version ${status.git.version || 'unknown'} - ${status.git.error}`);
    } else if (status.git.warning) {
      lines.push(`⚠️ Version ${status.git.version} - ${status.git.warning}`);
    } else {
      lines.push(`✅ Version ${status.git.version} - OK`);
    }
    
    lines.push('');
    
    // npm status
    lines.push('**npm:**');
    if (!status.npm.installed) {
      lines.push(`❌ ${status.npm.error}`);
    } else if (status.npm.error) {
      lines.push(`❌ Version ${status.npm.version || 'unknown'} - ${status.npm.error}`);
    } else if (status.npm.warning) {
      lines.push(`⚠️ Version ${status.npm.version} - ${status.npm.warning}`);
    } else {
      lines.push(`✅ Version ${status.npm.version} - OK`);
    }
    
    // Overall status
    const hasErrors = status.git.error || status.npm.error;
    const hasWarnings = status.git.warning || status.npm.warning;
    
    lines.push('\n**Overall Status:**');
    if (hasErrors) {
      lines.push('❌ Some dependencies do not meet requirements. Update may fail.');
    } else if (hasWarnings) {
      lines.push('⚠️ All dependencies work but some are not at recommended versions.');
    } else {
      lines.push('✅ All dependencies meet requirements!');
    }
    
    return lines.join('\n');
  }
}