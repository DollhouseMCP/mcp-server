
import { GitHubAuthManager } from '../auth/GitHubAuthManager.js';
import { PortfolioManager, ElementType } from '../portfolio/PortfolioManager.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { SecureErrorHandler } from '../security/errorHandler.js';
import { validateUsername } from '../security/InputValidator.js';
import { PortfolioRepoManager } from '../portfolio/PortfolioRepoManager.js';
import { getPortfolioRepositoryName } from '../config/portfolioConfig.js';
import { TokenManager } from '../security/tokenManager.js';
import { PortfolioPullHandler } from './PortfolioPullHandler.js';
import { PortfolioIndexManager } from '../portfolio/PortfolioIndexManager.js';
import { UnifiedIndexManager } from '../portfolio/UnifiedIndexManager.js';
import { logger } from '../utils/logger.js';
import { ErrorHandler } from '../utils/ErrorHandler.js';
import * as path from 'path';
import { getElementIcon, getSourceIcon } from '../utils/index.js';
import { InitializationService } from '../services/InitializationService.js';
import { PersonaIndicatorService } from '../services/PersonaIndicatorService.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { FileOperationsService } from '../services/FileOperationsService.js';
import { normalizeElementType, formatElementTypesList } from '../utils/elementTypeNormalization.js';

/**
 * PortfolioHandler - Manages portfolio operations, status, configuration, and search
 *
 * Uses dependency injection for all services:
 * - InitializationService for setup tasks
 * - PersonaIndicatorService for persona indicator formatting
 * - GitHubAuthManager for authentication
 * - PortfolioManager for portfolio operations
 *
 * FIX: DMCP-SEC-006 - Security audit suppression
 * This handler delegates operations to PortfolioManager and related services.
 * Audit logging happens in the underlying services (GitHubAuthManager, PortfolioRepoManager).
 * @security-audit-suppress DMCP-SEC-006
 */
export class PortfolioHandler {
    private readonly fileOperations: FileOperationsService;
    private readonly tokenManager: TokenManager;
    private readonly portfolioRepoManager: PortfolioRepoManager;

    constructor(
        private readonly githubAuthManager: GitHubAuthManager,
        private readonly portfolioManager: PortfolioManager,
        private readonly portfolioPullHandler: PortfolioPullHandler,
        private readonly portfolioIndexManager: PortfolioIndexManager,
        private readonly unifiedIndexManager: UnifiedIndexManager,
        private readonly initService: InitializationService,
        private readonly indicatorService: PersonaIndicatorService,
        private readonly configManager: ConfigManager,
        fileOperations: FileOperationsService,
        tokenManager: TokenManager,
        portfolioRepoManager: PortfolioRepoManager
    ) {
        // Validation moved to constructor parameters with readonly
        if (!portfolioPullHandler) {
            throw new Error('PortfolioHandler requires a PortfolioPullHandler instance');
        }
        if (!portfolioIndexManager) {
            throw new Error('PortfolioHandler requires a PortfolioIndexManager instance');
        }
        if (!unifiedIndexManager) {
            throw new Error('PortfolioHandler requires a UnifiedIndexManager instance');
        }
        if (!portfolioRepoManager) {
            throw new Error('PortfolioHandler requires a PortfolioRepoManager instance');
        }
        // Initialize services
        this.fileOperations = fileOperations;
        this.tokenManager = tokenManager;
        this.portfolioRepoManager = portfolioRepoManager;
    }

    private async countElementsInDir(dirPath: string): Promise<number> {
        try {
            const exists = await this.fileOperations.exists(dirPath);
            if (!exists) {
                return 0;
            }
            const files = await this.fileOperations.listDirectory(dirPath);
            return files.filter(file =>
                file.endsWith('.md') ||
                file.endsWith('.json') ||
                file.endsWith('.yaml')
            ).length;
        } catch {
            return 0;
        }
    }

    private async getElementsList(elementType: string): Promise<string[]> {
        const elementTypeEnum = normalizeElementType(elementType);
        if (!elementTypeEnum) {
            throw new Error(`Invalid element type: '${elementType}'. Valid types are: ${formatElementTypesList()}`);
        }

        const dirPath = this.portfolioManager.getElementDir(elementTypeEnum);

        try {
            const exists = await this.fileOperations.exists(dirPath);
            if (!exists) {
                logger.debug(`[PortfolioHandler] Element directory doesn't exist yet: ${dirPath}`);
                return [];
            }
            const files = await this.fileOperations.listDirectory(dirPath);

            return files
                .filter(file => file.endsWith('.md') || file.endsWith('.json') || file.endsWith('.yaml'))
                .map(file => file.replace(/\.(md|json|yaml)$/i, ''));
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                logger.debug(`[PortfolioHandler] Element directory doesn't exist yet: ${dirPath}`);
                return [];
            }

            logger.warn('Error in getElementsList', {
                elementType,
                error: error.message,
                code: error.code,
            });

            throw new Error(
                error.code === 'ENOENT'
                    ? `Element directory not found for type '${elementType}'. Directory may not exist yet.`
                    : `Failed to read elements directory for type '${elementType}': ${error.message || 'Unknown file system error'}`
            );
        }
    }

    private async loadElementByType(elementName: string, elementType: string): Promise<any> {
        const sanitizedName = path.basename(elementName);

        const elementTypeEnum = normalizeElementType(elementType);
        if (!elementTypeEnum) {
            throw new Error(`Invalid element type: '${elementType}'. Valid types are: ${formatElementTypesList()}`);
        }

        const dirPath = this.portfolioManager.getElementDir(elementTypeEnum);
        const extensions = ['.md', '.json', '.yaml', '.yml'];
        const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

        let content: string | null = null;
        let foundFile: string | null = null;

        for (const ext of extensions) {
            const filePath = path.join(dirPath, `${sanitizedName}${ext}`);
            try {
                const stats = await this.fileOperations.stat(filePath);
                if (stats.size > MAX_FILE_SIZE) {
                    throw new Error(`File size exceeds limit of 10MB: ${stats.size} bytes`);
                }

                content = await this.fileOperations.readFile(filePath, {
                    encoding: 'utf-8',
                    source: 'PortfolioHandler.loadElementByType'
                });
                foundFile = filePath;
                break;
            } catch (err: any) {
                if (err.code !== 'ENOENT') {
                    throw err;
                }
            }
        }

        if (!foundFile) {
            throw Object.assign(new Error('File not found'), { code: 'ENOENT' });
        }

        return {
            id: `${elementType}_${sanitizedName}_${Date.now()}`,
            type: elementTypeEnum,
            version: '1.0.0',
            metadata: {
                name: sanitizedName,
                description: `Loaded from ${path.basename(foundFile)}`,
                author: 'unknown',
                created: new Date().toISOString(),
                modified: new Date().toISOString(),
                tags: [],
            },
            validate: () => ({
                isValid: true,
                errors: [] as any[],
                warnings: [] as any[],
            }),
            serialize: () => content || '',
            deserialize: () => {},
            getStatus: () => ({ status: 'active' as const }),
            content: content || '',
            filename: path.basename(foundFile),
        } as any;
    }

    async portfolioStatus(username?: string) {
        try {
          // FIX: DMCP-SEC-006 - Add security audit logging for portfolio access
          SecurityMonitor.logSecurityEvent({
            type: 'PORTFOLIO_FETCH_SUCCESS',
            severity: 'LOW',
            source: 'PortfolioHandler.portfolioStatus',
            details: `Portfolio status check for ${username || 'current user'}`
          });

          // Validate username parameter if provided
          if (username && typeof username === 'string') {
            try {
              validateUsername(username);
            } catch (error) {
              return {
                content: [{
                  type: "text",
                  text: `${this.indicatorService.getPersonaIndicator()}❌ Invalid username: ${error instanceof Error ? error.message : 'Validation failed'}`
                }]
              };
            }
          }
    
          // Get current user if username not provided
          let targetUsername = username;
          if (!targetUsername) {
            const authStatus = await this.githubAuthManager.getAuthStatus();
            if (!authStatus.isAuthenticated || !authStatus.username) {
              return {
                content: [{
                  type: "text",
                  text: `${this.indicatorService.getPersonaIndicator()}❌ **GitHub Authentication Required**\n\n` +
                `🔐 **Quick Setup**:\n` +
                `1. Run: \`setup_github_auth\` to authenticate\n` +
                `2. Or use: \`gh auth login --web\` if you have GitHub CLI\n\n` +
                `📝 **What this enables**:\n` +
                `• Upload elements to your GitHub portfolio\n` +
                `• Sync your local portfolio with GitHub\n` +
                `• Share elements with the community\n\n` +
                `🌐 **Need help?** Visit: https://docs.anthropic.com/en/docs/claude-code/oauth-setup`
                }]
              };
            }
            targetUsername = authStatus.username;
          }
    
          // Check if portfolio exists
          const portfolioExists = await this.portfolioRepoManager.checkPortfolioExists(targetUsername);

          let statusText = `${this.indicatorService.getPersonaIndicator()}📊 **Portfolio Status for ${targetUsername}**\n\n`;

          if (portfolioExists) {
            statusText += `✅ **Repository**: ${this.portfolioRepoManager.getRepositoryName()} exists\n`;
            statusText += `🔗 **URL**: https://github.com/${targetUsername}/${this.portfolioRepoManager.getRepositoryName()}\n\n`;
            
            // Get local elements count
            const personasPath = this.portfolioManager.getElementDir(ElementType.PERSONA);
            const skillsPath = this.portfolioManager.getElementDir(ElementType.SKILL);
            const templatesPath = this.portfolioManager.getElementDir(ElementType.TEMPLATE);
            const agentsPath = this.portfolioManager.getElementDir(ElementType.AGENT);
            const memoriesPath = this.portfolioManager.getElementDir(ElementType.MEMORY);
            const ensemblesPath = this.portfolioManager.getElementDir(ElementType.ENSEMBLE);
    
            const [personas, skills, templates, agents, memories, ensembles] = await Promise.all([
              this.countElementsInDir(personasPath),
              this.countElementsInDir(skillsPath),
              this.countElementsInDir(templatesPath),
              this.countElementsInDir(agentsPath),
              this.countElementsInDir(memoriesPath),
              this.countElementsInDir(ensemblesPath)
            ]);
    
            const totalElements = personas + skills + templates + agents + memories + ensembles;
            statusText += `📈 **Local Elements**:\n`;
            statusText += `  • Personas: ${personas}\n`;
            statusText += `  • Skills: ${skills}\n`;
            statusText += `  • Templates: ${templates}\n`;
            statusText += `  • Agents: ${agents}\n`;
            statusText += `  • Memories: ${memories}\n`;
            statusText += `  • Ensembles: ${ensembles}\n`;
            statusText += `  • **Total**: ${totalElements}\n\n`;
    
            statusText += `🔄 **Sync Status**: Use sync_portfolio to update GitHub\n`;
          } else {
            statusText += `❌ **Repository**: No portfolio found\n`;
            statusText += `💡 **Next Step**: Use init_portfolio to create one\n\n`;
            
            statusText += `📝 **What you'll get**:\n`;
            statusText += `  • GitHub repository for your elements\n`;
            statusText += `  • Organized folder structure\n`;
            statusText += `  • README with usage instructions\n`;
            statusText += `  • Easy sharing and backup\n`;
          }
    
          return {
            content: [{
              type: "text",
              text: statusText
            }]
          };
    
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `${this.indicatorService.getPersonaIndicator()}❌ Failed to check portfolio status: ${SecureErrorHandler.sanitizeError(error).message}`
            }]
          };
        }
    }

    async initPortfolio(_options: {repositoryName?: string; private?: boolean; description?: string}) {
        try {
          // Check authentication
          const authStatus = await this.githubAuthManager.getAuthStatus();
          if (!authStatus.isAuthenticated || !authStatus.username) {
            return {
              content: [{
                type: "text",
                text: `${this.indicatorService.getPersonaIndicator()}❌ **GitHub Authentication Required**\n\n` +
                `🔐 **Quick Setup**:\n` +
                `1. Run: \`setup_github_auth\` to authenticate\n` +
                `2. Or use: \`gh auth login --web\` if you have GitHub CLI\n\n` +
                `📝 **What this enables**:\n` +
                `• Upload elements to your GitHub portfolio\n` +
                `• Sync your local portfolio with GitHub\n` +
                `• Share elements with the community\n\n` +
                `🌐 **Need help?** Visit: https://docs.anthropic.com/en/docs/claude-code/oauth-setup`
              }]
            };
          }
    
          const username = authStatus.username;

          // Check if portfolio already exists
          const portfolioExists = await this.portfolioRepoManager.checkPortfolioExists(username);

          if (portfolioExists) {
            return {
              content: [{
                type: "text",
                text: `${this.indicatorService.getPersonaIndicator()}✅ Portfolio already exists at https://github.com/${username}/${this.portfolioRepoManager.getRepositoryName()}\n\nUse portfolio_status to see details or sync_portfolio to update it.`
              }]
            };
          }

          // Create portfolio with explicit consent
          await this.portfolioRepoManager.createPortfolio(username, true);

          // FIX: DMCP-SEC-006 - Add security audit logging for portfolio initialization
          SecurityMonitor.logSecurityEvent({
            type: 'PORTFOLIO_INITIALIZATION',
            severity: 'LOW',
            source: 'PortfolioHandler.initPortfolio',
            details: `Portfolio created for user ${username}`,
            additionalData: { username }
          });

          return {
            content: [{
              type: "text",
              text: `${this.indicatorService.getPersonaIndicator()}🎉 **Portfolio Created Successfully!**\n\n` +
                    `✅ **Repository**: https://github.com/${username}/${this.portfolioRepoManager.getRepositoryName()}\n` +
                    `📁 **Structure**: Organized folders for all element types\n` +
                    `📝 **README**: Usage instructions included\n` +
                    `🔄 **Next Step**: Use sync_portfolio to upload your elements\n\n` +
                    `Your portfolio is ready for sharing your DollhouseMCP creations!`
            }]
          };
    
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `${this.indicatorService.getPersonaIndicator()}❌ Failed to initialize portfolio: ${SecureErrorHandler.sanitizeError(error).message}`
            }]
          };
        }
    }

    async portfolioConfig(options: {autoSync?: boolean; defaultVisibility?: string; autoSubmit?: boolean; repositoryName?: string}) {
        try {
          // FIX: DMCP-SEC-006 - Add security audit logging for configuration changes
          SecurityMonitor.logSecurityEvent({
            type: 'CONFIG_UPDATED',
            severity: 'LOW',
            source: 'PortfolioHandler.portfolioConfig',
            details: `Portfolio configuration updated: ${Object.keys(options).join(', ')}`,
            additionalData: {
              autoSync: options.autoSync,
              defaultVisibility: options.defaultVisibility,
              autoSubmit: options.autoSubmit,
              repositoryName: options.repositoryName,
            }
          });

          const configManager = this.configManager;
          await configManager.initialize();
    
          let statusText = `${this.indicatorService.getPersonaIndicator()}⚙️ **Portfolio Configuration**\n\n`;
    
          // Update settings if provided
          if (options.autoSync !== undefined) {
            // This would be implemented when auto-sync feature is added
            statusText += `🔄 Auto-sync: ${options.autoSync ? 'Enabled' : 'Disabled'} (Coming soon)\n`;
          }
    
          if (options.defaultVisibility) {
            statusText += `🔒 Default visibility: ${options.defaultVisibility}\n`;
          }
    
          if (options.autoSubmit !== undefined) {
            // Set the environment variable for auto-submit
            if (options.autoSubmit) {
              process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION = 'true';
            } else {
              delete process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION;
            }
            statusText += `📤 Auto-submit to collection: ${options.autoSubmit ? 'Enabled' : 'Disabled'}\n`;
          }
    
          if (options.repositoryName) {
            statusText += `📁 Repository name: ${options.repositoryName} (Custom names coming soon)\n`;
          }
    
          // Show current configuration
          statusText += `\n📋 **Current Settings**:\n`;
          const autoSubmitEnabled = process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION === 'true';
          statusText += `  • Auto-submit: ${autoSubmitEnabled ? 'Enabled' : 'Disabled'}\n`;
          statusText += `  • Repository name: ${getPortfolioRepositoryName()}\n`;
          statusText += `  • Default visibility: public\n`;

          return {
            content: [{
              type: "text",
              text: statusText
            }],
            data: {
              config: {
                autoSubmit: process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION === 'true',
                repositoryName: getPortfolioRepositoryName(),
                defaultVisibility: 'public'
              }
            }
          };
    
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `${this.indicatorService.getPersonaIndicator()}❌ Failed to configure portfolio: ${SecureErrorHandler.sanitizeError(error).message}`
            }]
          };
        }
    }

    async syncPortfolio(options: {
        direction: string; 
        mode?: string;
        force: boolean; 
        dryRun: boolean;
        confirmDeletions?: boolean;
      }) {
        try {
          // Check authentication
          const authStatus = await this.githubAuthManager.getAuthStatus();
          if (!authStatus.isAuthenticated || !authStatus.username) {
            return {
              content: [{
                type: "text",
                text: `${this.indicatorService.getPersonaIndicator()}❌ **GitHub Authentication Required**\n\n` +
                `🔐 **Quick Setup**:\n` +
                `1. Run: \`setup_github_auth\` to authenticate\n` +
                `2. Or use: \`gh auth login --web\` if you have GitHub CLI\n\n` +
                `📝 **What this enables**:\n` +
                `• Upload elements to your GitHub portfolio\n` +
                `• Sync your local portfolio with GitHub\n` +
                `• Share elements with the community\n\n` +
                `🌐 **Need help?** Visit: https://docs.anthropic.com/en/docs/claude-code/oauth-setup`
              }]
            };
          }
    
          const username = authStatus.username;

          // Check if portfolio exists (PortfolioRepoManager is injected with TokenManager)
          const portfolioExists = await this.portfolioRepoManager.checkPortfolioExists(username);

          if (!portfolioExists) {
            return {
              content: [{
                type: "text",
                text: `${this.indicatorService.getPersonaIndicator()}❌ **No Portfolio Repository Found**\n\n` +
                      `🏠 **Quick Setup**:\n` +
                      `1. Run: \`init_portfolio\` to create your GitHub portfolio\n` +
                      `2. This creates: https://github.com/[username]/${this.portfolioRepoManager.getRepositoryName()}\n\n` +
                      `📝 **What you'll get**:\n` +
                      `• Public repository to showcase your AI elements\n` +
                      `• Organized structure for personas, skills, templates, and agents\n` +
                      `• Automatic syncing of your local portfolio\n` +
                      `• Community sharing capabilities\n\n` +
                      `🚀 **After setup**: Use \`sync_portfolio\` to upload your content!`
              }]
            };
          }

          if (options.dryRun) {
            // Show what would be synced
            const elementTypeCounts: Record<string, number | string> = {};
            const elementTypeErrors: string[] = [];

            // Get element counts with better error handling
            for (const elementType of ['personas', 'skills', 'templates', 'agents']) {
              try {
                const elements = await this.getElementsList(elementType);
                elementTypeCounts[elementType] = elements.length;
              } catch (error: any) {
                elementTypeCounts[elementType] = 'ERROR';
                elementTypeErrors.push(`${elementType}: ${error.message || 'Unknown error'}`);
              }
            }

            let dryRunText = `${this.indicatorService.getPersonaIndicator()}🔍 **Dry Run - Portfolio Sync Preview**\n\n`;
            dryRunText += `📤 **Elements to sync** (${options.direction}):\n`;
            dryRunText += `  • Personas: ${elementTypeCounts.personas}\n`;
            dryRunText += `  • Skills: ${elementTypeCounts.skills}\n`;
            dryRunText += `  • Templates: ${elementTypeCounts.templates}\n`;
            dryRunText += `  • Agents: ${elementTypeCounts.agents}\n\n`;

            // Include any errors encountered during dry run
            if (elementTypeErrors.length > 0) {
              dryRunText += `⚠️ **Errors found during preview:**\n`;
              for (const error of elementTypeErrors) {
                dryRunText += `  • ${error}\n`;
              }
              dryRunText += `\n`;
            }

            dryRunText += `🎯 **Target**: https://github.com/${username}/${this.portfolioRepoManager.getRepositoryName()}\n`;
            dryRunText += `⚠️  **Note**: This is a preview. Remove dry_run=true to perform actual sync.`;

            return {
              content: [{
                type: "text",
                text: dryRunText
              }]
            };
          }
    
          // For now, implement basic push functionality
          if (options.direction === 'push' || options.direction === 'both') {
            let syncCount = 0;
            let totalElements = 0;
            let syncText = `${this.indicatorService.getPersonaIndicator()}🔄 **Syncing Portfolio...**\n\n`;
    
            // UX IMPROVEMENT: Calculate total elements for progress tracking
            const elementTypes = ['personas', 'skills', 'templates', 'agents'] as const;
            const elementCounts: Record<string, number> = {};
            const failedElements: Array<{type: string, name: string, error: string}> = [];
            
            // Pre-calculate totals for better progress indicators
            try {
              syncText += `📊 **Calculating sync scope...**\n`;
              for (const elementType of elementTypes) {
                try {
                  const elements = await this.getElementsList(elementType);
                  elementCounts[elementType] = elements.length;
                  totalElements += elements.length;
                } catch (error: any) {
                  elementCounts[elementType] = 0;
                  logger.warn(`Failed to count ${elementType}`, { error: error.message });
                }
              }
              
              syncText += `\n🎯 **Ready to sync ${totalElements} elements:**\n`;
              for (const [type, count] of Object.entries(elementCounts)) {
                const icon = count > 0 ? '✅' : '⚪';
                syncText += `  ${icon} ${type}: ${count} elements\n`;
              }
              syncText += `\n🚀 **Starting sync process...**\n\n`;
              
            } catch (error: any) {
              syncText += `\n⚠️ **Warning**: Could not calculate sync scope: ${error.message}\n\n`;
            }
            
            // UX IMPROVEMENT: Process each element type with progress tracking
            for (const elementType of elementTypes) {
              const typeCount = elementCounts[elementType] || 0;
              if (typeCount === 0) {
                syncText += `⏩ **Skipping ${elementType}** (no elements found)\n`;
                continue;
              }
              
              syncText += `📁 **Processing ${elementType}** (${typeCount} elements):\n`;
              let typeSuccessCount = 0;
              
              try {
                const elements = await this.getElementsList(elementType);
                
                for (let i = 0; i < elements.length; i++) {
                  const elementName = elements[i];
                  const progress = `[${i + 1}/${elements.length}]`;
                  
                  try {
                    // UX IMPROVEMENT: Show individual element progress
                    syncText += `  ${progress} 🔄 Syncing \"${elementName}\"...`;
                    
                    // Load element and save to portfolio
                    const element = await this.loadElementByType(elementName, elementType);
                    if (element) {
                      await this.portfolioRepoManager.saveElement(element, true); // Explicit consent
                      syncCount++;
                      typeSuccessCount++;
                      syncText += ` ✅\n`;
                      logger.debug(`Successfully synced ${elementType}/${elementName}`);
                    } else {
                      syncText += ` ❌ (null element)\n`;
                      failedElements.push({
                        type: elementType,
                        name: elementName,
                        error: 'Element loaded as null/undefined'
                      });
                    }
                  } catch (elementError: any) {
                    // Extract error code if present
                    const errorCode = elementError.code || (elementError.message?.match(/([A-Z_]+_\d+)/)?.[1]) || '';
                    const errorMessage = elementError.message || 'Unknown error during element sync';
                    
                    // Clean up error message for display (remove code if already extracted)
                    const displayMessage = errorCode 
                      ? errorMessage.replace(/([A-Z_]+_\d+)\s*/, '')
                      : errorMessage;
                    
                    // Show error code in output for better diagnostics
                    const errorOutput = errorCode 
                      ? `${errorCode}: ${displayMessage}`
                      : displayMessage;
                    
                    syncText += ` ❌ (${errorOutput})\n`;
                    failedElements.push({
                      type: elementType,
                      name: elementName,
                      error: errorOutput
                    });
                    logger.warn(`Failed to sync ${elementType}/${elementName}`, { 
                      error: errorMessage,
                      errorCode,
                      elementName,
                      elementType
                    });
                  }
                }
                
                // UX IMPROVEMENT: Show completion summary for each type
                const successRate = elements.length > 0 ? Math.round((typeSuccessCount / elements.length) * 100) : 0;
                const statusIcon = successRate === 100 ? '🎉' : successRate > 50 ? '⚠️' : '❌';
                syncText += `  ${statusIcon} **${elementType} complete**: ${typeSuccessCount}/${elements.length} synced (${successRate}%)\n\n`;
              } catch (listError: any) {
                // UX IMPROVEMENT: Better error reporting for list failures
                const errorMessage = listError.message || 'Failed to get elements list';
                syncText += `  ❌ **Failed to list ${elementType}**: ${errorMessage}\n\n`;
                failedElements.push({
                  type: elementType,
                  name: 'ALL',
                  error: `Failed to list ${elementType}: ${errorMessage}`
                });
                logger.warn(`Failed to get ${elementType} list`, { error: errorMessage });
              }
            }
    
            // UX IMPROVEMENT: Enhanced final summary with actionable insights
            const successRate = totalElements > 0 ? Math.round((syncCount / totalElements) * 100) : 0;
            const summaryIcon = successRate === 100 ? '🎉' : successRate >= 80 ? '✅' : successRate >= 50 ? '⚠️' : '❌';
            
            syncText += `${summaryIcon} **Sync Complete!**\n`;
            syncText += `📊 **Overall Results**: ${syncCount}/${totalElements} elements synced (${successRate}%)\n`;
            syncText += `🏠 **Portfolio**: https://github.com/${username}/${this.portfolioRepoManager.getRepositoryName()}\n\n`;
            
            // Include failed elements information with actionable suggestions
            if (failedElements.length > 0) {
              syncText += `⚠️ **Issues Encountered** (${failedElements.length} problems):\n\n`;
              
              // Group failures by type for better organization
              const failuresByType: Record<string, Array<{name: string, error: string}>> = {};
              for (const failed of failedElements) {
                if (!failuresByType[failed.type]) {
                  failuresByType[failed.type] = [];
                }
                failuresByType[failed.type].push({ name: failed.name, error: failed.error });
              }
              
              for (const [type, failures] of Object.entries(failuresByType)) {
                syncText += `📁 **${type}** (${failures.length} issues):\n`;
                for (const failure of failures) {
                  if (failure.name === 'ALL') {
                    syncText += `  ❌ ${failure.error}\n`;
                  } else {
                    syncText += `  ❌ \"${failure.name}\": ${failure.error}\n`;
                  }
                }
                syncText += `\n`;
              }
              
              // UX IMPROVEMENT: Add helpful suggestions based on error codes found
              syncText += `💡 **Troubleshooting Tips**:\n`;
              
              // Check for specific error codes and provide targeted advice
              const errorCodes = failedElements.map(f => f.error.match(/^([A-Z_]+_\d+):/)?.[1]).filter(Boolean);
              const uniqueErrorCodes = [...new Set(errorCodes)];
              
              if (uniqueErrorCodes.includes('PORTFOLIO_SYNC_001')) {
                syncText += `  • 🔐 **Auth Error**: Run \`setup_github_auth\` to re-authenticate\n`;
              }
              if (uniqueErrorCodes.includes('PORTFOLIO_SYNC_002')) {
                syncText += `  • 📁 **Repo Missing**: Run \`init_portfolio\` to create your repository\n`;
              }
              if (uniqueErrorCodes.includes('PORTFOLIO_SYNC_004')) {
                syncText += `  • 🔧 **API Error**: GitHub response format issue - please report this bug\n`;
              }
              if (uniqueErrorCodes.includes('PORTFOLIO_SYNC_006')) {
                syncText += `  • ⏳ **Rate Limited**: Wait a few minutes and try again\n`;
              }
              
              // General tips
              syncText += `  • Check element file formats and metadata\n`;
              syncText += `  • Try syncing individual elements with \`portfolio_element_manager\` (upload operation)\n`;
              syncText += `  • Use \`sync_portfolio\` with \`dry_run=true\` to preview issues\n\n`;
              
              // Add error code legend if we found any
              if (uniqueErrorCodes.length > 0) {
                syncText += `📋 **Error Codes Detected**:\n`;
                for (const code of uniqueErrorCodes) {
                  const errorDescriptions: Record<string, string> = {
                    'PORTFOLIO_SYNC_001': 'Authentication failure',
                    'PORTFOLIO_SYNC_002': 'Repository not found',
                    'PORTFOLIO_SYNC_003': 'File creation failed',
                    'PORTFOLIO_SYNC_004': 'API response parsing error',
                    'PORTFOLIO_SYNC_005': 'Network error',
                    'PORTFOLIO_SYNC_006': 'Rate limit exceeded'
                  };
                  const description = errorDescriptions[code as string] || 'Unknown error';
                  syncText += `  • ${code}: ${description}\n`;
                }
                syncText += `\n`;
              }
            } else {
              syncText += `🎉 **Perfect Sync!** All elements uploaded successfully!\n\n`;
            }
            
            // UX IMPROVEMENT: Add next steps and helpful links
            if (syncCount > 0) {
              syncText += `🚀 **Next Steps**:\n`;
              syncText += `  • View your portfolio: https://github.com/${username}/${this.portfolioRepoManager.getRepositoryName()}\n`;
              syncText += `  • Share individual elements using \`submit_collection_content <name>\`\n`;
              syncText += `  • Keep portfolio updated with \`sync_portfolio\` regularly\n\n`;
            }
            
            syncText += `Your elements are now available on GitHub!`;
    
            return {
              content: [{
                type: "text",
                text: syncText
              }]
            };
          }
    
          if (options.direction === 'pull' || options.direction === 'both') {
            return this.portfolioPullHandler.executePull(options, this.indicatorService.getPersonaIndicator());
          }
    
          return {
            content: [{
              type: "text",
              text: `${this.indicatorService.getPersonaIndicator()}❌ Invalid sync direction. Use 'push', 'pull', or 'both'.`
            }]
          };
    
        } catch (error) {
          // IMPROVED ERROR HANDLING: Ensure we always have a meaningful error message
          const sanitizedError = SecureErrorHandler.sanitizeError(error);
          const errorMessage = sanitizedError?.message || (error as any)?.message || String(error) || 'Unknown error occurred';
          
          return {
            content: [{
              type: "text",
              text: `${this.indicatorService.getPersonaIndicator()}❌ Failed to sync portfolio: ${errorMessage}`
            }]
          };
        }
    }

    async searchPortfolio(options: {
        query: string; 
        elementType?: string; 
        fuzzyMatch?: boolean; 
        maxResults?: number; 
        includeKeywords?: boolean; 
        includeTags?: boolean; 
        includeTriggers?: boolean; 
        includeDescriptions?: boolean;
      }) {
        try {
          // Validate the query parameter
          if (!options.query || typeof options.query !== 'string' || options.query.trim().length === 0) {
            return {
              content: [{
                type: "text",
                text: `${this.indicatorService.getPersonaIndicator()}❌ Search query is required and must be a non-empty string.`
              }]
            };
          }
    
          // Parse element type if provided (Issue #433: accept singular forms)
          let elementType: ElementType | undefined;
          if (options.elementType) {
            const normalized = normalizeElementType(options.elementType);
            if (!normalized) {
              return {
                content: [{
                  type: "text",
                  text: `${this.indicatorService.getPersonaIndicator()}❌ Invalid element type '${options.elementType}'. Valid types: ${formatElementTypesList()}`
                }]
              };
            }
            elementType = normalized;
          }

          // Build search options
          const searchOptions = {
            elementType,
            fuzzyMatch: options.fuzzyMatch !== false, // Default to true
            maxResults: options.maxResults || 20,
            includeKeywords: options.includeKeywords !== false,
            includeTags: options.includeTags !== false,
            includeTriggers: options.includeTriggers !== false,
            includeDescriptions: options.includeDescriptions !== false
          };
    
          // Perform the search
          const results = await this.portfolioIndexManager.search(options.query, searchOptions);
    
          // Format the results
          let text = `${this.indicatorService.getPersonaIndicator()}🔍 **Portfolio Search Results**\n\n`;
          text += `**Query**: \"${options.query}\"\n`;
          
          if (elementType) {
            text += `**Type Filter**: ${elementType}\n`;
          }
          
          text += `**Found**: ${results.length} element${results.length === 1 ? '' : 's'}\n\n`;
    
          if (results.length === 0) {
            text += `No elements found matching your search criteria.\n\n`;
            text += `**Tips for better results:**\n`;
            text += `• Try different keywords or partial names\n`;
            text += `• Remove the type filter to search all element types\n`;
            text += `• Check spelling and try synonyms\n`;
            text += `• Use the list_elements tool to see all available content`;
          } else {
            text += `**Results:**\n\n`;
            
            for (const result of results) {
              const { entry, matchType } = result;
              const icon = getElementIcon(entry.elementType);
              
              text += `${icon} **${entry.metadata.name}**\n`;
              text += `   📁 Type: ${entry.elementType}\n`;
              text += `   🎯 Match: ${matchType}\n`;
              
              if (entry.metadata.description) {
                const desc = entry.metadata.description.length > 100 
                  ? entry.metadata.description.substring(0, 100) + '...' 
                  : entry.metadata.description;
                text += `   📝 ${desc}\n`;
              }
              
              if (entry.metadata.tags && entry.metadata.tags.length > 0) {
                text += `   🏷️ Tags: ${entry.metadata.tags.slice(0, 5).join(', ')}${entry.metadata.tags.length > 5 ? '...' : ''}\n`;
              }
    
              // FIX (#1213): Use correct file extension based on element type
              // Previously: Hardcoded .md for all types (wrong for memories which are .yaml)
              // Now: Get correct extension from PortfolioManager
              const fileExtension = this.portfolioManager.getFileExtension(entry.elementType);
              text += `   📄 File: ${entry.filename}${fileExtension}\n\n`;
            }
            
            if (results.length >= searchOptions.maxResults) {
              text += `⚠️ Results limited to ${searchOptions.maxResults}. Refine your search for more specific results.\n\n`;
            }
            
            text += `💡 **Next steps:**\n`;
            text += `• Use get_element_details to see full content\n`;
            text += `• Use activate_element to activate elements\n`;
            text += `• Use submit_collection_content to share with the community`;
          }
    
          return {
            content: [{
              type: "text",
              text
            }]
          };
    
        } catch (error: any) {
          ErrorHandler.logError('PortfolioHandler.searchPortfolio', error, { 
            query: options.query,
            elementType: options.elementType 
          });
          
          return {
            content: [{
              type: "text", 
              text: `${this.indicatorService.getPersonaIndicator()}❌ Search failed: ${SecureErrorHandler.sanitizeError(error).message}`
            }]
          };
        }
    }

    async searchAll(options: {
        query: string;
        sources?: string[];
        elementType?: string;
        page?: number;
        pageSize?: number;
        sortBy?: string;
      }) {
        try {
          // Validate the query parameter
          if (!options.query || typeof options.query !== 'string' || options.query.trim().length === 0) {
            return {
              content: [{
                type: "text",
                text: `${this.indicatorService.getPersonaIndicator()}❌ Search query is required and must be a non-empty string.`
              }]
            };
          }
    
          // Parse element type if provided (Issue #433: accept singular forms)
          let elementType: ElementType | undefined;
          if (options.elementType) {
            const normalized = normalizeElementType(options.elementType);
            if (!normalized) {
              return {
                content: [{
                  type: "text",
                  text: `${this.indicatorService.getPersonaIndicator()}❌ Invalid element type '${options.elementType}'. Valid types: ${formatElementTypesList()}`
                }]
              };
            }
            elementType = normalized;
          }

          // Parse sources (default to local and github)
          const sources = options.sources || ['local', 'github'];
          const includeLocal = sources.includes('local');
          const includeGitHub = sources.includes('github');
          const includeCollection = sources.includes('collection');
    
          // Build search options
          const searchOptions = {
            query: options.query,
            includeLocal,
            includeGitHub,
            includeCollection,
            elementType,
            page: options.page || 1,
            pageSize: options.pageSize || 20,
            sortBy: (options.sortBy as any) || 'relevance'
          };
    
          // Perform the unified search
          const results = await this.unifiedIndexManager.search(searchOptions);
    
          // Format the results
          let text = `${this.indicatorService.getPersonaIndicator()}🔍 **Unified Search Results**\n\n`;
          text += `**Query**: \"${options.query}\"\n`;
          text += `**Sources**: ${sources.join(', ')}
`;
          
          if (elementType) {
            text += `**Type Filter**: ${elementType}\n`;
          }
          
          text += `**Found**: ${results.length} element${results.length === 1 ? '' : 's'}\n\n`;
    
          if (results.length === 0) {
            text += `No elements found matching your search criteria.\n\n`;
            text += `**Tips for better results:**\n`;
            text += `• Try different keywords or partial names\n`;
            text += `• Remove the type filter to search all element types\n`;
            text += `• Include more sources: local, github, collection\n`;
            text += `• Check spelling and try synonyms\n`;
            text += `• Use browse_collection to explore available content`;
          } else {
            text += `**Results:**\n\n`;
            
            for (const result of results) {
              const { entry, source, matchType, score, isDuplicate, versionConflict } = result;
              const icon = getElementIcon(entry.elementType);
              const sourceIcon = getSourceIcon(source);
              
              text += `${icon} **${entry.name}** ${sourceIcon}\n`;
              text += `   📁 Type: ${entry.elementType} | Source: ${source}\n`;
              text += `   🎯 Match: ${matchType} | Score: ${score.toFixed(2)}
`;
              
              if (entry.description) {
                const desc = entry.description.length > 100 
                  ? entry.description.substring(0, 100) + '...' 
                  : entry.description;
                text += `   📝 ${desc}\n`;
              }
    
              if (entry.version) {
                text += `   🏷️ Version: ${entry.version}\n`;
              }
    
              // Show duplicate information
              if (isDuplicate) {
                text += `   ⚠️ **Duplicate detected across sources**\n`;
                if (versionConflict) {
                  text += `   🔄 Version conflict - Recommended: ${versionConflict.recommended} (${versionConflict.reason})\n`;
                }
              }
              
              text += `\n`;
            }
            
            const hasMore = results.length >= searchOptions.pageSize;
            if (hasMore) {
              const nextPage = searchOptions.page + 1;
              text += `⚠️ Results limited to ${searchOptions.pageSize}. Use page=${nextPage} for more results.\n\n`;
            }
            
            text += `💡 **Next steps:**\n`;
            text += `• Use get_element_details to see full content\n`;
            text += `• Use install_collection_content for collection items\n`;
            text += `• Use activate_element for local elements\n`;
            text += `• Check for duplicates before submitting new content`;
          }
    
          return {
            content: [{
              type: "text",
              text
            }]
          };
    
        } catch (error: any) {
          ErrorHandler.logError('PortfolioHandler.searchAll', error, { 
            query: options.query,
            sources: options.sources,
            elementType: options.elementType 
          });
          
          return {
            content: [{
              type: "text", 
              text: `${this.indicatorService.getPersonaIndicator()}❌ Unified search failed: ${SecureErrorHandler.sanitizeError(error).message}`
            }]
          };
        }
    }
}
