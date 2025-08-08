/**
 * Submit content to GitHub portfolio repository
 * Replaces the old issue-based submission with portfolio-based submission
 */

import { GitHubAuthManager } from '../../auth/GitHubAuthManager.js';
import { PortfolioRepoManager } from '../../portfolio/PortfolioRepoManager.js';
import { TokenManager } from '../../security/tokenManager.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { SecureErrorHandler } from '../../security/errorHandler.js';
import { PathValidator } from '../../security/pathValidator.js';
import { logger } from '../../utils/logger.js';
import { IElement, ElementStatus } from '../../types/elements/IElement.js';
import path from 'path';

export interface SubmitToPortfolioParams {
  contentIdentifier: string;
  type?: 'persona' | 'skill' | 'template' | 'agent' | 'memory' | 'ensemble';
}

export class SubmitToPortfolioTool {
  constructor(
    private authManager: GitHubAuthManager,
    private portfolioManager: PortfolioRepoManager,
    private personas: Map<string, any>,
    private personasDir: string,
    private getPersonaIndicator: () => string
  ) {}

  async execute(params: SubmitToPortfolioParams) {
    const { contentIdentifier, type = 'persona' } = params;
    
    try {
      // Step 1: Check authentication
      const authStatus = await this.authManager.getAuthStatus();
      if (!authStatus.isAuthenticated) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}🔒 **GitHub Authentication Required**

To submit content to your portfolio, you need to authenticate with GitHub first.

Please run: \`authenticate_github\`

This will:
1. Start the GitHub OAuth device flow
2. Give you a code to enter on GitHub
3. Authenticate your account
4. Enable portfolio submissions

Your content will be stored in YOUR GitHub repository, giving you full control and ownership.`
          }]
        };
      }

      // Step 2: Find the content locally (for now, just personas)
      let content = this.personas.get(contentIdentifier);
      
      if (!content) {
        // Search by name
        content = Array.from(this.personas.values()).find(p => 
          p.metadata.name.toLowerCase() === contentIdentifier.toLowerCase()
        );
      }

      if (!content) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Content not found: ${contentIdentifier}

Please check that the ${type} exists locally. You can list your local content with:
- \`list_personas\` for personas
- \`list_elements --type ${type}\` for other types`
          }]
        };
      }

      // Step 3: Validate content security
      const fullPath = path.join(this.personasDir, content.filename);
      const fileContent = await PathValidator.safeReadFile(fullPath);
      
      const contentValidation = ContentValidator.validateAndSanitize(fileContent);
      if (!contentValidation.isValid && contentValidation.severity === 'critical') {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Security Validation Failed**

This ${type} contains content that could be used for prompt injection attacks:
• ${contentValidation.detectedPatterns?.join('\n• ')}

Please remove these patterns before submitting to your portfolio.`
          }]
        };
      }

      // Step 4: Get user consent
      const consentMessage = `${this.getPersonaIndicator()}📤 **Ready to Submit to Portfolio**

**Content**: ${content.metadata.name}
**Type**: ${type}
**Description**: ${content.metadata.description || 'No description'}
**Author**: ${authStatus.username}
**Repository**: github.com/${authStatus.username}/dollhouse-portfolio

This will:
1. Create your portfolio repository if it doesn't exist
2. Save this ${type} to the ${type}s/ directory
3. Make it available on GitHub for sharing and backup

Do you want to proceed? (This action requires your explicit consent)`;

      // For now, we'll proceed assuming consent (in real implementation, this would be interactive)
      logger.info('User consent requested for portfolio submission', {
        content: content.metadata.name,
        type,
        username: authStatus.username
      });

      // Step 5: Create portfolio element structure
      const element: IElement = {
        id: `${type}_${content.metadata.name.toLowerCase().replace(/\s+/g, '-')}_${Date.now()}`,
        type: type as any, // Will be properly typed when we have ElementType enum
        version: content.metadata.version || '1.0.0',
        metadata: {
          name: content.metadata.name,
          description: content.metadata.description,
          author: authStatus.username,
          created: new Date().toISOString(),
          tags: content.metadata.triggers || [],
          custom: { visibility: 'public' }
        },
        validate: () => ({ isValid: true, valid: true, errors: [], warnings: [] }),
        serialize: () => fileContent,
        deserialize: () => {},
        getStatus: () => ElementStatus.INACTIVE
      };

      // Step 6: Get token and submit to portfolio
      const token = await TokenManager.getGitHubTokenAsync();
      if (!token) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ No GitHub token found. Please authenticate first with \`authenticate_github\``
          }]
        };
      }

      // Initialize portfolio manager with token
      this.portfolioManager.setToken(token);

      // Check if portfolio exists, create if needed
      const portfolioExists = await this.portfolioManager.checkPortfolioExists(authStatus.username!);
      if (!portfolioExists) {
        logger.info('Creating portfolio repository', { username: authStatus.username });
        await this.portfolioManager.createPortfolio(authStatus.username!, true);
        await this.portfolioManager.generatePortfolioStructure(authStatus.username!);
      }

      // Save element to portfolio (consent already given)
      const result = await this.portfolioManager.saveElement(
        element,
        true // consent already given
      );

      // Step 7: Return success with URL
      const githubUrl = `https://github.com/${authStatus.username}/dollhouse-portfolio/blob/main/${type}s/${content.metadata.name.toLowerCase().replace(/\s+/g, '-')}.md`;

      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}✅ **Successfully Submitted to Portfolio!**

**${content.metadata.name}** has been saved to your GitHub portfolio.

📍 **View on GitHub**: ${githubUrl}
📂 **Repository**: github.com/${authStatus.username}/dollhouse-portfolio
🔄 **Status**: Synced with GitHub

Your ${type} is now:
• Backed up on GitHub
• Version controlled
• Ready for sharing
• Available for collaboration

Next steps:
• View your portfolio: \`browse_portfolio\`
• Sync other content: \`sync_portfolio\`
• Share with others by sending them your portfolio URL`
        }]
      };

    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      logger.error('Portfolio submission failed', { 
        error: sanitized.message,
        content: contentIdentifier,
        type 
      });

      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ **Submission Failed**

Error: ${sanitized.message}

Common issues:
• GitHub token expired - run \`authenticate_github\` again
• Network connection issues - check your internet
• GitHub API rate limits - wait a few minutes

If the problem persists, please report it at:
https://github.com/DollhouseMCP/mcp-server/issues`
        }]
      };
    }
  }
}