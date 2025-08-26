/**
 * Real GitHub API Client for Integration Testing
 * NO MOCKS - This performs actual GitHub API operations
 * 
 * SECURITY NOTE: This is a test utility for E2E testing against controlled test repositories.
 * Unicode normalization (DMCP-SEC-004) is not required as this only interacts with
 * test data in controlled environments. The GitHub API handles its own input validation.
 */

import { TestEnvironment } from '../e2e/setup-test-env.js';

export interface GitHubFile {
  path: string;
  content: string;
  sha?: string;
  html_url?: string;
}

export interface GitHubCommit {
  sha: string;
  html_url: string;
  message: string;
}

export interface UploadResult {
  success: boolean;
  url?: string;
  commit?: GitHubCommit;
  error?: string;
  errorCode?: string;
}

/**
 * Real GitHub API client for testing
 */
export class GitHubTestClient {
  private baseUrl = 'https://api.github.com';
  private headers: Record<string, string>;
  
  constructor(private config: TestEnvironment) {
    this.headers = {
      'Authorization': `Bearer ${config.githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'DollhouseMCP-QA-Test/1.0'
    };
  }

  /**
   * Upload a file to GitHub (real API call)
   */
  async uploadFile(
    filePath: string,
    content: string,
    message: string = 'QA test upload'
  ): Promise<UploadResult> {
    const [owner, repo] = this.config.testRepo.split('/');
    const url = `${this.baseUrl}/repos/${owner}/${repo}/contents/${filePath}`;
    
    try {
      // Check if file exists first
      const existingFile = await this.getFile(filePath);
      
      const body: any = {
        message,
        content: Buffer.from(content).toString('base64'),
        branch: this.config.testBranch
      };
      
      // If file exists, include SHA for update
      if (existingFile) {
        body.sha = existingFile.sha;
      }

      const response = await this.fetchWithRetry(url, {
        method: 'PUT',
        headers: {
          ...this.headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: 'Unknown error' }));
        return {
          success: false,
          error: error.message,
          errorCode: this.mapErrorCode(response.status, error)
        };
      }

      const data = await response.json();
      
      // Extract URL with multiple fallbacks (matching the fix from session notes)
      let resultUrl = data.commit?.html_url;
      if (!resultUrl && data.content?.html_url) {
        resultUrl = data.content.html_url;
      }
      if (!resultUrl) {
        // Generate fallback URL
        resultUrl = `https://github.com/${owner}/${repo}/blob/${this.config.testBranch}/${filePath}`;
      }

      return {
        success: true,
        url: resultUrl,
        commit: data.commit ? {
          sha: data.commit.sha,
          html_url: data.commit.html_url || resultUrl,
          message: data.commit.message || message
        } : undefined
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        errorCode: 'PORTFOLIO_SYNC_005'
      };
    }
  }

  /**
   * Get a file from GitHub (real API call)
   */
  async getFile(filePath: string): Promise<GitHubFile | null> {
    const [owner, repo] = this.config.testRepo.split('/');
    const url = `${this.baseUrl}/repos/${owner}/${repo}/contents/${filePath}`;
    
    try {
      const response = await this.fetchWithRetry(url, {
        headers: this.headers
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`Failed to get file: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      // Decode content from base64
      const content = data.content ? 
        Buffer.from(data.content, 'base64').toString('utf-8') : '';

      return {
        path: data.path,
        content,
        sha: data.sha,
        html_url: data.html_url
      };
    } catch (error) {
      if (this.config.verboseLogging) {
        console.error('Error getting file:', error);
      }
      return null;
    }
  }

  /**
   * Delete a file from GitHub (for cleanup)
   */
  async deleteFile(filePath: string, message: string = 'QA test cleanup'): Promise<boolean> {
    const [owner, repo] = this.config.testRepo.split('/');
    const url = `${this.baseUrl}/repos/${owner}/${repo}/contents/${filePath}`;
    
    try {
      // Get file SHA first
      const file = await this.getFile(filePath);
      if (!file || !file.sha) {
        return false; // File doesn't exist
      }

      const response = await this.fetchWithRetry(url, {
        method: 'DELETE',
        headers: {
          ...this.headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message,
          sha: file.sha,
          branch: this.config.testBranch
        })
      });

      return response.ok;
    } catch (error) {
      if (this.config.verboseLogging) {
        console.error('Error deleting file:', error);
      }
      return false;
    }
  }

  /**
   * List files in a directory
   */
  async listFiles(directory: string = ''): Promise<string[]> {
    const [owner, repo] = this.config.testRepo.split('/');
    const url = `${this.baseUrl}/repos/${owner}/${repo}/contents/${directory}`;
    
    try {
      const response = await this.fetchWithRetry(url, {
        headers: this.headers
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      
      if (!Array.isArray(data)) {
        return [];
      }

      return data
        .filter((item: any) => item.type === 'file')
        .map((item: any) => item.path);
    } catch (error) {
      if (this.config.verboseLogging) {
        console.error('Error listing files:', error);
      }
      return [];
    }
  }

  /**
   * Verify a URL is accessible (not 404)
   */
  async verifyUrl(url: string): Promise<boolean> {
    try {
      // Properly parse and validate the URL
      const parsedUrl = new URL(url);
      
      // For GitHub URLs, we can check via API
      if (parsedUrl.hostname === 'github.com' || parsedUrl.hostname === 'www.github.com') {
        // Extract path from URL
        const match = url.match(/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)/);
        if (match) {
          const file = await this.getFile(match[1]);
          return file !== null;
        }
      }

      // For other URLs, do a HEAD request
      const response = await fetch(url, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get rate limit status
   */
  async getRateLimit(): Promise<{ remaining: number; reset: Date }> {
    const response = await fetch(`${this.baseUrl}/rate_limit`, {
      headers: this.headers
    });

    const data = await response.json();
    return {
      remaining: data.rate.remaining,
      reset: new Date(data.rate.reset * 1000)
    };
  }

  /**
   * Fetch with retry logic
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit = {}
  ): Promise<Response> {
    let lastError: Error | null = null;
    
    for (let i = 0; i < this.config.retryAttempts; i++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        
        const response = await fetch(url, {
          ...options,
          signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        // Don't retry on client errors (4xx)
        if (response.status >= 400 && response.status < 500) {
          return response;
        }
        
        // Retry on server errors (5xx) or network issues
        if (response.ok || i === this.config.retryAttempts - 1) {
          return response;
        }
        
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
      } catch (error) {
        lastError = error as Error;
        
        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new Error(`Request timeout after ${this.config.timeoutMs}ms`);
        }
      }
      
      // Wait before retry with exponential backoff
      if (i < this.config.retryAttempts - 1) {
        const delay = this.config.rateLimitDelayMs * Math.pow(2, i);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError || new Error('Request failed after retries');
  }

  /**
   * Map HTTP status codes to error codes
   */
  private mapErrorCode(status: number, error: any): string {
    if (status === 401) return 'PORTFOLIO_SYNC_001';
    if (status === 404) return 'PORTFOLIO_SYNC_002';
    if (status === 403) {
      if (error.message?.includes('rate limit')) {
        return 'PORTFOLIO_SYNC_006';
      }
      return 'PORTFOLIO_SYNC_003';
    }
    if (status === 422) return 'PORTFOLIO_SYNC_003';
    if (status >= 500) return 'PORTFOLIO_SYNC_005';
    return 'PORTFOLIO_SYNC_004';
  }
}