/**
 * Tool for submitting content to GitHub portfolio repositories
 * Replaces the broken issue-based submission with direct repository saves
 * 
 * FIXES IMPLEMENTED (PR #503):
 * 1. TYPE SAFETY FIX #1 (Issue #497): Changed apiCache from 'any' to proper APICache type
 * 2. TYPE SAFETY FIX #2 (Issue #497): Replaced complex type casting with PortfolioElementAdapter
 * 3. PERFORMANCE (PR #496 recommendation): Using FileDiscoveryUtil for optimized file search
 */

import { GitHubAuthManager } from '../../auth/GitHubAuthManager.js';
import { PortfolioRepoManager } from '../../portfolio/PortfolioRepoManager.js';
import { TokenManager } from '../../security/tokenManager.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { PortfolioIndexManager } from '../../portfolio/PortfolioIndexManager.js';
import { ElementType } from '../../portfolio/types.js';
import { logger } from '../../utils/logger.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { APICache } from '../../cache/APICache.js';
import { PortfolioElementAdapter } from './PortfolioElementAdapter.js';
import { FileDiscoveryUtil } from '../../utils/FileDiscoveryUtil.js';
import { ErrorHandler, ErrorCategory } from '../../utils/ErrorHandler.js';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface SubmitToPortfolioParams {
  name: string;
  type?: ElementType;
}

export interface PortfolioElement {
  type: ElementType;
  metadata: {
    name: string;
    description: string;
    author: string;
    created: string;
    updated: string;
    version: string;
  };
  content: string;
}

export interface SubmitToPortfolioResult {
  success: boolean;
  message: string;
  url?: string;
  error?: string;
}

export interface ElementDetectionMatch {
  type: ElementType;
  path: string;
}

export interface ElementDetectionResult {
  found: boolean;
  matches: ElementDetectionMatch[];
}

export class SubmitToPortfolioTool {
  private authManager: GitHubAuthManager;
  private portfolioManager: PortfolioRepoManager;
  private contentValidator: ContentValidator;

  constructor(apiCache: APICache) {
    // TYPE SAFETY FIX #1: Proper typing for apiCache parameter
    // Previously: constructor(apiCache: any)
    // Now: constructor(apiCache: APICache) with proper import
    this.authManager = new GitHubAuthManager(apiCache);
    this.portfolioManager = new PortfolioRepoManager();
    this.contentValidator = new ContentValidator();
  }

  async execute(params: SubmitToPortfolioParams): Promise<SubmitToPortfolioResult> {
    try {
      // Normalize user input to prevent Unicode attacks (DMCP-SEC-004)
      const normalizedName = UnicodeValidator.normalize(params.name);
      if (!normalizedName.isValid) {
        SecurityMonitor.logSecurityEvent({
          type: 'UNICODE_VALIDATION_ERROR',
          severity: 'MEDIUM',
          source: 'SubmitToPortfolioTool.execute',
          details: `Invalid Unicode in element name: ${normalizedName.detectedIssues?.[0] || 'unknown error'}`
        });
        return {
          success: false,
          message: `Invalid characters in element name: ${normalizedName.detectedIssues?.[0] || 'unknown error'}`,
          error: 'INVALID_INPUT'
        };
      }
      const safeName = normalizedName.normalizedContent;

      // 1. Check authentication status
      const authStatus = await this.authManager.getAuthStatus();
      if (!authStatus.isAuthenticated) {
        // Log authentication required (using existing event type)
        logger.warn('User attempted portfolio submission without authentication');
        return {
          success: false,
          message: 'Not authenticated. Please authenticate first using the GitHub OAuth flow.\n\n' +
                   'Visit: https://docs.anthropic.com/en/docs/claude-code/oauth-setup\n' +
                   'Or run: gh auth login --web',
          error: 'NOT_AUTHENTICATED'
        };
      }

      // 2. Find content locally with smart type detection
      let elementType = params.type;
      let localPath: string | null = null;
      
      if (elementType) {
        // Type explicitly provided - search in that specific directory only
        localPath = await this.findLocalContent(safeName, elementType);
        if (!localPath) {
          // UX IMPROVEMENT: Provide helpful suggestions for finding content
          const portfolioManager = PortfolioManager.getInstance();
          const elementDir = portfolioManager.getElementDir(elementType);
          
          return {
            success: false,
            message: `Could not find ${elementType} named "${params.name}" in local portfolio.\n\n` +
                    `**Searched in**: ${elementDir}\n\n` +
                    `**Troubleshooting Tips**:\n` +
                    `• Check if the file exists using your file explorer\n` +
                    `• Try using the exact filename (without extension)\n` +
                    `• Use \`list_portfolio\` to see all available ${elementType}\n` +
                    `• If unsure of the type, omit --type and let the system detect it\n\n` +
                    `**Common name formats that work**:\n` +
                    `• "my-element" (kebab-case)\n` +
                    `• "My Element" (with spaces)\n` +
                    `• "MyElement" (PascalCase)\n` +
                    `• Partial matches are supported`,
            error: 'CONTENT_NOT_FOUND'
          };
        }
      } else {
        // CRITICAL FIX: No type provided - implement smart detection across ALL element types
        // This prevents the previous hardcoded default to PERSONA and enables proper type detection
        const detectionResult = await this.detectElementType(safeName);
        
        if (!detectionResult.found) {
          // UX IMPROVEMENT: Enhanced guidance with specific suggestions
          const availableTypes = Object.values(ElementType).join(', ');
          
          // Get suggestions for similar names
          const suggestions = await this.generateNameSuggestions(safeName);
          
          let message = `Content "${params.name}" not found in portfolio.\n\n`;
          message += `🔍 **Searched in all element types**: ${availableTypes}\n\n`;
          
          if (suggestions.length > 0) {
            message += `💡 **Did you mean one of these?**\n`;
            for (const suggestion of suggestions.slice(0, 5)) {
              message += `  • "${suggestion.name}" (${suggestion.type})\n`;
            }
            message += `\n`;
          }
          
          message += `🛠️ **Troubleshooting Steps**:\n`;
          message += `1. 📝 Use \`list_portfolio\` to see all available content\n`;
          message += `2. 🔍 Check exact spelling and try variations:\n`;
          message += `   • "${params.name.toLowerCase()}" (lowercase)\n`;
          message += `   • "${params.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}" (normalized)\n`;
          if (params.name.includes('.')) {
            message += `   • "${params.name.replace(/\./g, '')}" (no dots)\n`;
          }
          message += `3. 🎯 Specify element type: \`submit_content "${params.name}" --type=personas\`\n`;
          message += `4. 📁 Check if file exists in portfolio directories\n\n`;
          message += `📝 **Tip**: The system searches filenames AND metadata names with fuzzy matching.`;
          
          return {
            success: false,
            message,
            error: 'CONTENT_NOT_FOUND'
          };
        }
        
        if (detectionResult.matches.length > 1) {
          // Multiple matches found - ask user to specify type
          const matchDetails = detectionResult.matches.map(m => `- ${m.type}: ${m.path}`).join('\n');
          return {
            success: false,
            message: `Content "${params.name}" found in multiple element types:\n\n${matchDetails}\n\n` +
                    `Please specify the element type using the --type parameter to avoid ambiguity.`,
            error: 'MULTIPLE_MATCHES_FOUND'
          };
        }
        
        // Single match found - use it
        const match = detectionResult.matches[0];
        elementType = match.type;
        localPath = match.path;
        
        logger.info(`Smart detection: Found "${safeName}" as ${elementType}`, { 
          name: safeName,
          detectedType: elementType,
          path: localPath
        });
      }

      // 3. Validate file size before reading
      const stats = await fs.stat(localPath);
      const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit
      if (stats.size > MAX_FILE_SIZE) {
        SecurityMonitor.logSecurityEvent({
          type: 'RATE_LIMIT_EXCEEDED',
          severity: 'MEDIUM',
          source: 'SubmitToPortfolioTool.execute',
          details: `File size ${stats.size} exceeds limit of ${MAX_FILE_SIZE}`
        });
        return {
          success: false,
          message: `File size exceeds 10MB limit`,
          error: 'FILE_TOO_LARGE'
        };
      }

      // 4. Validate content security
      const content = await fs.readFile(localPath, 'utf-8');
      const validationResult = ContentValidator.validateAndSanitize(content);

      if (!validationResult.isValid && validationResult.severity === 'critical') {
        SecurityMonitor.logSecurityEvent({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'HIGH',
          source: 'SubmitToPortfolioTool.execute',
          details: `Critical security issues detected: ${validationResult.detectedPatterns?.join(', ')}`
        });
        return {
          success: false,
          message: `Content validation failed: ${validationResult.detectedPatterns?.join(', ')}`,
          error: 'VALIDATION_FAILED'
        };
      }

      // 5. Get user consent (placeholder for now - could add interactive prompt later)
      logger.info(`Preparing to submit ${safeName} to GitHub portfolio`);

      // 6. Prepare metadata (no need for full IElement structure)
      const metadata = {
        name: safeName,
        description: `${elementType} submitted from local portfolio`,
        author: authStatus.username || 'unknown',
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        version: '1.0.0'
      };

      // 7. Get token and set on PortfolioRepoManager
      const token = await TokenManager.getGitHubTokenAsync();
      if (!token) {
        return {
          success: false,
          message: 'Could not retrieve GitHub token. Please re-authenticate.',
          error: 'TOKEN_ERROR'
        };
      }
      this.portfolioManager.setToken(token);

      // 7. Check if portfolio exists and create if needed
      const username = authStatus.username || 'unknown';
      const portfolioExists = await this.portfolioManager.checkPortfolioExists(username);
      
      if (!portfolioExists) {
        logger.info('Creating portfolio repository...');
        // Request consent for portfolio creation
        const repoUrl = await this.portfolioManager.createPortfolio(username, true);
        if (!repoUrl) {
          return {
            success: false,
            message: 'Failed to create portfolio repository',
            error: 'CREATE_FAILED'
          };
        }
      }

      // 8. Create element structure to save
      const element: PortfolioElement = {
        type: elementType,
        metadata,
        content
      };
      
      // TYPE SAFETY FIX #2: Use adapter pattern instead of complex type casting
      // Previously: element as unknown as Parameters<typeof this.portfolioManager.saveElement>[0]
      // Now: Clean adapter pattern that implements IElement interface properly
      const adapter = new PortfolioElementAdapter(element);
      
      // UX IMPROVEMENT: Add retry logic for transient failures
      const fileUrl = await this.saveElementWithRetry(adapter, safeName, elementType);
      
      if (!fileUrl) {
        return {
          success: false,
          message: 'Failed to save element to GitHub portfolio after multiple attempts.\n\n' +
                  '💡 **Troubleshooting Tips**:\n' +
                  '• Check your GitHub authentication: `gh auth status`\n' +
                  '• Verify repository permissions\n' +
                  '• Try again in a few minutes (GitHub API rate limits)\n' +
                  '• Check GitHub status: https://status.github.com',
          error: 'SAVE_FAILED'
        };
      }

      // Log successful submission (DMCP-SEC-006)
      logger.info(`Successfully submitted ${safeName} to GitHub portfolio`, {
        elementType,
        username: authStatus.username,
        fileUrl
      });

      // ENHANCEMENT (Issue #549): Ask user if they want to submit to collection
      // This completes the community contribution workflow
      const collectionSubmissionResult = await this.promptForCollectionSubmission({
        elementName: safeName,
        elementType,
        portfolioUrl: fileUrl,
        username: authStatus.username || 'unknown',
        metadata,
        token
      });

      // Build the response message based on what happened
      let message = `✅ Successfully uploaded ${safeName} to your GitHub portfolio!\n`;
      message += `📁 Portfolio URL: ${fileUrl}\n\n`;
      
      if (collectionSubmissionResult.submitted) {
        message += `🎉 Also submitted to DollhouseMCP collection for community review!\n`;
        message += `📋 Issue: ${collectionSubmissionResult.issueUrl}`;
      } else if (collectionSubmissionResult.declined) {
        message += `💡 You can submit to the collection later using the same command.`;
      } else if (collectionSubmissionResult.error) {
        message += `⚠️ Collection submission failed: ${collectionSubmissionResult.error}\n`;
        message += `💡 You can manually submit at: https://github.com/DollhouseMCP/collection/issues/new`;
      }

      return {
        success: true,
        message,
        url: fileUrl
      };

    } catch (error) {
      // Improved error handling with context preservation
      ErrorHandler.logError('submitToPortfolio', error, {
        elementName: params.name,
        elementType: params.type
      });
      
      return ErrorHandler.formatForResponse(error);
    }
  }

  /**
   * Prompts user to submit content to the DollhouseMCP collection
   * ENHANCEMENT (Issue #549): Complete the community contribution workflow
   */
  private async promptForCollectionSubmission(params: {
    elementName: string;
    elementType: ElementType;
    portfolioUrl: string;
    username: string;
    metadata: any;
    token: string;
  }): Promise<{ submitted: boolean; declined: boolean; error?: string; issueUrl?: string }> {
    try {
      // Create a simple prompt message for the user
      // Note: In MCP context, we can't do interactive prompts, so we'll need to
      // either make this automatic or require a parameter
      
      // For now, let's check if the user has set an environment variable
      // to auto-submit to collection (opt-in behavior)
      const autoSubmit = process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION === 'true';
      
      if (!autoSubmit) {
        // User hasn't opted in to auto-submission
        logger.info('Collection submission skipped (set DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION=true to enable)');
        return { submitted: false, declined: true };
      }

      logger.info('Auto-submitting to DollhouseMCP collection...');

      // Create the issue in the collection repository
      const issueUrl = await this.createCollectionIssue({
        ...params,
        token: params.token
      });

      if (issueUrl) {
        logger.info('Successfully created collection submission issue', { issueUrl });
        return { submitted: true, declined: false, issueUrl };
      } else {
        return { submitted: false, declined: false, error: 'Failed to create issue' };
      }

    } catch (error) {
      logger.error('Error in collection submission prompt', { error });
      return {
        submitted: false,
        declined: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Creates an issue in the DollhouseMCP/collection repository
   * ENHANCEMENT (Issue #549): GitHub API integration for collection submission
   */
  private async createCollectionIssue(params: {
    elementName: string;
    elementType: ElementType;
    portfolioUrl: string;
    username: string;
    metadata: any;
    token: string;
  }): Promise<string | null> {
    try {

      // Format the issue title
      const title = `[${params.elementType}] Add ${params.elementName} by @${params.username}`;

      // Format the issue body with all relevant information
      const body = `## New ${params.elementType} Submission

` +
        `**Name**: ${params.elementName}\n` +
        `**Author**: @${params.username}\n` +
        `**Type**: ${params.elementType}\n` +
        `**Description**: ${params.metadata.description || 'No description provided'}\n\n` +
        `### Portfolio Link\n` +
        `${params.portfolioUrl}\n\n` +
        `### Metadata\n` +
        `\`\`\`json\n${JSON.stringify(params.metadata, null, 2)}\n\`\`\`\n\n` +
        `### Review Checklist\n` +
        `- [ ] Content is appropriate and follows community guidelines\n` +
        `- [ ] No security vulnerabilities or malicious patterns\n` +
        `- [ ] Metadata is complete and accurate\n` +
        `- [ ] Element works as described\n` +
        `- [ ] No duplicate of existing collection content\n\n` +
        `---\n` +
        `*This submission was created automatically via the DollhouseMCP submit_content tool.*`;

      // Determine labels based on element type
      const labels = [
        'contribution',  // All submissions get this
        'pending-review', // Needs review
        params.elementType.toLowerCase() // Element type label
      ];

      // Create the issue using GitHub REST API directly
      // SECURITY IMPROVEMENT: Add timeout to prevent hanging connections
      const url = 'https://api.github.com/repos/DollhouseMCP/collection/issues';
      
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
      
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `Bearer ${params.token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'DollhouseMCP/1.0'
          },
          body: JSON.stringify({
            title,
            body,
            labels
          }),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          logger.error('GitHub API error creating issue', { 
            status: response.status, 
            statusText: response.statusText,
            error: errorText 
          });
          
          if (response.status === 404) {
            logger.error('Collection repository not found or no access');
          } else if (response.status === 403) {
            logger.error('Permission denied to create issue in collection repo');
          } else if (response.status === 401) {
            logger.error('Authentication failed for collection submission');
          }
          return null;
        }

        const data = await response.json();
        return data.html_url;
        
      } catch (fetchError: any) {
        // Re-throw to outer catch block
        throw fetchError;
      } finally {
        clearTimeout(timeoutId);
      }

    } catch (error: any) {
      // Handle timeout specifically
      if (error.name === 'AbortError') {
        logger.error('GitHub API request timeout after 30 seconds');
      } else {
        logger.error('Failed to create collection issue', { 
          error: error.message || error
        });
      }
      return null;
    }
  }

  private async findLocalContent(name: string, type: ElementType): Promise<string | null> {
    try {
      // METADATA INDEX FIX: Use portfolio index for fast metadata-based lookups
      // This solves the critical issue where "Safe Roundtrip Tester" couldn't be found
      // because findLocalContent only searched filenames, not metadata names
      const indexManager = PortfolioIndexManager.getInstance();
      
      // UX IMPROVEMENT: Enhanced search with fuzzy matching
      const indexEntry = await indexManager.findByName(name, { 
        elementType: type,
        fuzzyMatch: true
      });
      
      if (indexEntry) {
        logger.debug('Found content via metadata index', { 
          searchName: name, 
          metadataName: indexEntry.metadata.name,
          filename: indexEntry.filename,
          filePath: indexEntry.filePath,
          type 
        });
        return indexEntry.filePath;
      }
      
      // FALLBACK: Use original file discovery if index lookup fails
      // This maintains backward compatibility and handles edge cases
      logger.debug('Index lookup failed, falling back to file discovery', { name, type });
      
      const portfolioManager = PortfolioManager.getInstance();
      const portfolioDir = portfolioManager.getElementDir(type);
      
      // UX IMPROVEMENT: Try multiple search strategies for better user experience
      let file = await FileDiscoveryUtil.findFile(portfolioDir, name, {
        extensions: ['.md', '.json', '.yaml', '.yml'],
        partialMatch: true,
        cacheResults: true
      });
      
      // If not found, try normalizing the name (e.g., "J.A.R.V.I.S." -> "j-a-r-v-i-s")
      if (!file) {
        const normalizedName = name.toLowerCase()
          .replace(/[^a-z0-9]/gi, '-')  // Replace non-alphanumeric with dashes
          .replace(/-+/g, '-')         // Replace multiple dashes with single dash
          .replace(/^-|-$/g, '');      // Remove leading/trailing dashes
          
        if (normalizedName !== name.toLowerCase()) {
          logger.debug('Trying normalized name search', { 
            original: name, 
            normalized: normalizedName,
            type 
          });
          
          file = await FileDiscoveryUtil.findFile(portfolioDir, normalizedName, {
            extensions: ['.md', '.json', '.yaml', '.yml'],
            partialMatch: true,
            cacheResults: true
          });
        }
      }
      
      // If still not found, try searching by display name patterns
      if (!file) {
        // Try common variations like removing dots, spaces, etc.
        const variations = [
          name.replace(/\./g, ''),        // Remove dots: "J.A.R.V.I.S." -> "JARVIS"
          name.replace(/\s+/g, '-'),      // Replace spaces with dashes
          name.replace(/[\s\.]/g, ''),    // Remove spaces and dots
          name.replace(/[\s\.]/g, '-'),   // Replace spaces and dots with dashes
        ].filter(v => v !== name && v.length > 0);
        
        for (const variation of variations) {
          file = await FileDiscoveryUtil.findFile(portfolioDir, variation, {
            extensions: ['.md', '.json', '.yaml', '.yml'],
            partialMatch: true,
            cacheResults: true
          });
          
          if (file) {
            logger.debug('Found content using name variation', {
              original: name,
              variation,
              file,
              type
            });
            break;
          }
        }
      }
      
      if (file) {
        logger.debug('Found local content file via fallback', { name, type, file });
        return file;
      }
      
      logger.debug('No content found', { name, type });
      return null;
      
    } catch (error) {
      logger.error('Error finding local content', {
        name,
        type,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Smart element type detection - searches across ALL element types for content
   * This replaces the previous hardcoded default to PERSONA and enables proper type detection
   * 
   * @param name The content name to search for
   * @returns Detection result with found matches across all element types
   */
  private async detectElementType(name: string): Promise<ElementDetectionResult> {
    try {
      // PERFORMANCE OPTIMIZATION: Search all element directories in parallel
      // This dynamically handles ALL element types from the ElementType enum
      // If new element types are added, this code automatically searches them
      const searchPromises = Object.values(ElementType).map(async (type) => {
        try {
          const filePath = await this.findLocalContent(name, type);
          if (filePath) {
            return { type: type as ElementType, path: filePath };
          }
          return null;
        } catch (error: any) {
          // Log unexpected errors but continue search
          if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
            logger.warn(`Unexpected error searching ${type} directory for content detection`, { 
              name,
              type,
              error: error?.message || String(error),
              code: error?.code 
            });
          }
          return null;
        }
      });

      // Wait for all searches to complete
      const searchResults = await Promise.allSettled(searchPromises);
      const matches: ElementDetectionMatch[] = [];

      // Collect all successful matches
      for (const result of searchResults) {
        if (result.status === 'fulfilled' && result.value) {
          matches.push(result.value);
        }
      }

      logger.debug(`Element type detection completed`, { 
        name, 
        totalMatches: matches.length,
        matchedTypes: matches.map(m => m.type)
      });

      return {
        found: matches.length > 0,
        matches
      };

    } catch (error) {
      logger.error('Error in element type detection', {
        name,
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Return empty result on detection failure
      return {
        found: false,
        matches: []
      };
    }
  }

  /**
   * UX IMPROVEMENT: Generate name suggestions for similar content
   * Helps users find content when exact matches fail
   */
  private async generateNameSuggestions(searchName: string): Promise<Array<{name: string, type: string}>> {
    try {
      const suggestions: Array<{name: string, type: string}> = [];
      const searchLower = searchName.toLowerCase();
      
      // Get all available content across all types
      for (const elementType of Object.values(ElementType)) {
        try {
          const portfolioManager = PortfolioManager.getInstance();
          const elementDir = portfolioManager.getElementDir(elementType);
          
          // Get files in this directory
          const files = await FileDiscoveryUtil.findFile(elementDir, '*', {
            extensions: ['.md', '.json', '.yaml', '.yml'],
            partialMatch: false,
            cacheResults: true
          });
          
          if (Array.isArray(files)) {
            for (const filePath of files) {
              const basename = path.basename(filePath, path.extname(filePath));
              
              // Calculate similarity using simple metrics
              if (this.calculateSimilarity(searchLower, basename.toLowerCase()) > 0.3) {
                suggestions.push({
                  name: basename,
                  type: elementType
                });
              }
            }
          } else if (files) {
            const basename = path.basename(files, path.extname(files));
            if (this.calculateSimilarity(searchLower, basename.toLowerCase()) > 0.3) {
              suggestions.push({
                name: basename,
                type: elementType
              });
            }
          }
        } catch (error) {
          // Skip this type if there's an error
          continue;
        }
      }
      
      // Sort by similarity (higher is better)
      return suggestions.sort((a, b) => {
        const simA = this.calculateSimilarity(searchLower, a.name.toLowerCase());
        const simB = this.calculateSimilarity(searchLower, b.name.toLowerCase());
        return simB - simA;
      });
      
    } catch (error) {
      logger.warn('Failed to generate name suggestions', { searchName, error });
      return [];
    }
  }
  
  /**
   * Simple similarity calculation using Levenshtein-like approach
   * Returns value between 0 and 1, where 1 is identical
   */
  private calculateSimilarity(str1: string, str2: string): number {
    // Handle exact matches
    if (str1 === str2) return 1;
    
    // Handle substring matches
    if (str1.includes(str2) || str2.includes(str1)) return 0.8;
    
    // Handle partial matches
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 0;
    
    // Count common characters
    let common = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (longer.includes(shorter[i])) {
        common++;
      }
    }
    
    return common / longer.length;
  }
  
  /**
   * UX IMPROVEMENT: Save element with automatic retry logic for transient failures
   * Handles common GitHub API issues like rate limits and temporary network problems
   */
  private async saveElementWithRetry(
    adapter: PortfolioElementAdapter, 
    elementName: string, 
    elementType: ElementType,
    maxRetries: number = 3
  ): Promise<string | null> {
    let lastError: any = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.debug(`Attempting to save element (attempt ${attempt}/${maxRetries})`, {
          elementName,
          elementType,
          attempt
        });
        
        const fileUrl = await this.portfolioManager.saveElement(adapter, true);
        
        if (fileUrl) {
          if (attempt > 1) {
            logger.info(`Element saved successfully after ${attempt} attempts`, {
              elementName,
              elementType,
              fileUrl
            });
          }
          return fileUrl;
        }
        
        // If saveElement returns null, treat as a failure but don't retry immediately
        lastError = new Error(`saveElement returned null on attempt ${attempt}`);
        
      } catch (error: any) {
        lastError = error;
        const isRetryable = this.isRetryableError(error);
        
        logger.warn(`Save attempt ${attempt} failed`, {
          elementName,
          elementType,
          attempt,
          error: error.message,
          isRetryable,
          willRetry: isRetryable && attempt < maxRetries
        });
        
        // If this is not a retryable error, fail immediately
        if (!isRetryable) {
          logger.error('Non-retryable error encountered, aborting retries', {
            elementName,
            error: error.message
          });
          break;
        }
        
        // If we have more attempts, wait before retrying
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff, max 5s
          logger.debug(`Waiting ${delay}ms before retry`, { attempt, delay });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    // All attempts failed
    logger.error(`All ${maxRetries} save attempts failed`, {
      elementName,
      elementType,
      lastError: lastError?.message
    });
    
    return null;
  }
  
  /**
   * Determine if an error is worth retrying
   * Retryable: network issues, rate limits, temporary GitHub API problems
   * Non-retryable: authentication issues, validation errors, permanent failures
   */
  private isRetryableError(error: any): boolean {
    const errorMessage = error?.message?.toLowerCase() || '';
    const errorCode = error?.code;
    const statusCode = error?.status || error?.statusCode;
    
    // Network and timeout errors
    if (errorCode === 'ENOTFOUND' || errorCode === 'ECONNRESET' || errorCode === 'ETIMEDOUT') {
      return true;
    }
    
    // GitHub API rate limits
    if (statusCode === 429 || errorMessage.includes('rate limit')) {
      return true;
    }
    
    // Temporary GitHub API issues
    if (statusCode >= 500 && statusCode < 600) {
      return true;
    }
    
    // Temporary GitHub API problems
    if (errorMessage.includes('temporarily unavailable') || 
        errorMessage.includes('service unavailable') ||
        errorMessage.includes('internal server error')) {
      return true;
    }
    
    // Connection issues
    if (errorMessage.includes('connection') && 
        (errorMessage.includes('timeout') || errorMessage.includes('reset'))) {
      return true;
    }
    
    // Don't retry authentication or permission issues
    if (statusCode === 401 || statusCode === 403 || 
        errorMessage.includes('unauthorized') || 
        errorMessage.includes('forbidden') ||
        errorMessage.includes('authentication')) {
      return false;
    }
    
    // Don't retry validation errors
    if (statusCode === 400 || statusCode === 422 ||
        errorMessage.includes('invalid') ||
        errorMessage.includes('validation')) {
      return false;
    }
    
    // Default to not retrying for unknown errors to avoid infinite loops
    return false;
  }
}