
/**
 * FIX: DMCP-SEC-006 - Security audit suppression
 * This handler delegates authentication operations to GitHubAuthManager.
 * Audit logging happens in GitHubAuthManager for auth operations.
 * @security-audit-suppress DMCP-SEC-006
 */

import { GitHubAuthManager, DeviceCodeResponse } from '../auth/GitHubAuthManager.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { logger } from '../utils/logger.js';
import { PackageResourceLocator } from '../paths/PackageResourceLocator.js';
import * as path from 'path';
import { homedir } from 'os';
import { randomUUID } from 'node:crypto';
import * as child_process from 'child_process';
import { InitializationService } from '../services/InitializationService.js';
import { PersonaIndicatorService } from '../services/PersonaIndicatorService.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { FileOperationsService } from '../services/FileOperationsService.js';
import type { PathService } from '../paths/PathService.js';
import { withOAuthStateLock } from '../utils/OAuthStateCoordinator.js';

const UNKNOWN_ERROR = 'Unknown error';

type OAuthHelperTerminalStatus = 'success' | 'failed' | 'expired' | 'denied' | 'timeout';

interface OAuthHelperTerminalResult {
    status: OAuthHelperTerminalStatus;
    attempts?: number;
    completedAt?: string;
    errorCode?: string;
    message?: string;
    flowId?: string;
    pid?: number;
}

interface OAuthHelperState {
    pid: number;
    flowId?: string;
    userCode: string;
    startTime: string;
    expiresAt: string;
}

export class GitHubAuthHandler {
    constructor(
        private readonly githubAuthManager: GitHubAuthManager,
        private readonly configManager: ConfigManager,
        private readonly initService: InitializationService,
        private readonly indicatorService: PersonaIndicatorService,
        private readonly fileOperations: FileOperationsService,
        private readonly pathService?: PathService
    ) {}

    private async ensureInitialized(): Promise<void> {
        await this.initService.ensureInitialized();
    }

    private prefix(message: string): string {
        return `${this.indicatorService.getPersonaIndicator()}${message}`;
    }

    async setupGitHubAuth() {
        await this.ensureInitialized();
        try {
          await this.cleanupLegacyPendingToken('setupGitHubAuth');
          const currentStatus = await this.githubAuthManager.getAuthStatus();
          if (currentStatus.isAuthenticated) {
            return this.alreadyConnectedResponse(currentStatus);
          }

          this.logAuthFlowInitiated();
          const deviceResponse = await this.initiateDeviceFlowForSetup();
          const clientId = await this.resolveHelperClientId();
          if (!clientId) return this.missingClientIdResponse();
          const spawnFailure = await this.startOAuthHelper(deviceResponse, clientId);
          if (spawnFailure) return spawnFailure;

          return {
            content: [{
              type: "text",
              text: this.githubAuthManager.formatAuthInstructions(deviceResponse) +
                    '\n\n📝 **Note**: Authentication will complete automatically once you authorize. ' +
                    'Your token will be stored securely for future use!'
            }]
          };
        } catch (error) {
          logger.error('OAUTH_INDEX_2806: Main catch block - authentication setup failed', {
            error,
            errorType: error?.constructor?.name,
            errorMessage: error instanceof Error ? error.message : 'Unknown'
          });

          const errorMessage = error instanceof Error ? error.message : UNKNOWN_ERROR;

          return {
            content: [{
              type: "text",
              text: this.prefix(this.formatAuthenticationSetupFailure(errorMessage))
            }]
          };
        }
    }

    private formatAuthenticationSetupFailure(errorMessage: string): string {
        const message = errorMessage.includes('OAUTH_')
          ? errorMessage
          : `OAUTH_INDEX_2806: Unable to start GitHub authentication - ${errorMessage}`;
        const retryHint = errorMessage.includes('OAUTH_NETWORK')
          ? ''
          : 'Please check your internet connection and try again.';

        return `❌ **Authentication Setup Failed**\n\n` +
          `${message}\n\n` +
          retryHint;
    }

    private alreadyConnectedResponse(currentStatus: Awaited<ReturnType<GitHubAuthManager['getAuthStatus']>>) {
        return {
          content: [{
            type: "text",
            text: this.prefix(
              `✅ **Already Connected to GitHub**\n\n` +
              `👤 **Username:** ${currentStatus.username}\n` +
              `🔑 **Permissions:** ${currentStatus.scopes?.join(', ') || 'basic access'}\n\n` +
              `You're all set! You can:\n` +
              `• Browse the collection\n` +
              `• Install content\n` +
              `• Submit your creations\n\n` +
              `To disconnect, say "disconnect from GitHub"`
            )
          }]
        };
    }

    private logAuthFlowInitiated(): void {
        SecurityMonitor.logSecurityEvent({
          type: 'AUTH_FLOW_INITIATED',
          severity: 'LOW',
          source: 'GitHubAuthHandler.setupGitHubAuth',
          details: 'GitHub authentication flow initiated via device code',
          additionalData: { authFlow: 'device-code' }
        });
    }

    private async initiateDeviceFlowForSetup(): Promise<DeviceCodeResponse> {
        try {
          return await this.githubAuthManager.initiateDeviceFlow();
        } catch (deviceFlowError) {
          logger.error('OAUTH_INDEX_2681: Failed to initiate device flow', { error: deviceFlowError });
          throw new Error(`OAUTH_INDEX_2681: Device flow initiation failed - ${deviceFlowError instanceof Error ? deviceFlowError.message : UNKNOWN_ERROR}`);
        }
    }

    private async resolveHelperClientId(): Promise<string | null> {
        logger.debug('OAUTH_STEP_4: Getting client ID for helper process');
        const clientId = await this.githubAuthManager.resolveClientId();
        logger.debug('OAUTH_STEP_5: Client ID obtained', { clientId: clientId?.substring(0, 8) + '...' });
        return clientId;
    }

    private missingClientIdResponse() {
        return {
          content: [{
            type: "text",
            text: this.prefix(
              `❌ **GitHub OAuth Configuration Error**\n\n` +
              `Unable to obtain GitHub OAuth client ID.\n\n` +
              `This is unexpected - please report this issue.\n\n` +
              `**Workaround:**\n` +
              `• Set environment variable: DOLLHOUSE_GITHUB_CLIENT_ID\n` +
              `• Or use GitHub CLI: gh auth login --web`
            )
          }]
        };
    }

    private async startOAuthHelper(deviceResponse: DeviceCodeResponse, clientId: string) {
        let helperPath: string | null = null;
        try {
          helperPath = await this.findOAuthHelperPath();
          this.logSpawningOAuthHelper(helperPath, clientId, deviceResponse);
          const flowId = randomUUID();
          await this.prepareOAuthHelperState(deviceResponse, flowId);

          let helper: child_process.ChildProcess;
          try {
            helper = this.spawnHelperProcess(helperPath, deviceResponse, clientId, flowId);
          } catch (spawnError) {
            await this.cleanupPreparedOAuthHelperState(flowId);
            throw spawnError;
          }

          this.monitorOAuthHelperLifecycle(helper, flowId);
          helper.unref();
          this.logOAuthHelperSpawned(helper.pid, deviceResponse);
          return null;
        } catch (spawnError) {
          return this.oauthHelperLaunchFailedResponse(spawnError, helperPath, clientId);
        }
    }

    private async findOAuthHelperPath(): Promise<string> {
        const locator = new PackageResourceLocator();
        const pkgRoot = locator.getPackageRoot();
        const possiblePaths = this.getOAuthHelperCandidatePaths(pkgRoot);

        for (const testPath of possiblePaths) {
          if (await this.fileOperations.exists(testPath)) return testPath;
        }

        logger.error('OAUTH_INDEX_2734: oauth-helper.mjs not found', {
          searchedPaths: possiblePaths,
          packageRoot: pkgRoot,
        });
        throw new Error(`OAUTH_HELPER_NOT_FOUND: oauth-helper.mjs not found at line 2734. Searched: ${possiblePaths.join(', ')}`);
    }

    private getOAuthHelperCandidatePaths(pkgRoot: string): string[] {
        const possiblePaths = [
          path.join(pkgRoot, 'dist', 'oauth-helper.mjs'),
          path.join(pkgRoot, 'src', 'oauth-helper.mjs'),
          path.join(pkgRoot, 'oauth-helper.mjs'),
        ];
        const overrideHelper = process.env.DOLLHOUSE_OAUTH_HELPER;
        if (overrideHelper) possiblePaths.unshift(overrideHelper);
        return possiblePaths;
    }

    private logSpawningOAuthHelper(helperPath: string, clientId: string, deviceResponse: DeviceCodeResponse): void {
        logger.debug('OAUTH_STEP_6: Spawning helper process', {
          helperPath,
          clientId: clientId?.substring(0, 8) + '...',
          deviceCode: deviceResponse.device_code.substring(0, 8) + '...'
        });
    }

    private logOAuthHelperSpawned(pid: number | undefined, deviceResponse: DeviceCodeResponse): void {
        logger.debug('OAUTH_STEP_7: Helper process spawned successfully', { pid });
        logger.info('OAuth helper process spawned', {
          pid,
          expiresIn: deviceResponse.expires_in,
          userCode: deviceResponse.user_code
        });
    }

    private async prepareOAuthHelperState(deviceResponse: DeviceCodeResponse, flowId: string): Promise<void> {
        const stateFile = this.getOAuthHelperStateFile();
        const resultFile = this.getOAuthHelperResultFile();
        const stateDir = path.dirname(stateFile);
        await this.fileOperations.createDirectory(stateDir);

        // Publish the flow before spawning. The helper synchronously claims this
        // state with its PID before its first await, so an early signal can never
        // race a later parent-side result deletion or state write.
        const state = {
          flowId,
          userCode: deviceResponse.user_code,
          startTime: new Date().toISOString(),
          expiresAt: new Date(Date.now() + deviceResponse.expires_in * 1000).toISOString()
        };

        await withOAuthStateLock(stateFile, async () => {
          // Result deletion and generation publication are one transaction, so
          // a superseded helper cannot repopulate the shared result afterward.
          try {
            await this.fileOperations.deleteFile(resultFile);
          } catch (error) {
            if (!this.isFileNotFoundError(error)) throw error;
          }
          await this.fileOperations.writeFile(stateFile, JSON.stringify(state, null, 2), {
            source: 'GitHubAuthHandler.setupGitHubAuth'
          });
        });
    }

    private async cleanupPreparedOAuthHelperState(flowId: string): Promise<void> {
        const stateFile = this.getOAuthHelperStateFile();
        try {
          await withOAuthStateLock(stateFile, async () => {
            const stateData = await this.fileOperations.readFile(stateFile, {
              source: 'GitHubAuthHandler.startOAuthHelper'
            });
            const state = JSON.parse(stateData);
            if (this.isRecord(state) && state.flowId === flowId) {
              await this.fileOperations.deleteFile(stateFile).catch(() => {});
            }
          });
        } catch {
          // Best-effort cleanup after a spawn failure.
        }
    }

    private monitorOAuthHelperLifecycle(helper: child_process.ChildProcess, flowId: string): void {
        const cleanupFlowState = () => {
          // A successful helper removes its own state before exiting. This
          // parent-side fallback covers asynchronous spawn errors and exits
          // before the helper can claim or clean the prepared state.
          void this.cleanupPreparedOAuthHelperState(flowId);
        };

        helper.once('error', cleanupFlowState);
        helper.once('exit', cleanupFlowState);
    }

    private oauthHelperLaunchFailedResponse(spawnError: unknown, helperPath: string | null, clientId: string) {
        const spawnErr = spawnError as NodeJS.ErrnoException;
        logger.error('OAUTH_INDEX_2774: Failed to spawn OAuth helper process', {
          error: spawnError,
          helperPath,
          clientId: clientId?.substring(0, 8) + '...',
          errorCode: spawnErr.code,
          syscall: spawnErr.syscall
        });

        const errorDetail = this.formatOAuthHelperSpawnError(spawnError, helperPath);
        return {
          content: [{
            type: "text",
            text: this.prefix(
              `⚠️ **OAuth Helper Launch Failed**\n\n` +
              `${errorDetail}\n\n` +
              `**Alternative Options:**\n` +
              `1. Try again: Run setup_github_auth again\n` +
              `2. Use GitHub CLI: gh auth login --web\n` +
              `3. Set token manually: export GITHUB_TOKEN=your_token`
            )
          }]
        };
    }

    private formatOAuthHelperSpawnError(spawnError: unknown, helperPath: string | null): string {
        if (!(spawnError instanceof Error)) {
          return `OAUTH_HELPER_SPAWN_UNKNOWN: Unknown spawn error at line 2774`;
        }
        if (spawnError.message.includes('ENOENT')) {
          return `OAUTH_HELPER_SPAWN_ENOENT: Node.js executable not found or helper script missing at ${helperPath}`;
        }
        if (spawnError.message.includes('EACCES')) {
          return `OAUTH_HELPER_SPAWN_EACCES: Permission denied when trying to execute ${helperPath}`;
        }
        if (spawnError.message.includes('E2BIG')) {
          return `OAUTH_HELPER_SPAWN_E2BIG: Argument list too long for helper process`;
        }
        return `OAUTH_HELPER_SPAWN_FAILED: Could not start background authentication process at line 2774 - ${spawnError.message}`;
    }

    async checkGitHubAuth() {
        await this.ensureInitialized();
        try {
          const removedLegacyPendingToken = await this.cleanupLegacyPendingToken('checkGitHubAuth');
          const helperHealth = await this.checkOAuthHelperHealth();
          const status = await this.githubAuthManager.getAuthStatus();

          if (status.isAuthenticated) {
            await this.cleanupOAuthHelperStateIfPresent(helperHealth.exists);
            return this.githubConnectedResponse(status);
          }
          if (helperHealth.resultStatus === 'success') {
            return this.githubAuthCompletedButTokenUnavailableResponse(removedLegacyPendingToken);
          }
          if (helperHealth.resultStatus) {
            return this.githubAuthTerminalResultResponse(helperHealth, removedLegacyPendingToken);
          }
          if (helperHealth.isActive) return this.githubAuthInProgressResponse(helperHealth);
          if (helperHealth.exists && helperHealth.expired) return this.githubAuthExpiredResponse(helperHealth);
          if (status.hasToken) return this.invalidTokenResponse();
          return this.notConnectedResponse(removedLegacyPendingToken);
        } catch (error) {
          logger.error('Failed to check GitHub auth', { error });
          return {
            content: [{
              type: "text",
              text: this.prefix(
                `❌ **Unable to Check Authentication**\n\n` +
                `Error: ${error instanceof Error ? error.message : UNKNOWN_ERROR}`
              )
            }]
          };
        }
    }

    private async cleanupOAuthHelperStateIfPresent(exists: boolean): Promise<void> {
        if (!exists) return;
        const stateFile = this.getOAuthHelperStateFile();
        const resultFile = this.getOAuthHelperResultFile();
        await this.fileOperations.deleteFile(stateFile).catch(() => {}); // Preserve error swallowing pattern
        await this.fileOperations.deleteFile(resultFile).catch(() => {});
    }

    private githubConnectedResponse(status: Awaited<ReturnType<GitHubAuthManager['getAuthStatus']>>) {
        return {
          content: [{
            type: "text",
            text: this.prefix(
              `✅ **GitHub Connected**\n\n` +
              `👤 **Username:** ${status.username}\n` +
              `🔑 **Permissions:** ${status.scopes?.join(', ') || 'basic access'}\n\n` +
              `**Available Actions:**\n` +
              `✅ Browse collection\n` +
              `✅ Install content\n` +
              `✅ Submit content\n\n` +
              `Everything is working properly!`
            )
          }]
        };
    }

    private githubAuthCompletedButTokenUnavailableResponse(removedLegacyPendingToken: boolean) {
        const legacyNotice = removedLegacyPendingToken
          ? `\n\nA stale plaintext OAuth fallback file from an earlier failed flow was removed.`
          : '';

        return {
          content: [{
            type: "text",
            text: this.prefix(
              `✅ **GitHub Authentication Completed**\n\n` +
              `The OAuth helper finished successfully, but the GitHub token is not available to this server process.${legacyNotice}\n\n` +
              `**To fix this:**\n` +
              `1. Run \`check_github_auth\` again after the server refreshes\n` +
              `2. If it still fails, run \`setup_github_auth\` to authenticate again`
            )
          }]
        };
    }

    private githubAuthTerminalResultResponse(
        helperHealth: Awaited<ReturnType<GitHubAuthHandler['checkOAuthHelperHealth']>>,
        removedLegacyPendingToken: boolean,
    ) {
        const statusLabel = this.formatOAuthHelperTerminalStatus(helperHealth.resultStatus ?? 'failed');
        const lines = [
          `${statusLabel.icon} **GitHub Authentication ${statusLabel.title}**`,
          '',
          this.sanitizeOAuthHelperResultMessage(helperHealth.resultMessage) || statusLabel.defaultMessage,
          '',
          '**To try again:**',
          'Run: `setup_github_auth` to get a new code',
          ''
        ];

        if (removedLegacyPendingToken) {
          lines.push('A stale plaintext OAuth fallback file from an earlier failed flow was removed.', '');
        }

        if (helperHealth.errorLog) {
          lines.push('**Error Log:**', '```', helperHealth.errorLog, '```', '');
        }

        return {
          content: [{
            type: "text",
            text: this.prefix(lines.join('\n'))
          }]
        };
    }

    private githubAuthInProgressResponse(helperHealth: Awaited<ReturnType<GitHubAuthHandler['checkOAuthHelperHealth']>>) {
        return {
          content: [{
            type: "text",
            text: this.prefix(
              `⏳ **GitHub Authentication In Progress**\n\n` +
              `🔑 **User Code:** ${helperHealth.userCode}\n` +
              `⏱️ **Time Remaining:** ${Math.floor(helperHealth.timeRemaining / 60)}m ${helperHealth.timeRemaining % 60}s\n` +
              `🔄 **Process Status:** ${helperHealth.processAlive ? '✅ Running' : '⚠️ May have stopped'}\n` +
              `📁 **Log Available:** ${helperHealth.hasLog ? 'Yes' : 'No'}\n\n` +
              `**Waiting for you to:**\n` +
              `1. Go to: https://github.com/login/device\n` +
              `2. Enter code: **${helperHealth.userCode}**\n` +
              `3. Authorize the application\n\n` +
              `The authentication will complete automatically once you authorize.\n` +
              `Run this command again to check status.`
            )
          }]
        };
    }

    private githubAuthExpiredResponse(helperHealth: Awaited<ReturnType<GitHubAuthHandler['checkOAuthHelperHealth']>>) {
        const lines = [
          '⏱️ **Authentication Expired**',
          '',
          'The GitHub authentication request has expired.',
          `User code: ${helperHealth.userCode} (expired)`,
          '',
          '**To try again:**',
          'Run: `setup_github_auth` to get a new code',
          ''
        ];

        if (helperHealth.errorLog) {
          lines.push('**Error Log:**', '```', helperHealth.errorLog, '```', '');
        }

        return {
          content: [{
            type: "text",
            text: this.prefix(lines.join('\n'))
          }]
        };
    }

    private invalidTokenResponse() {
        return {
          content: [{
            type: "text",
            text: this.prefix(
              `⚠️ **GitHub Token Invalid**\n\n` +
              `A GitHub token was found but it appears to be invalid or expired.\n\n` +
              `**To fix this:**\n` +
              `1. Say "set up GitHub" to authenticate again\n` +
              `2. Or check your GITHUB_TOKEN environment variable\n\n` +
              `Note: Browse and install still work without authentication!`
            )
          }]
        };
    }

    private notConnectedResponse(removedLegacyPendingToken: boolean = false) {
        const legacyNotice = removedLegacyPendingToken
          ? `\n\nA stale plaintext OAuth fallback file from an earlier failed flow was removed. Please run \`setup_github_auth\` again to reconnect.`
          : '';

        return {
          content: [{
            type: "text",
            text: this.prefix(
              `🔒 **Not Connected to GitHub**\n\n` +
              `You're not currently authenticated with GitHub.\n\n` +
              `**What works without auth:**\n` +
              `✅ Browse the public collection\n` +
              `✅ Install community content\n` +
              `❌ Submit your own content (requires auth)\n\n` +
              `To connect, just say "set up GitHub" or "connect to GitHub"${legacyNotice}`
            )
          }]
        };
    }

    async getOAuthHelperStatus(verbose: boolean = false) {
        await this.ensureInitialized();
        try {
          const health = await this.checkOAuthHelperHealth();
          const stateFile = this.getOAuthHelperStateFile();
          const resultFile = this.getOAuthHelperResultFile();
          const logFile = this.getOAuthHelperLogFile();
          const pidFile = this.getOAuthHelperPidFile();

          let statusText = this.formatOAuthHelperStatus(health);
          statusText += this.formatOAuthHelperFileLocations(health, stateFile, resultFile, logFile, pidFile);
          statusText += await this.formatVerboseOAuthHelperLog(verbose, health.hasLog, logFile);
          statusText += this.formatOAuthHelperTroubleshooting(health, logFile);
          statusText += this.formatOAuthHelperCleanup(health, stateFile, resultFile, logFile, pidFile);

          return {
            content: [{
              type: "text",
              text: this.prefix(statusText)
            }]
          };

        } catch (error) {
          logger.error('Failed to get OAuth helper status', { error });
          return {
            content: [{
              type: "text",
              text: this.prefix(
                `❌ **Failed to Get OAuth Helper Status**\n\n` +
                `Error: ${error instanceof Error ? error.message : UNKNOWN_ERROR}`
              )
            }]
          };
        }
    }

    private formatOAuthHelperStatus(health: Awaited<ReturnType<GitHubAuthHandler['checkOAuthHelperHealth']>>): string {
        let statusText = `📊 **OAuth Helper Process Diagnostics**\n\n`;
        if (!health.exists) return statusText + this.formatNoOAuthHelperStatus();
        if (health.resultStatus) return statusText + this.formatTerminalOAuthHelperStatus(health);
        if (health.isActive) return statusText + this.formatActiveOAuthHelperStatus(health);
        if (health.expired) return statusText + this.formatExpiredOAuthHelperStatus(health);
        return statusText;
    }

    private formatNoOAuthHelperStatus(): string {
        return `**Status:** No OAuth process detected\n` +
          `**State File:** Not found\n\n` +
          `No active authentication process. Run \`setup_github_auth\` to start one.\n`;
    }

    private formatActiveOAuthHelperStatus(health: Awaited<ReturnType<GitHubAuthHandler['checkOAuthHelperHealth']>>): string {
        let statusText = `**Status:** 🟢 ACTIVE - Authentication in progress\n` +
          `**User Code:** ${health.userCode}\n` +
          `**Process ID:** ${health.pid}\n` +
          `**Process Alive:** ${health.processAlive ? '✅ Yes' : '❌ No (may have crashed)'}\n` +
          `**Started:** ${health.startTime?.toLocaleString()}\n` +
          `**Expires:** ${health.expiresAt?.toLocaleString()}\n` +
          `**Time Remaining:** ${Math.floor(health.timeRemaining / 60)}m ${health.timeRemaining % 60}s\n\n`;

        if (!health.processAlive) {
          statusText += `⚠️ **WARNING:** Process appears to have stopped!\n` +
            `The helper process (PID ${health.pid}) is not responding.\n` +
            `You may need to run \`setup_github_auth\` again.\n\n`;
        }
        return statusText;
    }

    private formatExpiredOAuthHelperStatus(health: Awaited<ReturnType<GitHubAuthHandler['checkOAuthHelperHealth']>>): string {
        return `**Status:** 🔴 EXPIRED\n` +
          `**User Code:** ${health.userCode} (expired)\n` +
          `**Process ID:** ${health.pid}\n` +
          `**Started:** ${health.startTime?.toLocaleString()}\n` +
          `**Expired:** ${health.expiresAt?.toLocaleString()}\n\n` +
          `The authentication request has expired. Run \`setup_github_auth\` to try again.\n\n`;
    }

    private formatTerminalOAuthHelperStatus(health: Awaited<ReturnType<GitHubAuthHandler['checkOAuthHelperHealth']>>): string {
        const statusLabel = this.formatOAuthHelperTerminalStatus(health.resultStatus ?? 'failed');
        let statusText = `**Status:** ${statusLabel.icon} ${statusLabel.title.toUpperCase()}\n`;
        if (health.userCode) statusText += `**User Code:** ${health.userCode}\n`;
        if (health.pid) statusText += `**Process ID:** ${health.pid}\n`;
        if (health.completedAt) statusText += `**Completed:** ${health.completedAt.toLocaleString()}\n`;
        if (health.resultAttempts !== undefined) statusText += `**Attempts:** ${health.resultAttempts}\n`;
        const resultMessage = this.sanitizeOAuthHelperResultMessage(health.resultMessage);
        if (resultMessage) statusText += `**Result:** ${resultMessage}\n`;
        return `${statusText}\n`;
    }

    private formatOAuthHelperFileLocations(
        health: Awaited<ReturnType<GitHubAuthHandler['checkOAuthHelperHealth']>>,
        stateFile: string,
        resultFile: string,
        logFile: string,
        pidFile: string,
    ): string {
        let statusText = `**📁 File Locations:**\n` +
          `• State: ${stateFile}\n` +
          `• Result: ${resultFile} ${health.hasResult ? '(exists)' : '(not found)'}\n` +
          `• Log: ${logFile} ${health.hasLog ? '(exists)' : '(not found)'}\n` +
          `• PID: ${pidFile}\n\n`;

        if (health.errorLog) {
          statusText += `**⚠️ Recent Errors:**\n\`\`\`\n${health.errorLog}\n\`\`\`\n\n`;
        }
        return statusText;
    }

    private async formatVerboseOAuthHelperLog(verbose: boolean, hasLog: boolean, logFile: string): Promise<string> {
        if (!verbose || !hasLog) return '';
        try {
          const fullLog = await this.fileOperations.readFile(logFile, {
            source: 'GitHubAuthHandler.getOAuthHelperStatus'
          });
          const lines = fullLog.split('\n').filter(line => line.trim());
          const recentLines = lines.slice(-20);

          return `**📜 Recent Log Output (last 20 lines):**\n\`\`\`\n` +
            recentLines.join('\n') +
            `\n\`\`\`\n\n`;
        } catch {
          return `**📜 Log:** Unable to read log file\n\n`;
        }
    }

    private formatOAuthHelperTroubleshooting(
        health: Awaited<ReturnType<GitHubAuthHandler['checkOAuthHelperHealth']>>,
        logFile: string,
    ): string {
        if (!health.exists || health.processAlive || health.expired || health.resultStatus) return '';
        const retryStep = health.hasLog ? 3 : 2;
        const clientIdStep = health.hasLog ? 4 : 3;
        const networkStep = health.hasLog ? 5 : 4;

        return `**🔧 Troubleshooting Tips:**\n` +
          `1. The helper process may have crashed\n` +
          (health.hasLog ? `2. Check the log file for errors: ${logFile}\n` : '') +
          `${retryStep}. Try running \`setup_github_auth\` again\n` +
          `${clientIdStep}. Ensure DOLLHOUSE_GITHUB_CLIENT_ID is set\n` +
          `${networkStep}. Check your internet connection\n`;
    }

    private formatOAuthHelperCleanup(
        health: Awaited<ReturnType<GitHubAuthHandler['checkOAuthHelperHealth']>>,
        stateFile: string,
        resultFile: string,
        logFile: string,
        pidFile: string,
    ): string {
        if (!health.exists || (!health.expired && health.processAlive && !health.resultStatus)) return '';
        return `\n**🧹 Manual Cleanup (if needed):**\n` +
          '```bash\n' +
          `rm "${stateFile}"\n` +
          `rm "${resultFile}"\n` +
          `rm "${logFile}"\n` +
          `rm "${pidFile}"\n` +
          '```\n';
    }

    private async checkOAuthHelperHealth() {
        const logFile = this.getOAuthHelperLogFile();
        const health = this.emptyOAuthHelperHealth();

        const state = await this.readOAuthHelperState();
        if (state) {
          this.populateOAuthHelperHealth(health, state);
        }

        const result = await this.readOAuthHelperResult();
        if (result && (!state || this.oauthHelperResultMatchesState(result, state))) {
          this.populateOAuthHelperResult(health, result);
        }

        if (state) {
          this.updateOAuthHelperActivity(health);
        }

        health.hasLog = await this.fileOperations.exists(logFile);
        health.errorLog = await this.readOAuthHelperErrorLogIfNeeded(health, logFile);

        return health;
    }

    private emptyOAuthHelperHealth() {
        return {
          exists: false,
          isActive: false,
          expired: false,
          processAlive: false,
          hasResult: false,
          hasLog: false,
          userCode: '',
          timeRemaining: 0,
          pid: 0,
          startTime: null as Date | null,
          expiresAt: null as Date | null,
          completedAt: null as Date | null,
          resultStatus: null as OAuthHelperTerminalStatus | null,
          resultMessage: '',
          resultAttempts: undefined as number | undefined,
          errorLog: ''
        };
    }

    private populateOAuthHelperResult(
        health: ReturnType<GitHubAuthHandler['emptyOAuthHelperHealth']>,
        result: OAuthHelperTerminalResult,
    ): void {
        health.exists = true;
        health.hasResult = true;
        health.resultStatus = result.status;
        health.resultMessage = result.message ?? '';
        health.resultAttempts = result.attempts;
        health.completedAt = result.completedAt ? new Date(result.completedAt) : null;
    }

    private async readOAuthHelperResult(): Promise<OAuthHelperTerminalResult | null> {
        const resultFile = this.getOAuthHelperResultFile();
        try {
          const resultData = await this.fileOperations.readFile(resultFile, {
            source: 'GitHubAuthHandler.checkOAuthHelperHealth'
          });
          return this.normalizeOAuthHelperResult(JSON.parse(resultData));
        } catch (error) {
          if (!this.isFileNotFoundError(error)) {
            logger.debug('Error reading OAuth helper result', { error });
          }
          return null;
        }
    }

    private async readOAuthHelperState(): Promise<OAuthHelperState | null> {
        const stateFile = this.getOAuthHelperStateFile();
        try {
          const stateData = await this.fileOperations.readFile(stateFile, {
            source: 'GitHubAuthHandler.checkOAuthHelperHealth'
          });
          const parsed = JSON.parse(stateData);
          if (this.isOAuthHelperState(parsed)) return parsed;
          logger.debug('OAuth helper state file had invalid shape');
        } catch (error) {
          if (!this.isFileNotFoundError(error)) {
            logger.debug('Error reading OAuth helper state', { error });
          }
        }
        return null;
    }

    private populateOAuthHelperHealth(
        health: ReturnType<GitHubAuthHandler['emptyOAuthHelperHealth']>,
        state: OAuthHelperState,
    ): void {
        health.exists = true;
        health.pid = state.pid;
        health.userCode = state.userCode;
        health.startTime = new Date(state.startTime);
        health.expiresAt = new Date(state.expiresAt);
    }

    private updateOAuthHelperActivity(health: ReturnType<GitHubAuthHandler['emptyOAuthHelperHealth']>): void {
        if (health.resultStatus) {
          health.isActive = false;
          return;
        }

        const now = new Date();
        if (health.expiresAt && health.expiresAt > now) {
          health.isActive = true;
          health.timeRemaining = Math.ceil((health.expiresAt.getTime() - now.getTime()) / 1000);
          health.processAlive = this.isOAuthHelperProcessAlive(health.pid);
          return;
        }
        health.expired = true;
    }

    private isOAuthHelperProcessAlive(pid: number): boolean {
        if (process.platform === 'win32') return true;
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return this.isProcessPermissionError(error);
        }
    }

    private isProcessPermissionError(error: unknown): boolean {
        return error instanceof Error &&
          'code' in error &&
          (error as NodeJS.ErrnoException).code === 'EPERM';
    }

    private async readOAuthHelperErrorLogIfNeeded(
        health: ReturnType<GitHubAuthHandler['emptyOAuthHelperHealth']>,
        logFile: string,
    ): Promise<string> {
        if (!health.hasLog || (health.processAlive && !health.expired && !health.resultStatus)) return '';
        try {
          const logContent = await this.fileOperations.readFile(logFile, {
            source: 'GitHubAuthHandler.checkOAuthHelperHealth'
          });
          return this.extractImportantOAuthHelperLogLines(logContent);
        } catch {
          return '';
        }
    }

    private extractImportantOAuthHelperLogLines(logContent: string): string {
        const importantLines = logContent.split('\n').filter(line =>
          line.toLowerCase().includes('error') ||
          line.toLowerCase().includes('fail') ||
          line.includes('❌') ||
          line.includes('⚠️')
        ).slice(-10);

        return importantLines.length > 0 ? importantLines.join('\n') : '';
    }

    private async cleanupLegacyPendingToken(source: string): Promise<boolean> {
        const pendingTokenFile = path.join(this.getOAuthHelperAuthDir(), 'pending_token.txt');
        try {
          if (!(await this.fileOperations.exists(pendingTokenFile))) {
            return false;
          }

          await this.fileOperations.deleteFile(pendingTokenFile, undefined, {
            source: `GitHubAuthHandler.${source}`
          });

          SecurityMonitor.logSecurityEvent({
            type: 'TOKEN_CACHE_CLEARED',
            severity: 'MEDIUM',
            source: `GitHubAuthHandler.${source}`,
            details: 'Removed stale plaintext OAuth pending token fallback file'
          });
          logger.warn('Removed stale plaintext OAuth pending token fallback file');
          return true;
        } catch (error) {
          logger.warn('Failed to remove stale OAuth pending token fallback file', { error });
          return false;
        }
    }

    private isOAuthHelperTerminalStatus(status: unknown): status is OAuthHelperTerminalStatus {
        return status === 'success' ||
               status === 'failed' ||
               status === 'expired' ||
               status === 'denied' ||
               status === 'timeout';
    }

    private normalizeOAuthHelperResult(value: unknown): OAuthHelperTerminalResult | null {
        if (!this.isRecord(value) || !this.isOAuthHelperTerminalStatus(value.status)) return null;
        return {
          status: value.status,
          attempts: typeof value.attempts === 'number' ? value.attempts : undefined,
          completedAt: typeof value.completedAt === 'string' ? value.completedAt : undefined,
          errorCode: typeof value.errorCode === 'string' ? value.errorCode : undefined,
          message: typeof value.message === 'string'
            ? this.sanitizeOAuthHelperResultMessage(value.message)
            : undefined,
          flowId: typeof value.flowId === 'string' ? value.flowId : undefined,
          pid: this.isValidOAuthHelperPid(value.pid) ? value.pid : undefined
        };
    }

    private isOAuthHelperState(value: unknown): value is OAuthHelperState {
        if (!this.isRecord(value)) return false;
        return this.isValidOAuthHelperPid(value.pid) &&
          (value.flowId === undefined || typeof value.flowId === 'string') &&
          typeof value.userCode === 'string' &&
          typeof value.startTime === 'string' &&
          typeof value.expiresAt === 'string' &&
          !Number.isNaN(new Date(value.startTime).getTime()) &&
          !Number.isNaN(new Date(value.expiresAt).getTime());
    }

    private sanitizeOAuthHelperResultMessage(message: string): string {
        const withoutControlCharacters = Array.from(message, character => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 31 ||
            codePoint === 127 ||
            (codePoint >= 0xD800 && codePoint <= 0xDFFF)
            ? ' '
            : character;
        }).join('');

        return withoutControlCharacters
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 500);
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private isValidOAuthHelperPid(value: unknown): value is number {
        return typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value > 0;
    }

    private oauthHelperResultMatchesState(result: OAuthHelperTerminalResult, state: OAuthHelperState): boolean {
        if (!state.flowId) return true;
        if (result.flowId !== state.flowId) return false;
        return typeof result.pid !== 'number' || result.pid === state.pid;
    }

    private isFileNotFoundError(error: unknown): boolean {
        return this.isRecord(error) && error.code === 'ENOENT';
    }

    private formatOAuthHelperTerminalStatus(status: OAuthHelperTerminalStatus) {
        switch (status) {
          case 'success':
            return {
              icon: '✅',
              title: 'Completed',
              defaultMessage: 'The OAuth helper completed successfully.'
            };
          case 'expired':
            return {
              icon: '⏱️',
              title: 'Expired',
              defaultMessage: 'The GitHub authentication request expired.'
            };
          case 'denied':
            return {
              icon: '🚫',
              title: 'Denied',
              defaultMessage: 'The GitHub authentication request was denied.'
            };
          case 'timeout':
            return {
              icon: '⏱️',
              title: 'Timed Out',
              defaultMessage: 'The GitHub authentication request timed out.'
            };
          case 'failed':
          default:
            return {
              icon: '❌',
              title: 'Failed',
              defaultMessage: 'The OAuth helper failed before authentication completed.'
            };
        }
    }

    async clearGitHubAuth() {
        await this.ensureInitialized();
        try {
          // FIX: DMCP-SEC-006 - Add security audit logging for authentication clearing
          SecurityMonitor.logSecurityEvent({
            type: 'TOKEN_CACHE_CLEARED',
            severity: 'LOW',
            source: 'GitHubAuthHandler.clearGitHubAuth',
            details: 'GitHub authentication credentials cleared'
          });

          await this.githubAuthManager.clearAuthentication();

          return {
            content: [{
              type: "text",
              text: this.prefix(`✅ **GitHub Disconnected**\n\n`) +
                    `Your GitHub connection has been cleared.\n\n` +
                    `**What still works:**\n` +
                    `✅ Browse the public collection\n` +
                    `✅ Install community content\n` +
                    `❌ Submit content (requires reconnection)\n\n` +
                    `To reconnect later, just say "connect to GitHub"\n\n` +
                    `⚠️ **Note:** To fully remove authentication, also unset the GITHUB_TOKEN environment variable.`
            }]
          };
        } catch (error) {
          logger.error('Failed to clear GitHub auth', { error });
          return {
            content: [{
              type: "text",
              text: this.prefix(`❌ **Failed to Clear Authentication**\n\n`) +
                    `Error: ${error instanceof Error ? error.message : UNKNOWN_ERROR}`
            }]
          };
        }
    }

    async configureOAuth(client_id?: string) {
        await this.ensureInitialized();
        try {
          const configManager = this.configManager;
          await configManager.initialize();

          if (!client_id) {
            return this.currentOAuthConfigResponse(configManager);
          }

          if (!ConfigManager.validateClientId(client_id)) {
            return this.invalidClientIdResponse();
          }

          await configManager.setGitHubClientId(client_id);
          return this.oauthConfiguredResponse(client_id);

        } catch (error) {
          logger.error('Failed to configure OAuth', { error });
          return {
            content: [{
              type: "text",
              text: this.prefix(`❌ **OAuth Configuration Failed**\n\n`) +
                    `Error: ${error instanceof Error ? error.message : UNKNOWN_ERROR}\n\n` +
                    `Please check:\n` +
                    `• File permissions for ~/.dollhouse/config.json\n` +
                    `• Valid client ID format (starts with "Ov23li")\n` +
                    `• Available disk space`
            }]
          };
        }
    }

    private async currentOAuthConfigResponse(configManager: ConfigManager) {
        const currentClientId = await this.githubAuthManager.resolveClientId();
        if (!currentClientId) return this.oauthNotConfiguredResponse();

        const configuredClientId = configManager.getGitHubClientId();
        const isUsingDefault = !configuredClientId;
        const maskedClientId = currentClientId.substring(0, 10) + '...';
        const source = isUsingDefault ? 'Built-in DollhouseMCP OAuth App' : 'Custom Configuration';
        const note = isUsingDefault
          ? `**Note:** Using the default DollhouseMCP OAuth app.\n` +
            `To use your own OAuth app, provide a client_id parameter.\n\n`
          : `To update the configuration, provide a new client_id parameter.\n\n`;

        return {
          content: [{
            type: "text",
            text: this.prefix(`✅ **GitHub OAuth Configuration**\n\n`) +
                  `**Current Status:** ${isUsingDefault ? 'Using Default' : 'Configured'}\n` +
                  `**Client ID:** ${maskedClientId}\n` +
                  `**Source:** ${source}\n\n` +
                  `Your GitHub OAuth is ready to use! You can now:\n` +
                  `• Run setup_github_auth to connect\n` +
                  `• Submit content to the collection\n` +
                  `• Access authenticated features\n\n` +
                  note
          }]
        };
    }

    private oauthNotConfiguredResponse() {
        return {
          content: [{
            type: "text",
            text: this.prefix(`⚠️ **GitHub OAuth Not Configured**\n\n`) +
                  `No GitHub OAuth client ID is currently configured.\n\n` +
                  `**To set up OAuth:**\n` +
                  `1. Create a GitHub OAuth app at: https://github.com/settings/applications/new\n` +
                  `2. Use these settings:\n` +
                  `   • Homepage URL: https://github.com/DollhouseMCP\n` +
                  `   • Authorization callback URL: http://localhost:3000/callback\n` +
                  `3. Copy your Client ID (starts with "Ov23li")\n` +
                  `4. Run: configure_oauth with your client_id parameter\n\n` +
                  `**Need help?** Check the documentation for detailed setup instructions.`
          }]
        };
    }

    private invalidClientIdResponse() {
        return {
          content: [{
            type: "text",
            text: this.prefix(`❌ **Invalid Client ID Format**\n\n`) +
                  `GitHub OAuth Client IDs must:\n` +
                  `• Start with "Ov23li"\n` +
                  `• Be followed by at least 14 alphanumeric characters\n\n` +
                  `**Example:** Ov23liABCDEFGHIJKLMN\n\n` +
                  `Please check your client ID and try again.`
          }]
        };
    }

    private oauthConfiguredResponse(clientId: string) {
        const maskedClientId = clientId.substring(0, 10) + '...';
        return {
          content: [{
            type: "text",
            text: this.prefix(`✅ **GitHub OAuth Configured Successfully**\n\n`) +
                  `**Client ID:** ${maskedClientId}\n` +
                  `**Saved to:** ~/.dollhouse/config.json\n\n` +
                  `Your GitHub OAuth is now ready! Next steps:\n` +
                  `• Run setup_github_auth to connect your account\n` +
                  `• Start submitting content to the collection\n` +
                  `• Access authenticated features\n\n` +
                  `**Note:** Your client ID is securely stored in your local config file.`
          }]
        };
    }

    private spawnHelperProcess(helperPath: string, deviceResponse: DeviceCodeResponse, clientId: string, flowId: string) {
        return child_process.spawn('node', [
            helperPath,
            deviceResponse.device_code,
            (deviceResponse.interval || 5).toString(),
            deviceResponse.expires_in.toString(),
            clientId
        ], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: {
                ...process.env,
                DOLLHOUSE_OAUTH_HELPER_AUTH_DIR: this.getOAuthHelperAuthDir(),
                DOLLHOUSE_OAUTH_HELPER_LOG_FILE: this.getOAuthHelperLogFile(),
                DOLLHOUSE_OAUTH_HELPER_FLOW_ID: flowId
            }
        });
    }

    private getOAuthHelperAuthDir(): string {
        if (this.pathService) {
            return this.pathService.getUserAuthDir();
        }
        return path.join(this.getDollhouseHomeDir(), '.dollhouse', '.auth');
    }

    private getOAuthHelperStateFile(): string {
        return path.join(this.getOAuthHelperAuthDir(), 'oauth-helper-state.json');
    }

    private getOAuthHelperResultFile(): string {
        return path.join(this.getOAuthHelperAuthDir(), 'oauth-helper-result.json');
    }

    private getOAuthHelperLogFile(): string {
        if (this.pathService) {
            return path.join(this.getOAuthHelperAuthDir(), 'oauth-helper.log');
        }
        // Preserve the legacy standalone helper log path; PathService deployments
        // pass a per-session log path to the helper through its environment.
        return path.join(this.getDollhouseHomeDir(), '.dollhouse', 'oauth-helper.log');
    }

    private getOAuthHelperPidFile(): string {
        return path.join(this.getOAuthHelperAuthDir(), 'oauth-helper.pid');
    }

    private getDollhouseHomeDir(): string {
        return process.env.DOLLHOUSE_HOME_DIR || homedir();
    }
}
