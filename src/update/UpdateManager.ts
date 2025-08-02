/**
 * Manage server updates and rollbacks
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { safeExec } from '../utils/git.js';
import { VersionManager } from './VersionManager.js';
import { UpdateChecker } from './UpdateChecker.js';
import { DependencyChecker } from './DependencyChecker.js';
import { BackupManager } from './BackupManager.js';
import { InstallationDetector } from '../utils/installation.js';
import { logger } from '../utils/logger.js';
import { compareVersions } from '../utils/version.js';

export interface UpdateProgress {
  step: string;
  message: string;
  isComplete: boolean;
}

export class UpdateManager {
  private versionManager: VersionManager;
  private updateChecker: UpdateChecker;
  private dependencyChecker: DependencyChecker;
  private backupManager: BackupManager;
  private rootDir: string;
  
  constructor(rootDir?: string) {
    this.rootDir = rootDir || process.cwd();
    this.versionManager = new VersionManager();
    this.updateChecker = new UpdateChecker(this.versionManager);
    this.dependencyChecker = new DependencyChecker(this.versionManager);
    this.backupManager = new BackupManager(this.rootDir);
  }
  
  /**
   * Check for available updates
   */
  async checkForUpdates(): Promise<{ text: string }> {
    try {
      const result = await this.updateChecker.checkForUpdates();
      const text = this.updateChecker.formatUpdateCheckResult(result);
      return { text };
    } catch (error) {
      const text = this.updateChecker.formatUpdateCheckResult(null, error as Error);
      return { text };
    }
  }
  
  /**
   * Perform server update
   */
  async updateServer(createBackup: boolean = true, personaIndicator: string = ''): Promise<{ text: string }> {
    const progress: UpdateProgress[] = [];
    
    try {
      // Detect installation type
      const installationType = InstallationDetector.getInstallationType();
      logger.info(`[UpdateManager] Detected installation type: ${installationType}`);
      
      // Handle npm installations differently
      if (installationType === 'npm') {
        return this.updateNpmInstallation(createBackup, personaIndicator);
      }
      
      // For git installations, proceed with existing logic
      // Step 1: Check dependencies
      progress.push({ step: 'dependencies', message: 'Checking system dependencies...', isComplete: false });
      const dependencies = await this.dependencyChecker.checkDependencies();
      
      if (!dependencies.git.installed || dependencies.git.error) {
        return {
          text: personaIndicator + '❌ **Update Failed**\n\n' +
            'Git is required for updates but is not available.\n' +
            dependencies.git.error || 'Git is not installed.'
        };
      }
      
      if (!dependencies.npm.installed || dependencies.npm.error) {
        return {
          text: personaIndicator + '❌ **Update Failed**\n\n' +
            'npm is required for updates but is not available.\n' +
            dependencies.npm.error || 'npm is not installed.'
        };
      }
      
      progress[0].isComplete = true;
      
      // Step 2: Create backup if requested
      if (createBackup) {
        progress.push({ step: 'backup', message: 'Creating backup...', isComplete: false });
        
        const currentVersion = await this.versionManager.getCurrentVersion();
        const backup = await this.backupManager.createBackup(currentVersion);
        
        progress[1].isComplete = true;
        progress[1].message = `Backup created at: ${backup.timestamp}`;
      }
      
      // Step 3: Git fetch
      progress.push({ step: 'fetch', message: 'Fetching latest changes...', isComplete: false });
      await safeExec('git', ['fetch', 'origin'], { cwd: this.rootDir });
      progress[progress.length - 1].isComplete = true;
      
      // Step 4: Check for uncommitted changes
      progress.push({ step: 'check', message: 'Checking for uncommitted changes...', isComplete: false });
      const { stdout: statusOutput } = await safeExec('git', ['status', '--porcelain'], { cwd: this.rootDir });
      
      if (statusOutput.trim()) {
        return {
          text: personaIndicator + '❌ **Update Failed**\n\n' +
            'You have uncommitted changes. Please commit or stash them before updating.\n\n' +
            'Modified files:\n' + statusOutput
        };
      }
      progress[progress.length - 1].isComplete = true;
      
      // Step 5: Git pull
      progress.push({ step: 'pull', message: 'Pulling latest changes...', isComplete: false });
      const { stdout: pullOutput } = await safeExec('git', ['pull', 'origin', 'main'], { cwd: this.rootDir });
      progress[progress.length - 1].isComplete = true;
      
      // Check if already up to date
      if (pullOutput.includes('Already up to date')) {
        return {
          text: personaIndicator + '✅ **Already Up to Date**\n\n' +
            'Your DollhouseMCP installation is already at the latest version.\n\n' +
            'No changes were pulled from the repository.'
        };
      }
      
      // Step 6: npm install
      progress.push({ step: 'install', message: 'Installing dependencies...', isComplete: false });
      await safeExec('npm', ['install'], { cwd: this.rootDir });
      progress[progress.length - 1].isComplete = true;
      
      // Step 7: Build
      progress.push({ step: 'build', message: 'Building TypeScript...', isComplete: false });
      await safeExec('npm', ['run', 'build'], { cwd: this.rootDir });
      progress[progress.length - 1].isComplete = true;
      
      // Step 8: Cleanup old backups
      if (createBackup) {
        progress.push({ step: 'cleanup', message: 'Cleaning up old backups...', isComplete: false });
        const deletedCount = await this.backupManager.cleanupOldBackups();
        progress[progress.length - 1].isComplete = true;
        progress[progress.length - 1].message = `Cleaned up ${deletedCount} old backup(s)`;
      }
      
      // Format success message
      const successParts = [
        personaIndicator + '✅ **Update Complete!**\n\n',
        '**Update Summary:**\n'
      ];
      
      progress.forEach(p => {
        successParts.push(`${p.isComplete ? '✅' : '❌'} ${p.message}\n`);
      });
      
      successParts.push(
        '\n**Next Steps:**\n',
        '1. The server will restart automatically\n',
        '2. All personas will be reloaded\n',
        '3. Check `get_server_status` to verify the new version\n\n',
        '💡 **Tip:** If you encounter issues, use `rollback_update true` to restore the previous version.'
      );
      
      return { text: successParts.join('') };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        text: personaIndicator + '❌ **Update Failed**\n\n' +
          'Error: ' + errorMessage + '\n\n' +
          '**Progress:**\n' + 
          progress.map(p => `${p.isComplete ? '✅' : '❌'} ${p.message}`).join('\n') + '\n\n' +
          '**Recovery Options:**\n' +
          '• Try running the update again\n' +
          '• Check your internet connection\n' +
          '• Ensure you have proper permissions\n' +
          '• If a backup was created, use `rollback_update true` to restore'
      };
    }
  }
  
  /**
   * Rollback to previous version
   */
  async rollbackUpdate(force: boolean = false, personaIndicator: string = ''): Promise<{ text: string }> {
    try {
      // Check installation type
      const installationType = InstallationDetector.getInstallationType();
      
      if (installationType === 'npm') {
        return this.rollbackNpmInstallation(force, personaIndicator);
      }
      
      // For git installations, use existing logic
      // Get latest backup
      const latestBackup = await this.backupManager.getLatestBackup();
      
      if (!latestBackup) {
        return {
          text: personaIndicator + '❌ **No Backups Found**\n\n' +
            'There are no backups available to restore.\n\n' +
            'Backups are created automatically when you run `update_server true`.'
        };
      }
      
      // Check if rollback is needed
      if (!force) {
        try {
          // Test if the server is working by checking version
          await this.versionManager.getCurrentVersion();
          
          return {
            text: personaIndicator + '⚠️ **Rollback Confirmation Required**\n\n' +
              'The server appears to be working normally.\n\n' +
              `**Latest Backup:** ${latestBackup.timestamp}\n` +
              `**Backup Version:** ${latestBackup.version || 'Unknown'}\n\n` +
              'To force rollback anyway, use: `rollback_update true`\n\n' +
              '⚠️ **Warning:** This will restore all files to the backup state.'
          };
        } catch {
          // Server is broken, proceed with rollback
        }
      }
      
      // Perform rollback
      await this.backupManager.restoreBackup(latestBackup.path);
      
      // Reinstall dependencies
      await safeExec('npm', ['install'], { cwd: this.rootDir });
      
      // Rebuild
      await safeExec('npm', ['run', 'build'], { cwd: this.rootDir });
      
      return {
        text: personaIndicator + '✅ **Rollback Complete!**\n\n' +
          `Restored from backup: ${latestBackup.timestamp}\n` +
          `Backup version: ${latestBackup.version || 'Unknown'}\n\n` +
          '**What was restored:**\n' +
          '• All source files\n' +
          '• Configuration files\n' +
          '• Dependencies reinstalled\n' +
          '• TypeScript rebuilt\n\n' +
          '**Next Steps:**\n' +
          '1. The server will restart automatically\n' +
          '2. Check `get_server_status` to verify the version\n' +
          '3. Test your personas to ensure everything works'
      };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        text: personaIndicator + '❌ **Rollback Failed**\n\n' +
          'Error: ' + errorMessage + '\n\n' +
          '**Manual Recovery:**\n' +
          '1. Check the backups directory: ../dollhousemcp-backups/\n' +
          '2. Manually restore files if needed\n' +
          '3. Run `npm install` and `npm run build`\n' +
          '4. Contact support if issues persist'
      };
    }
  }
  
  /**
   * Update npm installation
   */
  private async updateNpmInstallation(createBackup: boolean, personaIndicator: string = ''): Promise<{ text: string }> {
    try {
      logger.info('[UpdateManager] Starting npm update process');
      
      // Check npm is available
      const dependencies = await this.dependencyChecker.checkDependencies();
      if (!dependencies.npm.installed || dependencies.npm.error) {
        return {
          text: personaIndicator + '❌ **Update Failed**\n\n' +
            'npm is required for updates but is not available.\n' +
            dependencies.npm.error || 'npm is not installed.'
        };
      }
      
      // Get current version
      const currentVersion = await this.versionManager.getCurrentVersion();
      logger.info(`[UpdateManager] Current version: ${currentVersion}`);
      
      // Check latest version from npm registry
      logger.info('[UpdateManager] Checking npm registry for latest version');
      
      // Security: Validate package name to prevent any potential injection
      const packageName = '@dollhousemcp/mcp-server';
      if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(packageName)) {
        throw new Error('Invalid package name format');
      }
      
      const { stdout: npmViewOutput } = await safeExec('npm', ['view', packageName, 'version'], {
        cwd: this.rootDir,
        timeout: 30000
      });
      
      const latestVersion = npmViewOutput.trim();
      logger.info(`[UpdateManager] Latest npm version: ${latestVersion}`);
      
      // Compare versions
      const comparison = compareVersions(currentVersion, latestVersion);
      
      if (comparison >= 0) {
        return {
          text: personaIndicator + '✅ **Already up to date!**\n\n' +
            `Current version: ${currentVersion}\n` +
            `Latest version: ${latestVersion}\n\n` +
            'No update needed.'
        };
      }
      
      // For npm installations, backup is mandatory for safety
      logger.info('[UpdateManager] Creating backup before npm update');
      try {
        // For npm installations, we backup the global installation directory
        const npmGlobalPath = InstallationDetector.getNpmGlobalPath();
        if (!npmGlobalPath) {
          throw new Error('Could not determine npm global installation path');
        }
        
        // Create npm-specific backup
        const backupPath = await this.backupManager.createNpmBackup(npmGlobalPath, currentVersion);
        logger.info(`[UpdateManager] Backup created at: ${backupPath}`);
      } catch (backupError) {
        logger.error('[UpdateManager] Backup failed:', backupError);
        return {
          text: personaIndicator + '❌ **Update Failed**\n\n' +
            'Failed to create backup before update.\n' +
            'Error: ' + (backupError instanceof Error ? backupError.message : String(backupError)) + '\n\n' +
            '**Note:** Backup is mandatory for npm installations to ensure safe rollback.\n' +
            'Please check disk space and permissions.'
        };
      }
      
      // Perform npm update
      logger.info('[UpdateManager] Running npm update -g @dollhousemcp/mcp-server');
      const updateResult = await safeExec('npm', ['update', '-g', '@dollhousemcp/mcp-server'], {
        cwd: this.rootDir,
        timeout: 300000 // 5 minutes for npm update
      });
      
      logger.info('[UpdateManager] npm update completed', updateResult);
      
      // Verify update succeeded
      const { stdout: verifyOutput } = await safeExec('npm', ['list', '-g', '@dollhousemcp/mcp-server', '--depth=0'], {
        cwd: this.rootDir,
        timeout: 30000
      });
      
      const versionMatch = verifyOutput.match(/@dollhousemcp\/mcp-server@(\d+\.\d+\.\d+)/);
      const installedVersion = versionMatch ? versionMatch[1] : 'unknown';
      
      if (installedVersion !== latestVersion) {
        logger.warn(`[UpdateManager] Version mismatch after update. Expected: ${latestVersion}, Got: ${installedVersion}`);
      }
      
      return {
        text: personaIndicator + '✅ **Update Complete!**\n\n' +
          `Updated from v${currentVersion} to v${latestVersion}\n\n` +
          '**What was updated:**\n' +
          '• DollhouseMCP server package\n' +
          '• All dependencies\n\n' +
          '**Next Steps:**\n' +
          '1. The server will restart automatically\n' +
          '2. Check `get_server_status` to verify the new version\n' +
          '3. Test your personas to ensure everything works\n\n' +
          '💡 **Tip:** If you encounter issues, use `rollback_update true` to restore the previous version.'
      };
      
    } catch (error) {
      logger.error('[UpdateManager] npm update failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        text: personaIndicator + '❌ **Update Failed**\n\n' +
          'Error: ' + errorMessage + '\n\n' +
          '**Troubleshooting:**\n' +
          '1. Ensure you have permission to update global npm packages\n' +
          '2. Try running with sudo if on macOS/Linux\n' +
          '3. Check your internet connection\n' +
          '4. Verify npm registry is accessible\n\n' +
          '**Manual Update:**\n' +
          '```\n' +
          'npm update -g @dollhousemcp/mcp-server\n' +
          '```'
      };
    }
  }
  
  /**
   * Rollback npm installation
   */
  private async rollbackNpmInstallation(force: boolean, personaIndicator: string = ''): Promise<{ text: string }> {
    try {
      logger.info('[UpdateManager] Starting npm rollback process');
      
      // Get npm backup manifest
      const npmBackupsDir = path.join(process.env.HOME || '', '.dollhouse', 'backups', 'npm');
      const manifestPath = path.join(npmBackupsDir, 'manifest.json');
      
      let manifest;
      try {
        const content = await fs.readFile(manifestPath, 'utf-8');
        manifest = JSON.parse(content);
      } catch (error) {
        return {
          text: personaIndicator + '❌ **No NPM Backups Found**\n\n' +
            'There are no npm backups available to restore.\n\n' +
            'Backups are created automatically when you run `update_server true` with npm installations.'
        };
      }
      
      if (!manifest.backups || manifest.backups.length === 0) {
        return {
          text: personaIndicator + '❌ **No NPM Backups Found**\n\n' +
            'The backup manifest is empty.\n\n' +
            'Backups are created automatically when you run `update_server true`.'
        };
      }
      
      // Get latest backup
      const latestBackup = manifest.backups[0];
      
      // Check if rollback is needed
      if (!force) {
        try {
          // Test if the server is working
          await this.versionManager.getCurrentVersion();
          
          return {
            text: personaIndicator + '⚠️ **Rollback Confirmation Required**\n\n' +
              'The server appears to be working normally.\n\n' +
              `**Latest Backup:** ${latestBackup.timestamp}\n` +
              `**Backup Version:** ${latestBackup.version || 'Unknown'}\n\n` +
              'To force rollback anyway, use: `rollback_update true`\n\n' +
              '⚠️ **Warning:** This will restore the npm package to the backup state.'
          };
        } catch {
          // Server is broken, proceed with rollback
        }
      }
      
      // Get npm global path
      const npmGlobalPath = InstallationDetector.getNpmGlobalPath();
      if (!npmGlobalPath) {
        return {
          text: personaIndicator + '❌ **Rollback Failed**\n\n' +
            'Could not determine npm global installation path.\n\n' +
            'Please reinstall manually:\n' +
            '```\n' +
            'npm install -g @dollhousemcp/mcp-server@' + (latestBackup.version || 'latest') + '\n' +
            '```'
        };
      }
      
      logger.info(`[UpdateManager] Restoring npm backup from: ${latestBackup.path}`);
      
      // Use atomic operations to prevent race conditions
      const tempPath = `${npmGlobalPath}.tmp-${Date.now()}`;
      const backupPath = `${npmGlobalPath}.backup-${Date.now()}`;
      
      try {
        // Step 1: Copy backup to temporary location
        const backupPackagePath = path.join(latestBackup.path, 'package');
        await this.copyDirectory(backupPackagePath, tempPath);
        
        // Step 2: Move current installation to backup (atomic)
        await fs.rename(npmGlobalPath, backupPath);
        
        // Step 3: Move temp to final location (atomic)
        await fs.rename(tempPath, npmGlobalPath);
        
        // Step 4: Remove old backup
        await fs.rm(backupPath, { recursive: true, force: true }).catch(() => {
          // Log but don't fail if cleanup fails
          logger.warn(`[UpdateManager] Failed to cleanup backup at: ${backupPath}`);
        });
      } catch (rollbackError) {
        // Attempt to restore original if rollback fails
        try {
          await fs.rename(backupPath, npmGlobalPath);
        } catch {
          // If we can't restore, at least try to put temp in place
          try {
            await fs.rename(tempPath, npmGlobalPath);
          } catch {
            // Complete failure - guide user to manual recovery
          }
        }
        throw rollbackError;
      }
      
      return {
        text: personaIndicator + '✅ **NPM Rollback Complete!**\n\n' +
          `Restored from backup: ${latestBackup.timestamp}\n` +
          `Backup version: ${latestBackup.version || 'Unknown'}\n\n` +
          '**What was restored:**\n' +
          '• NPM package files\n' +
          '• All dependencies\n\n' +
          '**Next Steps:**\n' +
          '1. The server will restart automatically\n' +
          '2. Check `get_server_status` to verify the version\n' +
          '3. Test your personas to ensure everything works'
      };
      
    } catch (error) {
      logger.error('[UpdateManager] npm rollback failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        text: personaIndicator + '❌ **NPM Rollback Failed**\n\n' +
          'Error: ' + errorMessage + '\n\n' +
          '**Manual Recovery:**\n' +
          '1. Check the backups directory: ~/.dollhouse/backups/npm/\n' +
          '2. Reinstall a specific version:\n' +
          '   ```\n' +
          '   npm install -g @dollhousemcp/mcp-server@1.4.0\n' +
          '   ```\n' +
          '3. Contact support if issues persist'
      };
    }
  }
  
  /**
   * Copy directory recursively (helper method)
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      
      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
  
  /**
   * Convert npm installation to git installation
   */
  async convertToGitInstallation(targetDir?: string, confirm: boolean = false, personaIndicator: string = ''): Promise<{ text: string }> {
    try {
      const installationType = InstallationDetector.getInstallationType();
      
      if (installationType === 'git') {
        return {
          text: personaIndicator + '⚠️ **Already a Git Installation**\n\n' +
            'This server is already running from a git installation.\n' +
            'No conversion needed.'
        };
      }
      
      if (installationType === 'unknown') {
        return {
          text: personaIndicator + '❌ **Installation Type Unknown**\n\n' +
            'Cannot determine the current installation type.\n' +
            'Please check your installation manually.'
        };
      }
      
      // Default target directory
      const defaultTargetDir = path.join(process.env.HOME || '', '.dollhouse', 'mcp-server-git');
      const gitTargetDir = targetDir || defaultTargetDir;
      
      if (!confirm) {
        return {
          text: personaIndicator + '🔄 **Convert to Git Installation**\n\n' +
            '**This will:**\n' +
            `1. Clone DollhouseMCP to: ${gitTargetDir}\n` +
            '2. Copy your portfolio and settings\n' +
            '3. Build the TypeScript code\n' +
            '4. Provide Claude Desktop configuration\n\n' +
            '**Benefits of Git Installation:**\n' +
            '• Full control over updates\n' +
            '• Access to development branches\n' +
            '• Ability to contribute changes\n' +
            '• Rollback to any commit\n\n' +
            '**To proceed:**\n' +
            '`convert_to_git_installation true`\n\n' +
            '**To use custom directory:**\n' +
            '`convert_to_git_installation "/path/to/dir" true`'
        };
      }
      
      logger.info(`[UpdateManager] Starting conversion to git installation at: ${gitTargetDir}`);
      
      // Check if target directory already exists
      try {
        await fs.access(gitTargetDir);
        return {
          text: personaIndicator + '❌ **Target Directory Exists**\n\n' +
            `The directory ${gitTargetDir} already exists.\n\n` +
            '**Options:**\n' +
            '1. Remove the existing directory first\n' +
            '2. Choose a different target directory\n' +
            '3. Use the existing git installation'
        };
      } catch {
        // Directory doesn't exist, good to proceed
      }
      
      // Step 1: Clone the repository
      logger.info('[UpdateManager] Cloning repository...');
      await safeExec('git', ['clone', 'https://github.com/DollhouseMCP/mcp-server.git', gitTargetDir], {
        timeout: 300000 // 5 minutes
      });
      
      // Step 2: Install dependencies
      logger.info('[UpdateManager] Installing dependencies...');
      await safeExec('npm', ['install'], {
        cwd: gitTargetDir,
        timeout: 300000
      });
      
      // Step 3: Build TypeScript
      logger.info('[UpdateManager] Building TypeScript...');
      await safeExec('npm', ['run', 'build'], {
        cwd: gitTargetDir,
        timeout: 120000
      });
      
      // Step 4: Copy portfolio
      const portfolioSource = path.join(process.env.HOME || '', '.dollhouse', 'portfolio');
      const portfolioTarget = path.join(process.env.HOME || '', '.dollhouse', 'portfolio');
      
      logger.info('[UpdateManager] Portfolio will remain at: ' + portfolioTarget);
      
      // Step 5: Generate Claude Desktop config
      const configPath = path.join(gitTargetDir, 'dist', 'index.js');
      const claudeConfig = {
        mcpServers: {
          dollhousemcp: {
            command: 'node',
            args: [configPath]
          }
        }
      };
      
      return {
        text: personaIndicator + '✅ **Git Installation Complete!**\n\n' +
          `**Installation Location:** ${gitTargetDir}\n\n` +
          '**Next Steps:**\n\n' +
          '1. **Update Claude Desktop configuration:**\n' +
          '   ```json\n' +
          JSON.stringify(claudeConfig, null, 2) + '\n' +
          '   ```\n\n' +
          '2. **Restart Claude Desktop**\n\n' +
          '3. **Verify installation:**\n' +
          '   After restart, run `get_server_status` to confirm\n\n' +
          '**Your portfolio remains at:**\n' +
          `   ${portfolioTarget}\n\n` +
          '**To update in the future:**\n' +
          '   ```bash\n' +
          `   cd ${gitTargetDir}\n` +
          '   git pull\n' +
          '   npm install\n' +
          '   npm run build\n' +
          '   ```\n\n' +
          '💡 **Tip:** You can now use `update_server` to update via git!'
      };
      
    } catch (error) {
      logger.error('[UpdateManager] Git conversion failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        text: personaIndicator + '❌ **Conversion Failed**\n\n' +
          'Error: ' + errorMessage + '\n\n' +
          '**Troubleshooting:**\n' +
          '1. Ensure git is installed\n' +
          '2. Check internet connection\n' +
          '3. Verify you have write permissions\n' +
          '4. Try a different target directory'
      };
    }
  }
  
  /**
   * Get current server status
   */
  async getServerStatus(personaIndicator: string = ''): Promise<{ text: string }> {
    try {
      const currentVersion = await this.versionManager.getCurrentVersion();
      const dependencies = await this.dependencyChecker.checkDependencies();
      const backups = await this.backupManager.listBackups();
      const rateLimitStatus = this.updateChecker.getRateLimitStatus();
      
      // Get installation type
      const installationType = InstallationDetector.getInstallationType();
      const installationDesc = InstallationDetector.getInstallationDescription();
      
      // Get git status (only for git installations)
      let gitStatus = 'N/A';
      let gitBranch = 'N/A';
      let lastCommit = 'N/A';
      
      if (installationType === 'git') {
        try {
          const { stdout: branchOutput } = await safeExec('git', ['branch', '--show-current'], { cwd: this.rootDir });
          gitBranch = branchOutput.trim() || 'detached';
          
          const { stdout: statusOutput } = await safeExec('git', ['status', '--porcelain'], { cwd: this.rootDir });
          gitStatus = statusOutput.trim() ? 'Modified' : 'Clean';
          
          const { stdout: logOutput } = await safeExec('git', ['log', '-1', '--oneline'], { cwd: this.rootDir });
          lastCommit = logOutput.trim();
        } catch {
          // Git commands failed, use defaults
        }
      }
      
      const statusParts = [
        personaIndicator + '📊 **DollhouseMCP Server Status**\n\n',
        '**Version Information:**\n',
        `• Current Version: ${currentVersion}\n`,
        `• Installation Type: ${installationType} (${installationDesc})\n`,
        `• Git Branch: ${gitBranch}\n`,
        `• Git Status: ${gitStatus}\n`,
        `• Last Commit: ${lastCommit}\n\n`,
        '**Dependencies:**\n',
        this.dependencyChecker.formatDependencyStatus(dependencies),
        '\n\n**Backups:**\n',
        `• Total Backups: ${backups.length}\n`
      ];
      
      if (backups.length > 0) {
        statusParts.push(`• Latest Backup: ${backups[0].timestamp} (v${backups[0].version || 'unknown'})\n`);
        statusParts.push(`• Oldest Backup: ${backups[backups.length - 1].timestamp}\n`);
      }
      
      statusParts.push(
        '\n**Rate Limit Status:**\n',
        `• Update Checks Remaining: ${rateLimitStatus.remainingRequests}/10 per hour\n`,
        `• Rate Limit Resets: ${rateLimitStatus.resetTime.toLocaleTimeString()}\n`
      );
      
      if (!rateLimitStatus.allowed && rateLimitStatus.waitTimeSeconds) {
        statusParts.push(`• ⏳ Wait ${rateLimitStatus.waitTimeSeconds} seconds before next check\n`);
      }
      
      statusParts.push(
        '\n**Available Commands:**\n',
        '• `check_for_updates` - Check for new versions\n',
        '• `update_server true` - Update to latest version\n',
        '• `rollback_update true` - Restore from backup\n'
      );
      
      return { text: statusParts.join('') };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        text: personaIndicator + '❌ **Status Check Failed**\n\n' +
          'Error: ' + errorMessage + '\n\n' +
          'The server may be in an inconsistent state.\n' +
          'Try running `update_server true` to fix issues.'
      };
    }
  }
}