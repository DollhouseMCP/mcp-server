
import { CollectionBrowser, CollectionSearch, PersonaDetails, ElementInstaller } from '../collection/index.js';
import { CollectionCache } from '../cache/index.js';
import { MCPInputValidator, sanitizeInput } from '../security/InputValidator.js';
import { SecureErrorHandler } from '../security/errorHandler.js';
import { ElementType, PortfolioManager } from '../portfolio/PortfolioManager.js';
import { logger } from '../utils/logger.js';
import { normalizeElementType } from '../utils/elementTypeNormalization.js';
import * as path from 'path';
import { FileDiscoveryUtil } from '../utils/FileDiscoveryUtil.js';
import { FileOperationsService } from '../services/FileOperationsService.js';
import { SubmitToPortfolioTool } from '../tools/portfolio/submitToPortfolioTool.js';
import { UnifiedIndexManager } from '../portfolio/UnifiedIndexManager.js';
import { APICache } from '../cache/index.js';
import { getSourceIcon } from '../utils/index.js';
import { InitializationService } from '../services/InitializationService.js';
import { PersonaIndicatorService } from '../services/PersonaIndicatorService.js';
import { PersonaManager } from '../persona/PersonaManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

/**
 * CollectionHandler - Manages DollhouseMCP collection browsing, search, and content installation
 *
 * Uses dependency injection for all services:
 * - InitializationService for setup tasks
 * - PersonaIndicatorService for persona indicator formatting
 * - PersonaManager for persona management
 *
 * FIX: DMCP-SEC-006 - Security audit suppression
 * This handler delegates collection operations to specialized services.
 * Audit logging happens in the underlying services (CollectionBrowser, ElementInstaller, etc.).
 * @security-audit-suppress DMCP-SEC-006
 */
export class CollectionHandler {
    constructor(
        private readonly collectionBrowser: CollectionBrowser,
        private readonly collectionSearch: CollectionSearch,
        private readonly personaDetails: PersonaDetails,
        private readonly elementInstaller: ElementInstaller,
        private readonly collectionCache: CollectionCache,
        private readonly portfolioManager: PortfolioManager,
        private readonly apiCache: APICache,
        private readonly personaManager: PersonaManager,
        private readonly submitToPortfolioTool: SubmitToPortfolioTool,
        private readonly unifiedIndexManager: UnifiedIndexManager,
        private readonly initService: InitializationService,
        private readonly indicatorService: PersonaIndicatorService,
        private readonly fileOperations: FileOperationsService
    ) {
        // Initialize from env var at construction, then manage via instance state.
        // Removes process.env mutation during runtime — prevents cross-session contamination.
        this._autoSubmitEnabled = process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION === 'true';
    }

    private _autoSubmitEnabled: boolean;

    /** Whether auto-submit to collection is enabled. */
    public isAutoSubmitEnabled(): boolean {
        return this._autoSubmitEnabled;
    }

    /** Set auto-submit state. Used by configureCollectionSubmission and PortfolioHandler. */
    public setAutoSubmitEnabled(enabled: boolean): void {
        this._autoSubmitEnabled = enabled;
    }

    public async browseCollection(section?: string, type?: string) {
        try {
          // FIX #471: Replace legacy category validation with proper section/type validation
          // Valid sections: library, showcase, catalog
          // Valid types for MCP: personas, skills, agents, templates (others filtered per Issue #144)
          // Note: tools, prompts, ensembles, memories exist in collection but are filtered from MCP
          const validSections = ['library', 'showcase', 'catalog'];
          
          // ⚠️ CRITICAL: When adding new element types, you MUST update this array!
          // See docs/developer-guide/ADDING_NEW_ELEMENT_TYPES_CHECKLIST.md for complete checklist
          // This array is often forgotten and causes validation failures for new types
          const validTypes = ['personas', 'skills', 'agents', 'templates', 'memories'];  // Only MCP-supported types
          
          // Validate section if provided
          const validatedSection = section ? sanitizeInput(section.toLowerCase(), 100) : undefined;
          if (validatedSection && !validSections.includes(validatedSection)) {
            throw new Error(`Invalid section '${validatedSection}'. Must be one of: ${validSections.join(', ')}`);
          }
          
          // Validate type if provided (only valid when section is 'library')
          // Issue #433: Accept singular forms (e.g., "memory" → "memories")
          let validatedType = type ? sanitizeInput(type.toLowerCase(), 100) : undefined;
          if (validatedType && validatedSection === 'library') {
            const normalizedType = normalizeElementType(validatedType);
            if (!normalizedType || !validTypes.includes(normalizedType)) {
              throw new Error(`Invalid type '${validatedType}'. Must be one of: ${validTypes.join(', ')}`);
            }
            validatedType = normalizedType;
          }
          if (validatedType && validatedSection !== 'library') {
            throw new Error('Type parameter is only valid when section is "library"');
          }
          
          const result = await this.collectionBrowser.browseCollection(validatedSection, validatedType);
          
          // Handle sections view
          const items = result.items;
          const categories = result.sections || result.categories;
          
          const text = this.collectionBrowser.formatBrowseResults(
            items,
            categories,
            validatedSection,
            validatedType,
            this.indicatorService.getPersonaIndicator()
          );
          
          return {
            content: [
              {
                type: "text",
                text: text,
              },
            ],
          };
        } catch (error) {
          const sanitized = SecureErrorHandler.sanitizeError(error);
          return {
            content: [
              {
                type: "text",
                text: `${this.indicatorService.getPersonaIndicator()}❌ Collection browsing failed: ${sanitized.message}`,
              },
            ],
          };
        }
    }

    public async searchCollection(query: string) {
        try {
          // Enhanced input validation for search query
          const validatedQuery = MCPInputValidator.validateSearchQuery(query);

          const items = await this.collectionSearch.searchCollection(validatedQuery);
          const text = this.collectionSearch.formatSearchResults(items, validatedQuery, this.indicatorService.getPersonaIndicator());

          return {
            content: [
              {
                type: "text",
                text: text,
              },
            ],
          };
        } catch (error) {
          const sanitized = SecureErrorHandler.sanitizeError(error);
          return {
            content: [
              {
                type: "text",
                text: `${this.indicatorService.getPersonaIndicator()}❌ Error searching collection: ${sanitized.message}`,
              },
            ],
          };
        }
    }

    public async searchCollectionEnhanced(query: string, options: any = {}) {
        try {
          // Enhanced input validation for search query
          const validatedQuery = MCPInputValidator.validateSearchQuery(query);

          // Validate and sanitize options
          const validatedOptions = {
            elementType: options.elementType ? String(options.elementType) : undefined,
            category: options.category ? String(options.category) : undefined,
            page: options.page ? Math.max(1, Number.parseInt(options.page) || 1) : 1,
            pageSize: options.pageSize ? Math.min(100, Math.max(1, Number.parseInt(options.pageSize) || 25)) : 25,
            sortBy: options.sortBy && ['relevance', 'name', 'date'].includes(options.sortBy) ? options.sortBy : 'relevance'
          };

          const results = await this.collectionSearch.searchCollectionWithOptions(validatedQuery, validatedOptions);
          const text = this.collectionSearch.formatSearchResultsWithPagination(results, this.indicatorService.getPersonaIndicator());

          return {
            content: [
              {
                type: "text",
                text: text,
              },
            ],
          };
        } catch (error) {
          const sanitized = SecureErrorHandler.sanitizeError(error);
          return {
            content: [
              {
                type: "text",
                text: `${this.indicatorService.getPersonaIndicator()}❌ Error searching collection: ${sanitized.message}`,
              },
            ],
          };
        }
    }

    public async getCollectionContent(path: string) {
        try {
          const { metadata, content } = await this.personaDetails.getCollectionContent(path);
          const text = this.personaDetails.formatPersonaDetails(metadata, content, path, this.indicatorService.getPersonaIndicator());
          
          return {
            content: [
              {
                type: "text",
                text: text,
              },
            ],
          };
        } catch (error) {
          const sanitized = SecureErrorHandler.sanitizeError(error);
          return {
            content: [
              {
                type: "text",
                text: `${this.indicatorService.getPersonaIndicator()}❌ Error fetching content: ${sanitized.message}`,
              },
            ],
          };
        }
    }

    public async installContent(inputPath: string) {
        try {
          const result = await this.elementInstaller.installContent(inputPath);

          if (!result.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `⚠️ ${result.message}`,
                },
              ],
            };
          }

          // If it's a persona, reload personas
          if (result.elementType === ElementType.PERSONA) {
            await this.personaManager.reload();
          }

          // FIX: DMCP-SEC-006 - Add security audit logging for content installation
          SecurityMonitor.logSecurityEvent({
            type: 'ELEMENT_CREATED',
            severity: 'LOW',
            source: 'CollectionHandler.installContent',
            details: `Element installed: ${result.elementType}/${result.metadata?.name}`,
            additionalData: { elementType: result.elementType, filename: result.filename }
          });

          const text = this.elementInstaller.formatInstallSuccess(
            result.metadata!,
            result.filename!,
            result.elementType!
          );
          
          return {
            content: [
              {
                type: "text",
                text: text,
              },
            ],
          };
        } catch (error) {
          const sanitized = SecureErrorHandler.sanitizeError(error);
          return {
            content: [
              {
                type: "text",
                text: `${this.indicatorService.getPersonaIndicator()}❌ Error installing AI customization element: ${sanitized.message}`,
              },
            ],
          };
        }
    }

    public async submitContent(contentIdentifier: string) {
        try {
        // Try to find the content across all element types
        let elementType: ElementType | undefined;
        let foundPath: string | null = null;
        
        // PERFORMANCE OPTIMIZATION: Search all element directories in parallel
        // NOTE: This dynamically handles ALL element types from the ElementType enum
        // No hardcoded count - if you add 10 more element types tomorrow, this code
        // will automatically search all 16 types without any changes needed here
        const searchPromises = Object.values(ElementType).map(async (type) => {
          const dir = this.portfolioManager.getElementDir(type);
          try {
            const file = await FileDiscoveryUtil.findFile(dir, contentIdentifier, {
              extensions: ['.md', '.json', '.yaml', '.yml'],
              partialMatch: true,
              cacheResults: true
            });
            
            return file ? { type: type as ElementType, file } : null;
          } catch (error: any) {
            // IMPROVED ERROR HANDLING: Log warnings for unexpected errors
            if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
              // Not just a missing directory - this could be a permission issue or other problem
              logger.warn(`Unexpected error searching ${type} directory`, {
                contentIdentifier,
                type,
                error: error?.message || String(error),
                code: error?.code
              });
            } else {
              // Directory doesn't exist - this is expected for unused element types
              logger.debug(`${type} directory does not exist, skipping`, { type });
            }
            return null;
          }
        });
        
        // Wait for all searches to complete and find the first match
        const searchResults = await Promise.allSettled(searchPromises);
        
        // NOTE: File validation - we rely on the portfolio directory structure to ensure
        // files are in the correct element type directory. Additional schema validation
        // could be added here if needed, but the current approach is sufficient as:
        // 1. FileDiscoveryUtil already validates file extensions
        // 2. Portfolio structure enforces proper organization
        // 3. submitToPortfolioTool performs additional validation downstream
        for (const result of searchResults) {
          if (result.status === 'fulfilled' && result.value) {
            foundPath = result.value.file;
            elementType = result.value.type;
            logger.debug(`Found content in ${elementType} directory`, {
              contentIdentifier, 
              type: elementType, 
              file: foundPath 
            });
            break;
          }
        }
        
        // CRITICAL FIX: Never default to any element type when content is not found
        // This prevents incorrect submissions and forces proper type detection or user specification
        if (!elementType) {
          // Content not found in any element directory - provide helpful error with suggestions
          const availableTypes = Object.values(ElementType).join(', ');
          logger.warn(`Content "${contentIdentifier}" not found in any portfolio directory`, {
            contentIdentifier,
            searchedTypes: Object.values(ElementType) 
          });
          
          // UX IMPROVEMENT: Enhanced error message with smart suggestions
          let errorMessage = `❌ Content "${contentIdentifier}" not found in portfolio.\n\n`;
          errorMessage += `🔍 **Searched across all element types**: ${availableTypes}\n\n`;
          
          // Try to provide smart suggestions based on partial matches
          try {
            const suggestions: string[] = [];
            
            // Search for similar names across all element types
            for (const elementType of Object.values(ElementType)) {
              const dir = this.portfolioManager.getElementDir(elementType);
              try {
                const partialMatches = await FileDiscoveryUtil.findFile(dir, contentIdentifier, {
                  extensions: ['.md', '.json', '.yaml', '.yml'],
                  partialMatch: true,
                  cacheResults: false
                });
                
                if (Array.isArray(partialMatches) && partialMatches.length > 0) {
                  for (const match of partialMatches.slice(0, 2)) {
                    const basename = path.basename(match, path.extname(match));
                    suggestions.push(`"${basename}" (${elementType})`);
                  }
                } else if (partialMatches) {
                  const basename = path.basename(partialMatches, path.extname(partialMatches));
                  suggestions.push(`"${basename}" (${elementType})`);
                }
              } catch {
                // Skip this type if there's an error
                continue;
              }
            }
            
            if (suggestions.length > 0) {
              errorMessage += `💡 **Did you mean one of these?**\n`;
              for (const suggestion of suggestions.slice(0, 5)) {
                errorMessage += `  • ${suggestion}\n`;
              }
              errorMessage += `\n`;
            }
          } catch (suggestionError) {
            // If suggestions fail, continue without them
            logger.debug('Failed to generate suggestions', { suggestionError });
          }
          
          errorMessage += `🛠️ **Step-by-step troubleshooting**:\n`;
          errorMessage += `1. 📝 **List all content**: Use \`list_portfolio\` to see what's available\n`;
          errorMessage += `2. 🔍 **Check spelling**: Verify the exact name and try variations
`;
          errorMessage += `3. 🎯 **Specify type**: Try \`submit_collection_content \"${contentIdentifier}\" --type=personas\`\n\n`;
          errorMessage += `4. 📁 **Browse files**: Check your portfolio directory manually

`;
          errorMessage += `📝 **Tip**: The system searches both filenames and display names with fuzzy matching.`;
          
          return {
            content: [
              {
                type: "text",
                text: errorMessage,
              },
            ],
          };
        }
        
        // Check for duplicates across all sources before submission
        try {
          // Extract the actual element name from the content path
          const basename = path.basename(foundPath!, path.extname(foundPath!));
          const duplicates = await this.unifiedIndexManager.checkDuplicates(basename);
          
          if (duplicates.length > 0) {
            const duplicate = duplicates[0];
            let warningText = `⚠️ **Duplicate Detection Alert**\n\n`;
            warningText += `Found "${duplicate.name}" in multiple sources:\n\n`;
            
            for (const source of duplicate.sources) {
              const sourceIcon = getSourceIcon(source.source);
              warningText += `${sourceIcon} **${source.source}**: ${source.version || 'unknown version'} (${source.lastModified.toLocaleDateString()})\n`;
            }
            
            warningText += `\n`;
            
            if (duplicate.hasVersionConflict && duplicate.versionConflict) {
              warningText += `🔄 **Version Conflict Detected**\n`;
              warningText += `Recommended source: **${duplicate.versionConflict.recommended}**\n`;
              warningText += `Reason: ${duplicate.versionConflict.reason}\n\n`;
            }
            
            warningText += `**Recommendations:**\n`;
            warningText += `• Review existing versions before submitting
`;
            warningText += `• Consider updating local version instead of creating duplicate
`;
            warningText += `• Ensure your version adds meaningful improvements
`;
            warningText += `• Update version number in metadata if submitting enhancement

`;
            warningText += `**Proceeding with submission anyway...**\n\n`;
            
            // Log the duplicate detection for monitoring
            logger.warn('Duplicate content detected during submission', {
              contentIdentifier,
              elementType,
              duplicateInfo: duplicate
            });
            
            // Continue with submission but show warning
            const result = await this.submitToPortfolioTool.execute({
              name: contentIdentifier,
              type: elementType
            });
            
            // Combine warning with submission result
            const responseText = `${this.indicatorService.getPersonaIndicator()}${result.success ? '⚠️' : '❌'} ${warningText}${result.message}`
            
            return {
              content: [{
                type: "text",
                text: responseText,
              }],
            };
          }
        } catch (duplicateError) {
          // If duplicate checking fails, log but continue with submission
          logger.warn('Duplicate checking failed during submission', {
            contentIdentifier,
            error: duplicateError instanceof Error ? duplicateError.message : String(duplicateError)
          });
        }
        
        // Execute the submission with the detected element type
        const result = await this.submitToPortfolioTool.execute({
          name: contentIdentifier,
          type: elementType
        });
        
        // Format the response - the message already contains all details
        let responseText = result.message;
        
        // Add persona indicator for consistency
        responseText = `${this.indicatorService.getPersonaIndicator()}${result.success ? '✅' : '❌'} ${responseText}`;
        
        return {
          content: [
            {
              type: "text",
              text: responseText,
            },
          ],
        };
        
        } catch (error: any) {
          // UX IMPROVEMENT: Comprehensive error handling with fallback suggestions
          logger.error('Unexpected error in submitContent', {
            contentIdentifier,
            error: error.message,
            stack: error.stack
          });
          
          let errorMessage = `${this.indicatorService.getPersonaIndicator()}❌ **Submission Failed**\n\n`;
          errorMessage += `🚨 **Error**: ${error.message || 'Unknown error occurred'}\n\n`;
          
          // Provide contextual troubleshooting based on error type
          if (error.message?.includes('auth') || error.message?.includes('token')) {
            errorMessage += `🔐 **Authentication Issue**:\n`;
            errorMessage += `• Run: \`setup_github_auth\` to re-authenticate\n`;
            errorMessage += `• Check: \`gh auth status\` if you have GitHub CLI\n\n`;
          }
          
          if (error.message?.includes('network') || error.message?.includes('connection')) {
            errorMessage += `🌐 **Network Issue**:\n`;
            errorMessage += `• Check your internet connection
`;
            errorMessage += `• Try again in a few minutes
`;
            errorMessage += `• Check GitHub status: https://status.github.com

`;
          }
          
          errorMessage += `🚑 **Emergency Alternatives**:\n`;
          errorMessage += `1. 🔄 **Retry**: Try the same command again
`;
          errorMessage += `2. 📝 **Check content**: Use \`list_portfolio\` to verify the element exists\n`;
          errorMessage += `3. 🎯 **Specify type**: Add \`--type=personas\` if you know the element type\n`;
          errorMessage += `4. 🚑 **Manual upload**: Copy content directly to GitHub via web interface

`;
          errorMessage += `📞 **Need help?** This looks like a system issue. Please report it with the error details above.`;
          
          return {
            content: [
              {
                type: "text",
                text: errorMessage,
              },
            ],
          };
        }
    }

    /**
     * Configure collection submission settings
     * Controls whether content is automatically submitted to the DollhouseMCP collection
     */
    public async configureCollectionSubmission(autoSubmit: boolean) {
      try {
        this._autoSubmitEnabled = autoSubmit;

        const message = autoSubmit
          ? "✅ Collection submission enabled! Content will automatically be submitted to the DollhouseMCP collection after portfolio upload."
          : "✅ Collection submission disabled. Content will only be uploaded to your personal portfolio.";

        return {
          content: [
            {
              type: "text",
              text: `${this.indicatorService.getPersonaIndicator()}${message}`
            }
          ]
        };
      } catch (error) {
        logger.error('Error configuring collection submission', { error });
        return {
          content: [
            {
              type: "text",
              text: `${this.indicatorService.getPersonaIndicator()}❌ Failed to configure collection submission: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
          ]
        };
      }
    }

    /**
     * Get current collection submission configuration
     * Shows whether auto-submit is enabled or disabled
     */
    public async getCollectionSubmissionConfig() {
      const autoSubmitEnabled = this._autoSubmitEnabled;

      const message = `**Collection Submission Configuration**\n\n` +
        `• **Auto-submit**: ${autoSubmitEnabled ? '✅ Enabled' : '❌ Disabled'}\n\n` +
        `When auto-submit is enabled, the \`submit_collection_content\` tool will:\n` +
        `1. Upload content to your GitHub portfolio\n` +
        `2. Automatically create a submission issue in DollhouseMCP/collection\n\n` +
        `To change this setting, use:\n` +
        `\`\`\`\nconfigure_collection_submission autoSubmit: true/false\n\`\`\``;

      return {
        content: [
          {
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}${message}`
          }
        ]
      };
    }

    public async getCollectionCacheHealth() {
        try {
          // Get cache statistics from both caches
          const collectionStats = await this.collectionCache.getCacheStats();
          const searchStats = await this.collectionSearch.getCacheStats();
          
          // Check if cache directory exists
          const cacheDir = path.join(process.cwd(), '.dollhousemcp', 'cache');
          let cacheFileExists = false;
          let cacheFileSize = 0;
          
          try {
            const cacheFile = path.join(cacheDir, 'collection-cache.json');
            const fileStats = await this.fileOperations.stat(cacheFile);
            cacheFileExists = true;
            cacheFileSize = fileStats.size;
          } catch {
            // Cache file doesn't exist yet
          }
          
          // Format cache age
          const formatAge = (ageMs: number): string => {
            if (ageMs === 0) return 'Not cached';
            const hours = Math.floor(ageMs / (1000 * 60 * 60));
            const minutes = Math.floor((ageMs % (1000 * 60 * 60)) / (1000 * 60));
            if (hours > 0) {
              return `${hours}h ${minutes}m old`;
            }
            return `${minutes}m old`;
          };
          
          // Build health report with both cache systems
          const healthReport = {
            collection: {
              status: collectionStats.isValid ? 'healthy' : (cacheFileExists ? 'expired' : 'empty'),
              cacheExists: cacheFileExists,
              itemCount: collectionStats.itemCount,
              cacheAge: formatAge(collectionStats.cacheAge),
              cacheAgeMs: collectionStats.cacheAge,
              isValid: collectionStats.isValid,
              cacheFileSize: cacheFileSize,
              cacheFileSizeFormatted: cacheFileSize > 0 ? `${(cacheFileSize / 1024).toFixed(2)} KB` : '0 KB',
              ttlRemaining: collectionStats.isValid ? formatAge(24 * 60 * 60 * 1000 - collectionStats.cacheAge) : 'Expired'
            },
            index: {
              status: searchStats.index.isValid ? 'healthy' : (searchStats.index.hasCache ? 'expired' : 'empty'),
              hasCache: searchStats.index.hasCache,
              elements: searchStats.index.elements,
              cacheAge: formatAge(searchStats.index.age),
              isValid: searchStats.index.isValid,
              ttlRemaining: searchStats.index.isValid ? formatAge(15 * 60 * 1000 - searchStats.index.age) : 'Expired'
            },
            overall: {
              recommendation: (collectionStats.isValid || searchStats.index.isValid)
                ? 'Cache system is operational and serving content efficiently'
                : 'Cache system will refresh on next access for optimal performance'
            }
          };
          
          return {
            content: [
              {
                type: "text",
                text: `${this.indicatorService.getPersonaIndicator()}📊 **Collection Cache Health Check**\n\n` +
                  `## 🗄️ Collection Cache (Legacy)\n` +
                  `**Status**: ${healthReport.collection.status === 'healthy' ? '✅' : healthReport.collection.status === 'expired' ? '⚠️' : '📦'} ${healthReport.collection.status.toUpperCase()}\n` +
                  `**Items Cached**: ${healthReport.collection.itemCount}\n` +
                  `**Cache Age**: ${healthReport.collection.cacheAge}\n` +
                  `**Cache Size**: ${healthReport.collection.cacheFileSizeFormatted}\n` +
                  `**TTL Remaining**: ${healthReport.collection.ttlRemaining}\n\n` +
                  `## 🚀 Index Cache (Enhanced Search)\n` +
                  `**Status**: ${healthReport.index.status === 'healthy' ? '✅' : healthReport.index.status === 'expired' ? '⚠️' : '📦'} ${healthReport.index.status.toUpperCase()}\n` +
                  `**Elements Indexed**: ${healthReport.index.elements}\n` +
                  `**Cache Age**: ${healthReport.index.cacheAge}\n` +
                  `**TTL Remaining**: ${healthReport.index.ttlRemaining}\n\n` +
                  `**Overall Status**: ${healthReport.overall.recommendation}\n\n` +
                  `The enhanced index cache provides fast search with pagination, filtering, and sorting. ` +
                  `The collection cache serves as a fallback for offline browsing.`,
              },
            ],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to get cache health: ${errorMessage}`);
          
          return {
            content: [
              {
                type: "text",
                text: `${this.indicatorService.getPersonaIndicator()}❌ Failed to get cache health: ${errorMessage}`,
              },
            ],
          };
        }
    }
}
