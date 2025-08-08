/**
 * Tool for submitting content to GitHub portfolio repositories
 * Replaces the broken issue-based submission with direct repository saves
 */

import { GitHubAuthManager } from '../../auth/GitHubAuthManager.js';
import { PortfolioRepoManager } from '../../portfolio/PortfolioRepoManager.js';
import { TokenManager } from '../../security/tokenManager.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { ElementType } from '../../portfolio/types.js';
import { logger } from '../../utils/logger.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { APICache } from '../../cache/APICache.js';
import { PortfolioElementAdapter } from './PortfolioElementAdapter.js';
import { FileDiscoveryUtil } from '../../utils/FileDiscoveryUtil.js';
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

export class SubmitToPortfolioTool {
  private authManager: GitHubAuthManager;
  private portfolioManager: PortfolioRepoManager;
  private contentValidator: ContentValidator;

  constructor(apiCache: APICache) {
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

      // 2. Find content locally
      const elementType = params.type || ElementType.PERSONA;
      const localPath = await this.findLocalContent(safeName, elementType);
      if (!localPath) {
        return {
          success: false,
          message: `Could not find ${elementType} named "${params.name}" in local portfolio`,
          error: 'CONTENT_NOT_FOUND'
        };
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
      
      // Convert to IElement using adapter for type safety
      const adapter = new PortfolioElementAdapter(element);
      const fileUrl = await this.portfolioManager.saveElement(adapter, true);
      
      if (!fileUrl) {
        return {
          success: false,
          message: 'Failed to save element to GitHub portfolio',
          error: 'SAVE_FAILED'
        };
      }

      // Log successful submission (DMCP-SEC-006)
      logger.info(`Successfully submitted ${safeName} to GitHub portfolio`, {
        elementType,
        username: authStatus.username,
        fileUrl
      });

      return {
        success: true,
        message: `Successfully submitted ${safeName} to your GitHub portfolio!`,
        url: fileUrl
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error in submitToPortfolio:', error);
      
      // Log failure (DMCP-SEC-006)

      return {
        success: false,
        message: `Unexpected error: ${errorMessage}`,
        error: 'UNEXPECTED_ERROR'
      };
    }
  }

  private async findLocalContent(name: string, type: ElementType): Promise<string | null> {
    try {
      // Get the portfolio directory for this element type
      const portfolioManager = PortfolioManager.getInstance();
      const portfolioDir = portfolioManager.getElementDir(type);
      
      // Use optimized file discovery utility
      const file = await FileDiscoveryUtil.findFile(portfolioDir, name, {
        extensions: ['.md', '.json', '.yaml', '.yml'],
        partialMatch: true,
        cacheResults: true
      });
      
      if (file) {
        logger.debug('Found local content file', { name, type, file });
      }
      
      return file;
    } catch (error) {
      logger.error('Error finding local content', {
        name,
        type,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
}