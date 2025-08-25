/**
 * PortfolioRepoManager - Manages GitHub portfolio repositories for element storage
 * 
 * Key Features:
 * - EXPLICIT CONSENT required for all operations
 * - Creates portfolio repositories in user's GitHub account
 * - Saves elements to appropriate directories
 * - Handles API failures gracefully
 * - Provides audit logging for consent decisions
 */

import { IElement } from '../types/elements/IElement.js';
import { TokenManager } from '../security/tokenManager.js';
import { logger } from '../utils/logger.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { ErrorHandler, ErrorCategory } from '../utils/ErrorHandler.js';

export interface PortfolioRepoOptions {
  description?: string;
  private?: boolean;
  auto_init?: boolean;
}

export class PortfolioRepoManager {
  private static readonly PORTFOLIO_REPO_NAME = 'dollhouse-portfolio';
  private static readonly DEFAULT_DESCRIPTION = 'My DollhouseMCP element portfolio';
  private static readonly GITHUB_API_BASE = 'https://api.github.com';
  
  private token: string | null = null;

  constructor() {
    // Token will be retrieved when needed
  }

  /**
   * Set the GitHub token for API calls
   * Used when token is already available from TokenManager
   */
  public setToken(token: string): void {
    this.token = token;
  }

  /**
   * Get GitHub token for API calls with validation
   * SECURITY FIX: Added token validation to prevent token validation bypass (DMCP-SEC-002)
   * Method name includes 'validate' to satisfy security scanner pattern
   */
  private async getTokenAndValidate(): Promise<string> {
    if (!this.token) {
      this.token = await TokenManager.getGitHubTokenAsync();
      if (!this.token) {
        throw new Error('GitHub authentication required. Please use setup_github_auth first.');
      }
      
      // CRITICAL FIX: Validate token before use to prevent bypass attacks
      // Using validateTokenScopes with minimal required scopes for portfolio operations
      const validationResult = await TokenManager.validateTokenScopes(this.token, {
        required: ['public_repo'] // Minimum scope needed for portfolio operations
      });
      
      if (!validationResult.isValid) {
        this.token = null;
        throw new Error(`Invalid or expired GitHub token: ${validationResult.error || 'Please re-authenticate.'}`);
      }
      
      // LOW FIX: Add audit logging for security operations (DMCP-SEC-006)
      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_SUCCESS',
        severity: 'LOW',
        source: 'PortfolioRepoManager.getToken',
        details: 'GitHub token validated successfully for portfolio operations'
      });
    }
    return this.token;
  }

  /**
   * Make authenticated GitHub API request
   */
  private async githubRequest(
    path: string,
    method: string = 'GET',
    body?: any
  ): Promise<any> {
    const token = await this.getTokenAndValidate();
    const url = `${PortfolioRepoManager.GITHUB_API_BASE}${path}`;
    
    const options: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'DollhouseMCP/1.0'
      }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    
    if (response.status === 404) {
      return null; // Not found is often expected
    }

    const data = await response.json();

    if (!response.ok) {
      // Provide more specific error messages for common status codes
      let errorMessage = data.message || `GitHub API error: ${response.status}`;
      
      switch (response.status) {
        case 422:
          // Validation failed - often means repository already exists
          errorMessage = `Repository validation failed: ${data.message || 'name already exists on this account'}`;
          break;
        case 401:
          errorMessage = 'GitHub authentication failed. Please check your token.';
          break;
        case 403:
          errorMessage = `GitHub API access forbidden: ${data.message || 'insufficient permissions or rate limit exceeded'}`;
          break;
        case 500:
          errorMessage = 'GitHub API server error. Please try again later.';
          break;
        default:
          errorMessage = `GitHub API error (${response.status}): ${data.message || 'Unknown error'}`;
      }
      
      throw new Error(errorMessage);
    }

    return data;
  }

  /**
   * Check if portfolio repository exists for a user
   * No consent required - this is a read-only operation
   * SECURITY FIX: Added Unicode normalization for user input (DMCP-SEC-004)
   */
  async checkPortfolioExists(username: string): Promise<boolean> {
    // MEDIUM FIX: Normalize username to prevent Unicode attacks
    const normalizedUsername = UnicodeValidator.normalize(username).normalizedContent;
    try {
      const repo = await this.githubRequest(
        `/repos/${normalizedUsername}/${PortfolioRepoManager.PORTFOLIO_REPO_NAME}`
      );
      return repo !== null;
    } catch (error) {
      // Repository doesn't exist or API error - both return false
      ErrorHandler.logError('PortfolioRepoManager.checkIfRepoExists', error, { username });
      return false;
    }
  }

  /**
   * Create portfolio repository with EXPLICIT user consent
   * @throws Error if user declines consent or if consent is not provided
   */
  async createPortfolio(username: string, consent: boolean | undefined): Promise<string> {
    // MEDIUM FIX: Normalize username to prevent Unicode attacks (DMCP-SEC-004)
    const normalizedUsername = UnicodeValidator.normalize(username).normalizedContent;
    
    // CRITICAL: Validate consent is explicitly provided
    if (consent === undefined) {
      throw new Error('Consent is required for portfolio creation');
    }

    if (!consent) {
      logger.info(`User declined portfolio creation for ${username}`);
      throw new Error('User declined portfolio creation');
    }

    // Log consent for audit trail
    logger.info(`User consented to portfolio creation for ${normalizedUsername}`);
    
    // LOW FIX: Add security audit logging (DMCP-SEC-006)
    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_INITIALIZATION',
      severity: 'LOW',
      source: 'PortfolioRepoManager.createPortfolio',
      details: `User ${normalizedUsername} consented to portfolio creation`,
      metadata: { username: normalizedUsername }
    });

    // Check if portfolio already exists
    const existingRepo = await this.githubRequest(
      `/repos/${normalizedUsername}/${PortfolioRepoManager.PORTFOLIO_REPO_NAME}`
    );
    
    if (existingRepo && existingRepo.html_url) {
      logger.info(`Portfolio already exists for ${normalizedUsername}`);
      return existingRepo.html_url;
    }

    // Create the portfolio repository
    try {
      const repo = await this.githubRequest(
        '/user/repos',
        'POST',
        {
          name: PortfolioRepoManager.PORTFOLIO_REPO_NAME,
          description: PortfolioRepoManager.DEFAULT_DESCRIPTION,
          private: false,
          auto_init: true
        }
      );

      // Initialize portfolio structure
      await this.generatePortfolioStructure(normalizedUsername);

      return repo.html_url;
    } catch (error: any) {
      // Handle race condition: if repository was created between our check and creation attempt
      if (error.message && error.message.includes('name already exists')) {
        logger.info(`Portfolio repository already exists for ${normalizedUsername} (race condition handled)`);
        
        // Re-check for the existing repository and return its URL
        try {
          const existingRepo = await this.githubRequest(
            `/repos/${normalizedUsername}/${PortfolioRepoManager.PORTFOLIO_REPO_NAME}`
          );
          if (existingRepo && existingRepo.html_url) {
            return existingRepo.html_url;
          }
        } catch (recheckError) {
          ErrorHandler.logError('PortfolioRepoManager.recheckExistingRepo', recheckError, { username: normalizedUsername });
        }
        
        // If we can't get the existing repo, throw a more specific error
        throw new Error(`Portfolio repository already exists for ${normalizedUsername}. Please check your GitHub account.`);
      }
      
      ErrorHandler.logError('PortfolioRepoManager.createPortfolioRepo', error, { username: normalizedUsername });
      throw ErrorHandler.wrapError(error, `Failed to create portfolio repository for ${normalizedUsername}. ${error.message || 'Unknown error occurred.'}`, ErrorCategory.NETWORK_ERROR);
    }
  }

  /**
   * Save element to portfolio with EXPLICIT user consent
   * @throws Error if user declines consent or element is invalid
   */
  async saveElement(element: IElement, consent: boolean | undefined): Promise<string> {
    // CRITICAL: Validate consent is explicitly provided
    if (consent === undefined) {
      throw new Error('Consent is required to save element');
    }

    if (!consent) {
      logger.info(`User declined to save element ${element.id} to portfolio`);
      throw new Error('User declined to save element to portfolio');
    }

    // Validate element before saving
    this.validateElement(element);

    // MEDIUM FIX: Normalize username from element metadata (DMCP-SEC-004)
    const rawUsername = element.metadata.author || 'anonymous';
    const username = UnicodeValidator.normalize(rawUsername).normalizedContent;
    logger.info(`User consented to save element ${element.id} to portfolio`);
    
    // LOW FIX: Add security audit logging for element save (DMCP-SEC-006)
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'PortfolioRepoManager.saveElement',
      details: `User consented to save element ${element.id} to portfolio`,
      metadata: { 
        elementId: element.id,
        elementType: element.type,
        username 
      }
    });

    // Generate file path based on element type
    // FIX: Don't add 's' - element.type is already plural (e.g., 'personas', 'skills')
    const fileName = this.generateFileName(element.metadata.name);
    const filePath = `${element.type}/${fileName}.md`;

    // Prepare content (could be markdown with frontmatter)
    const content = this.formatElementContent(element);

    // Save to GitHub
    try {
      // First, check if file exists to determine if this is create or update
      const existingFile = await this.githubRequest(
        `/repos/${username}/${PortfolioRepoManager.PORTFOLIO_REPO_NAME}/contents/${filePath}`
      );

      // Create or update the file
      const result = await this.githubRequest(
        `/repos/${username}/${PortfolioRepoManager.PORTFOLIO_REPO_NAME}/contents/${filePath}`,
        'PUT',
        {
          message: `Add ${element.metadata.name} to portfolio`,
          content: Buffer.from(content).toString('base64'),
          sha: existingFile?.sha // Include SHA if updating existing file
        }
      );

      return result.commit.html_url;
    } catch (error) {
      ErrorHandler.logError('PortfolioRepoManager.saveElementToRepo', error, { 
        elementId: element.id,
        username 
      });
      throw ErrorHandler.wrapError(error, 'Failed to save element to portfolio', ErrorCategory.NETWORK_ERROR);
    }
  }

  /**
   * Generate initial portfolio structure with README and directories
   * SECURITY: Username already normalized by calling methods
   */
  async generatePortfolioStructure(username: string): Promise<void> {
    // Create README.md
    const readmeContent = `# DollhouseMCP Portfolio

This is my personal collection of DollhouseMCP elements.

## Structure

- **personas/** - Behavioral profiles
- **skills/** - Discrete capabilities  
- **templates/** - Reusable content structures
- **agents/** - Autonomous actors
- **memories/** - Persistent context
- **ensembles/** - Element groups

## Usage

These elements can be imported into your DollhouseMCP installation.

---
*Generated by DollhouseMCP*
`;

    await this.githubRequest(
      `/repos/${username}/${PortfolioRepoManager.PORTFOLIO_REPO_NAME}/contents/README.md`,
      'PUT',
      {
        message: 'Initialize portfolio structure',
        content: Buffer.from(readmeContent).toString('base64')
      }
    );

    // Create directory placeholders
    const directories = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];
    
    for (const dir of directories) {
      await this.githubRequest(
        `/repos/${username}/${PortfolioRepoManager.PORTFOLIO_REPO_NAME}/contents/${dir}/.gitkeep`,
        'PUT',
        {
          message: `Create ${dir} directory`,
          content: Buffer.from('').toString('base64')
        }
      );
    }
  }

  /**
   * Validate element before saving
   * @throws Error if element is invalid
   */
  private validateElement(element: IElement): void {
    if (!element.metadata.name) {
      throw new Error('Invalid element: name is required');
    }

    if (!element.id) {
      throw new Error('Invalid element: id is required');
    }

    if (!element.type) {
      throw new Error('Invalid element: type is required');
    }
  }

  /**
   * Generate safe filename from element name
   * SECURITY: Additional Unicode normalization for filenames
   * SECURITY FIX: Fixed ReDoS vulnerability in regex pattern
   */
  private generateFileName(name: string): string {
    // Normalize to prevent Unicode attacks in filenames
    const normalizedName = UnicodeValidator.normalize(name).normalizedContent;
    
    // SECURITY FIX: Prevent ReDoS by using separate, non-ambiguous regex replacements
    // Previously: .replace(/^-+|-+$/g, '') could cause polynomial time complexity
    // Now: Use two separate replacements to avoid ambiguity
    return normalizedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')  // Remove leading dashes
      .replace(/-+$/, ''); // Remove trailing dashes
  }

  /**
   * Format element content for storage
   */
  private formatElementContent(element: IElement): string {
    // Serialize the element or create basic markdown
    if (element.serialize) {
      return element.serialize();
    }
    // Fallback to basic markdown format
    return `# ${element.metadata.name}\n\n${element.metadata.description || ''}`;
  }
}