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
import * as path from 'path';
import * as fs from 'fs/promises';

export interface SubmitToPortfolioParams {
  name: string;
  type?: ElementType;
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

  constructor(apiCache: any) {
    this.authManager = new GitHubAuthManager(apiCache);
    this.portfolioManager = new PortfolioRepoManager();
    this.contentValidator = new ContentValidator();
  }

  async execute(params: SubmitToPortfolioParams): Promise<SubmitToPortfolioResult> {
    try {
      // 1. Check authentication status
      const authStatus = await this.authManager.getAuthStatus();
      if (!authStatus.isAuthenticated) {
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
      const localPath = await this.findLocalContent(params.name, elementType);
      if (!localPath) {
        return {
          success: false,
          message: `Could not find ${elementType} named "${params.name}" in local portfolio`,
          error: 'CONTENT_NOT_FOUND'
        };
      }

      // 3. Validate content security
      const content = await fs.readFile(localPath, 'utf-8');
      const validationResult = ContentValidator.validateAndSanitize(content);

      if (!validationResult.isValid && validationResult.severity === 'critical') {
        return {
          success: false,
          message: `Content validation failed: ${validationResult.detectedPatterns?.join(', ')}`,
          error: 'VALIDATION_FAILED'
        };
      }

      // 4. Get user consent (placeholder for now - could add interactive prompt later)
      logger.info(`Preparing to submit ${params.name} to GitHub portfolio`);

      // 5. Prepare metadata (no need for full IElement structure)
      const metadata = {
        name: params.name,
        description: `${elementType} submitted from local portfolio`,
        author: authStatus.username || 'unknown',
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        version: '1.0.0'
      };

      // 6. Get token and set on PortfolioRepoManager
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
      const element = {
        type: elementType,
        metadata,
        content
      };
      
      // Save element with consent
      const fileUrl = await this.portfolioManager.saveElement(element as any, true);
      
      if (!fileUrl) {
        return {
          success: false,
          message: 'Failed to save element to GitHub portfolio',
          error: 'SAVE_FAILED'
        };
      }

      return {
        success: true,
        message: `Successfully submitted ${params.name} to your GitHub portfolio!`,
        url: fileUrl
      };

    } catch (error) {
      logger.error('Error in submitToPortfolio:', error);
      return {
        success: false,
        message: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
        error: 'UNEXPECTED_ERROR'
      };
    }
  }

  private async findLocalContent(name: string, type: ElementType): Promise<string | null> {
    try {
      // Get the portfolio directory for this element type
      const portfolioManager = PortfolioManager.getInstance();
      const portfolioDir = portfolioManager.getElementDir(type);
      
      // Look for files matching the name (with or without .md extension)
      const possibleFiles = [
        `${name}.md`,
        `${name}`,
        `${name.toLowerCase()}.md`,
        `${name.toLowerCase()}`
      ];

      for (const fileName of possibleFiles) {
        const filePath = path.join(portfolioDir, fileName);
        try {
          await fs.access(filePath);
          return filePath;
        } catch {
          // File doesn't exist, try next
          continue;
        }
      }

      // Also check for partial matches
      const files = await fs.readdir(portfolioDir);
      const match = files.find(file => 
        file.toLowerCase().includes(name.toLowerCase())
      );

      if (match) {
        return path.join(portfolioDir, match);
      }

      return null;
    } catch (error) {
      logger.error(`Error finding local content: ${error}`);
      return null;
    }
  }
}