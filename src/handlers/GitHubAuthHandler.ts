
/**
 * FIX: DMCP-SEC-006 - Security audit suppression
 * This handler delegates authentication operations to GitHubAuthManager.
 * Audit logging happens in GitHubAuthManager for auth operations.
 * @security-audit-suppress DMCP-SEC-006
 */

import { GitHubAuthManager, DeviceCodeResponse } from '../auth/GitHubAuthManager.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { logger } from '../utils/logger.js';
import { fileURLToPath } from 'url';
import * as path from 'path';
import { homedir } from 'os';
import * as child_process from 'child_process';
import { InitializationService } from '../services/InitializationService.js';
import { PersonaIndicatorService } from '../services/PersonaIndicatorService.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { FileOperationsService } from '../services/FileOperationsService.js';

export class GitHubAuthHandler {
    constructor(
        private readonly githubAuthManager: GitHubAuthManager,
        private readonly configManager: ConfigManager,
        private readonly initService: InitializationService,
        private readonly indicatorService: PersonaIndicatorService,
        private readonly fileOperations: FileOperationsService
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
          // Check current auth status first
          const currentStatus = await this.githubAuthManager.getAuthStatus();
          
          if (currentStatus.isAuthenticated) {
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
          
          // FIX: DMCP-SEC-006 - Add security audit logging for authentication initiation
          SecurityMonitor.logSecurityEvent({
            type: 'AUTH_FLOW_INITIATED',
            severity: 'LOW',
            source: 'GitHubAuthHandler.setupGitHubAuth',
            details: 'GitHub authentication flow initiated via device code',
            additionalData: { authFlow: 'device-code' }
          });

          // Initiate device flow
          let deviceResponse: DeviceCodeResponse;
          try {
            deviceResponse = await this.githubAuthManager.initiateDeviceFlow();
          } catch (deviceFlowError) {
            logger.error('OAUTH_INDEX_2681: Failed to initiate device flow', { error: deviceFlowError });
            throw new Error(`OAUTH_INDEX_2681: Device flow initiation failed - ${deviceFlowError instanceof Error ? deviceFlowError.message : 'Unknown error'}`);
          }
          
          // CRITICAL FIX: Use helper process approach from PR #518
          // MCP servers are stateless and terminate after returning response
          // The helper process survives MCP termination and can complete OAuth polling
          
          // Get the OAuth client ID - use the same method that has the default fallback
          // This ensures we get the default client ID if no env/config is set
          logger.debug('OAUTH_STEP_4: Getting client ID for helper process');
          const clientId = await this.githubAuthManager.resolveClientId();
          logger.debug('OAUTH_STEP_5: Client ID obtained', { clientId: clientId?.substring(0, 8) + '...' });
          
          if (!clientId) {
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
          
          let helperPath: string | null = null;
          try {
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            
            const overrideHelper = process.env.DOLLHOUSE_OAUTH_HELPER;
            const possiblePaths = [
              path.join(__dirname, '..', 'oauth-helper.mjs'),
              path.join(process.cwd(), 'oauth-helper.mjs'),
              path.join(__dirname, 'oauth-helper.mjs'),
              path.join(__dirname, '..', '..', 'oauth-helper.mjs')
            ];
            if (overrideHelper) {
              possiblePaths.unshift(overrideHelper);
            }
            
            helperPath = null;
            for (const testPath of possiblePaths) {
              if (await this.fileOperations.exists(testPath)) {
                helperPath = testPath;
                break;
              }
            }
            
            if (!helperPath) {
              logger.error('OAUTH_INDEX_2734: oauth-helper.mjs not found', { 
                searchedPaths: possiblePaths,
                cwd: process.cwd(),
                dirname: __dirname
              });
              throw new Error(`OAUTH_HELPER_NOT_FOUND: oauth-helper.mjs not found at line 2734. Searched: ${possiblePaths.join(', ')}`);
            }
            
            logger.debug('OAUTH_STEP_6: Spawning helper process', { 
              helperPath,
              clientId: clientId?.substring(0, 8) + '...',
              deviceCode: deviceResponse.device_code.substring(0, 8) + '...' 
            });
            
            const helper = this.spawnHelperProcess(helperPath, deviceResponse, clientId);
            
            helper.unref();
            
            logger.debug('OAUTH_STEP_7: Helper process spawned successfully', { pid: helper.pid });
            
            logger.info('OAuth helper process spawned', {
              pid: helper.pid,
              expiresIn: deviceResponse.expires_in,
              userCode: deviceResponse.user_code
            });
            
            const stateFile = path.join(this.getDollhouseHomeDir(), '.dollhouse', '.auth', 'oauth-helper-state.json');
            const stateDir = path.dirname(stateFile);
            await this.fileOperations.createDirectory(stateDir);
            
            const state = {
              pid: helper.pid,
              deviceCode: deviceResponse.device_code,
              userCode: deviceResponse.user_code,
              startTime: new Date().toISOString(),
              expiresAt: new Date(Date.now() + deviceResponse.expires_in * 1000).toISOString()
            };

            await this.fileOperations.writeFile(stateFile, JSON.stringify(state, null, 2), {
              source: 'GitHubAuthHandler.setupGitHubAuth'
            });
            
          } catch (spawnError) {
            logger.error('OAUTH_INDEX_2774: Failed to spawn OAuth helper process', { 
              error: spawnError,
              helperPath,
              clientId: clientId?.substring(0, 8) + '...',
              errorCode: (spawnError as any)?.code,
              syscall: (spawnError as any)?.syscall
            });
            
            let errorDetail = '';
            if (spawnError instanceof Error) {
              if (spawnError.message.includes('ENOENT')) {
                errorDetail = `OAUTH_HELPER_SPAWN_ENOENT: Node.js executable not found or helper script missing at ${helperPath}`;
              } else if (spawnError.message.includes('EACCES')) {
                errorDetail = `OAUTH_HELPER_SPAWN_EACCES: Permission denied when trying to execute ${helperPath}`;
              } else if (spawnError.message.includes('E2BIG')) {
                errorDetail = `OAUTH_HELPER_SPAWN_E2BIG: Argument list too long for helper process`;
              } else {
                errorDetail = `OAUTH_HELPER_SPAWN_FAILED: Could not start background authentication process at line 2774 - ${spawnError.message}`;
              }
            } else {
              errorDetail = `OAUTH_HELPER_SPAWN_UNKNOWN: Unknown spawn error at line 2774`;
            }
            
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
          
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const hasErrorCode = errorMessage.includes('OAUTH_');
          
          return {
            content: [{
              type: "text",
              text: this.prefix(
                `❌ **Authentication Setup Failed**\n\n` +
                `${hasErrorCode ? errorMessage : `OAUTH_INDEX_2806: Unable to start GitHub authentication - ${errorMessage}`}\n\n` +
                `${!errorMessage.includes('OAUTH_NETWORK') ? 'Please check your internet connection and try again.' : ''}`
              )
            }]
          };
        }
    }

    async checkGitHubAuth() {
        await this.ensureInitialized();
        try {
          const helperHealth = await this.checkOAuthHelperHealth();
          const status = await this.githubAuthManager.getAuthStatus();
          
          if (status.isAuthenticated) {
            if (helperHealth.exists) {
              const stateFile = path.join(this.getDollhouseHomeDir(), '.dollhouse', '.auth', 'oauth-helper-state.json');
              // FileOperationsService.deleteFile already handles ENOENT gracefully
              await this.fileOperations.deleteFile(stateFile).catch(() => {}); // Preserve error swallowing pattern
            }
            
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
          } else if (helperHealth.isActive) {
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
          } else if (helperHealth.exists && helperHealth.expired) {
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
          } else if (status.hasToken) {
            return {
              content: [{
                type: "text",
                text: this.prefix(`⚠️ **GitHub Token Invalid**\n\n`) +
                      `A GitHub token was found but it appears to be invalid or expired.\n\n` +
                      `**To fix this:**\n` +
                      `1. Say "set up GitHub" to authenticate again\n` +
                      `2. Or check your GITHUB_TOKEN environment variable\n\n` +
                      `Note: Browse and install still work without authentication!`
              }]
            };
          } else {
            return {
              content: [{
                type: "text",
                text: this.prefix(`🔒 **Not Connected to GitHub**\n\n`) +
                      `You're not currently authenticated with GitHub.\n\n` +
                      `**What works without auth:**\n` +
                      `✅ Browse the public collection\n` +
                      `✅ Install community content\n` +
                      `❌ Submit your own content (requires auth)\n\n` +
                      `To connect, just say "set up GitHub" or "connect to GitHub"`
              }]
            };
          }
        } catch (error) {
          logger.error('Failed to check GitHub auth', { error });
          return {
            content: [{
              type: "text",
              text: this.prefix(`❌ **Unable to Check Authentication**\n\n`) +
                    `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
            }]
          };
        }
    }

    async getOAuthHelperStatus(verbose: boolean = false) {
        await this.ensureInitialized();
        try {
          const health = await this.checkOAuthHelperHealth();
          const homeDir = this.getDollhouseHomeDir();
          const stateFile = path.join(homeDir, '.dollhouse', '.auth', 'oauth-helper-state.json');
          const logFile = path.join(homeDir, '.dollhouse', 'oauth-helper.log');
          const pidFile = path.join(homeDir, '.dollhouse', '.auth', 'oauth-helper.pid');
          
          let statusText = `📊 **OAuth Helper Process Diagnostics**\n\n`;
          
          if (!health.exists) {
            statusText += `**Status:** No OAuth process detected\n`
            statusText += `**State File:** Not found\n\n`
            statusText += `No active authentication process. Run \`setup_github_auth\` to start one.\n`;
          } else if (health.isActive) {
            statusText += `**Status:** 🟢 ACTIVE - Authentication in progress\n`
            statusText += `**User Code:** ${health.userCode}\n`
            statusText += `**Process ID:** ${health.pid}\n`
            statusText += `**Process Alive:** ${health.processAlive ? '✅ Yes' : '❌ No (may have crashed)'}\n`
            statusText += `**Started:** ${health.startTime?.toLocaleString()}\n`
            statusText += `**Expires:** ${health.expiresAt?.toLocaleString()}\n`
            statusText += `**Time Remaining:** ${Math.floor(health.timeRemaining / 60)}m ${health.timeRemaining % 60}s\n\n`
            
            if (!health.processAlive) {
              statusText += `⚠️ **WARNING:** Process appears to have stopped!\n`
              statusText += `The helper process (PID ${health.pid}) is not responding.\n`
              statusText += `You may need to run 
setup_github_auth
 again.\n\n`
            }
          } else if (health.expired) {
            statusText += `**Status:** 🔴 EXPIRED\n`
            statusText += `**User Code:** ${health.userCode} (expired)\n`
            statusText += `**Process ID:** ${health.pid}\n`
            statusText += `**Started:** ${health.startTime?.toLocaleString()}\n`
            statusText += `**Expired:** ${health.expiresAt?.toLocaleString()}\n\n`
            statusText += `The authentication request has expired. Run 
setup_github_auth
 to try again.\n\n`
          }
          
          statusText += `**📁 File Locations:**\n`
          statusText += `• State: ${stateFile}\n`
          statusText += `• Log: ${logFile} ${health.hasLog ? '(exists)' : '(not found)'}\n`
          statusText += `• PID: ${pidFile}\n\n`
          
          if (health.errorLog) {
            statusText += `**⚠️ Recent Errors:**\n\`\`\`\n${health.errorLog}\n\`\`\`\n\n`;
          }
          
          if (verbose && health.hasLog) {
            try {
              const fullLog = await this.fileOperations.readFile(logFile, {
                source: 'GitHubAuthHandler.getOAuthHelperStatus'
              });
              const lines = fullLog.split('\n').filter(line => line.trim());
              const recentLines = lines.slice(-20);

              statusText += `**📜 Recent Log Output (last 20 lines):**\n\`\`\`\n`;
              statusText += recentLines.join('\n');
              statusText += `\n\`\`\`\n\n`;
            } catch {
              statusText += `**📜 Log:** Unable to read log file\n\n`;
            }
          }
          
          if (health.exists && !health.processAlive && !health.expired) {
            statusText += `**🔧 Troubleshooting Tips:**\n`
            statusText += `1. The helper process may have crashed\n`
            statusText += `2. Check the log file for errors: ${logFile}\n`
            statusText += `3. Try running 
setup_github_auth
 again\n`
            statusText += `4. Ensure DOLLHOUSE_GITHUB_CLIENT_ID is set\n`
            statusText += `5. Check your internet connection\n`
          }
          
          if (health.exists && (health.expired || !health.processAlive)) {
            statusText += `\n**🧹 Manual Cleanup (if needed):**\n`
            statusText += '```bash'
            statusText += `rm "${stateFile}"\n`
            statusText += `rm "${logFile}"\n`
            statusText += `rm "${pidFile}"\n`
            statusText += '```';
          }
          
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
              text: this.prefix(`❌ **Failed to Get OAuth Helper Status**\n\n`) +
                    `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
            }]
          };
        }
    }

    private async checkOAuthHelperHealth() {
        const homeDir = this.getDollhouseHomeDir();
        const stateFile = path.join(homeDir, '.dollhouse', '.auth', 'oauth-helper-state.json');
        const logFile = path.join(homeDir, '.dollhouse', 'oauth-helper.log');
        
        const health = {
          exists: false,
          isActive: false,
          expired: false,
          processAlive: false,
          hasLog: false,
          userCode: '',
          timeRemaining: 0,
          pid: 0,
          startTime: null as Date | null,
          expiresAt: null as Date | null,
          errorLog: ''
        };
        
        try {
          const stateData = await this.fileOperations.readFile(stateFile, {
            source: 'GitHubAuthHandler.checkOAuthHelperHealth'
          });
          const state = JSON.parse(stateData);
          health.exists = true;
          health.pid = state.pid;
          health.userCode = state.userCode;
          health.startTime = new Date(state.startTime);
          health.expiresAt = new Date(state.expiresAt);

          const now = new Date();
          if (health.expiresAt > now) {
            health.isActive = true;
            health.timeRemaining = Math.ceil((health.expiresAt.getTime() - now.getTime()) / 1000);

            // Check if process is alive (only reliable on non-Windows platforms)
            if (process.platform !== 'win32') {
              try {
                process.kill(health.pid, 0); // Signal 0 checks existence without killing
                health.processAlive = true;
              } catch {
                health.processAlive = false;
              }
            } else {
              // On Windows, process.kill(pid, 0) is not reliable for checking existence.
              // We'll assume it's alive if the state file exists and hasn't expired.
              // A more robust check would involve platform-specific process management.
              health.processAlive = true;
            }
          } else {
            health.expired = true;
          }

          // Check if log file exists
          health.hasLog = await this.fileOperations.exists(logFile);

          // Read error log if process is dead or expired, or if verbose mode is on
          if (health.hasLog && (!health.processAlive || health.expired)) {
            try {
              const logContent = await this.fileOperations.readFile(logFile, {
                source: 'GitHubAuthHandler.checkOAuthHelperHealth'
              });
              const lines = logContent.split('\n');
              const importantLines = lines.filter(line =>
                line.toLowerCase().includes('error') ||
                line.toLowerCase().includes('fail') ||
                line.includes('❌') ||
                line.includes('⚠️')
              ).slice(-10); // Get last 10 relevant lines

              if (importantLines.length > 0) {
                health.errorLog = importantLines.join('\n');
              }
            } catch {
              // Intentionally empty - ignore if log file read fails
            }
          }

        } catch (error) {
          // If state file is not found (ENOENT), it's expected, so don't log as debug
          if (error instanceof Error && error.message.includes('ENOENT')) {
            // Intentionally empty - ENOENT is expected when state file doesn't exist yet
          } else {
            logger.debug('Error reading OAuth helper state', { error });
          }
        }
        
        return health;
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
                    `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
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
            const currentClientId = await this.githubAuthManager.resolveClientId();
            
            if (currentClientId) {
              const configuredClientId = configManager.getGitHubClientId();
              const isUsingDefault = !configuredClientId;
              
              const maskedClientId = currentClientId.substring(0, 10) + '...';
              
              return {
                content: [{
                  type: "text",
                  text: this.prefix(`✅ **GitHub OAuth Configuration**\n\n`) +
                        `**Current Status:** ${isUsingDefault ? 'Using Default' : 'Configured'}\n` +
                        `**Client ID:** ${maskedClientId}\n` +
                        `**Source:** ${isUsingDefault ? 'Built-in DollhouseMCP OAuth App' : 'Custom Configuration'}\n\n` +
                        `Your GitHub OAuth is ready to use! You can now:\n` +
                        `• Run setup_github_auth to connect\n` +
                        `• Submit content to the collection\n` +
                        `• Access authenticated features\n\n` +
                        (isUsingDefault ? 
                          `**Note:** Using the default DollhouseMCP OAuth app.\n` +
                          `To use your own OAuth app, provide a client_id parameter.\n\n` : 
                          `To update the configuration, provide a new client_id parameter.\n\n`)
                }]
              };
            } else {
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
          }
          
          if (!ConfigManager.validateClientId(client_id)) {
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
          
          await configManager.setGitHubClientId(client_id);
          
          const maskedClientId = client_id.substring(0, 10) + '...';
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
          
        } catch (error) {
          logger.error('Failed to configure OAuth', { error });
          return {
            content: [{
              type: "text",
              text: this.prefix(`❌ **OAuth Configuration Failed**\n\n`) +
                    `Error: ${error instanceof Error ? error.message : 'Unknown error'}\n\n` +
                    `Please check:\n` +
                    `• File permissions for ~/.dollhouse/config.json\n` +
                    `• Valid client ID format (starts with "Ov23li")\n` +
                    `• Available disk space`
            }]
          };
        }
    }

    private spawnHelperProcess(helperPath: string, deviceResponse: DeviceCodeResponse, clientId: string) {
        return child_process.spawn('node', [
            helperPath,
            deviceResponse.device_code,
            (deviceResponse.interval || 5).toString(),
            deviceResponse.expires_in.toString(),
            clientId
        ], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
    }

    private getDollhouseHomeDir(): string {
        return process.env.DOLLHOUSE_HOME_DIR || homedir();
    }
}
