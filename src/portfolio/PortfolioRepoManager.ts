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
   * Get GitHub token for API calls
   */
  private async getToken(): Promise<string> {
    if (!this.token) {
      this.token = await TokenManager.getGitHubTokenAsync();
      if (!this.token) {
        throw new Error('GitHub authentication required. Please use setup_github_auth first.');
      }
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
    const token = await this.getToken();
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
      throw new Error(data.message || `GitHub API error: ${response.status}`);
    }

    return data;
  }

  /**
   * Check if portfolio repository exists for a user
   * No consent required - this is a read-only operation
   */
  async checkPortfolioExists(username: string): Promise<boolean> {
    try {
      const repo = await this.githubRequest(
        `/repos/${username}/${PortfolioRepoManager.PORTFOLIO_REPO_NAME}`
      );
      return repo !== null;
    } catch (error) {
      // Repository doesn't exist or API error - both return false
      return false;
    }
  }

  /**
   * Create portfolio repository with EXPLICIT user consent
   * @throws Error if user declines consent or if consent is not provided
   */
  async createPortfolio(username: string, consent: boolean | undefined): Promise<string> {
    // CRITICAL: Validate consent is explicitly provided
    if (consent === undefined) {
      throw new Error('Consent is required for portfolio creation');
    }

    if (!consent) {
      console.log(`User declined portfolio creation for ${username}`);
      throw new Error('User declined portfolio creation');
    }

    // Log consent for audit trail
    console.log(`User consented to portfolio creation for ${username}`);

    // Check if portfolio already exists
    const existingRepo = await this.githubRequest(
      `/repos/${username}/${PortfolioRepoManager.PORTFOLIO_REPO_NAME}`
    );
    
    if (existingRepo && existingRepo.html_url) {
      console.log(`Portfolio already exists for ${username}`);
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
      await this.generatePortfolioStructure(username);

      return repo.html_url;
    } catch (error: any) {
      // Preserve original error message for debugging
      throw error;
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
      console.log(`User declined to save element ${element.id} to portfolio`);
      throw new Error('User declined to save element to portfolio');
    }

    // Validate element before saving
    this.validateElement(element);

    const username = element.metadata.author || 'anonymous';
    console.log(`User consented to save element ${element.id} to portfolio`);

    // Generate file path based on element type
    const fileName = this.generateFileName(element.metadata.name);
    const filePath = `${element.type}s/${fileName}.md`;

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
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Generate initial portfolio structure with README and directories
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
   */
  private generateFileName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
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