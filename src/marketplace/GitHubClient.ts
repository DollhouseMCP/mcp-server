/**
 * GitHub API client for marketplace integration
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode } from '../types/mcp.js';
import { APICache } from '../cache/APICache.js';
import { SECURITY_LIMITS } from '../security/constants.js';

export class GitHubClient {
  private apiCache: APICache;
  private rateLimitTracker: Map<string, number[]>;
  
  constructor(apiCache: APICache, rateLimitTracker: Map<string, number[]>) {
    this.apiCache = apiCache;
    this.rateLimitTracker = rateLimitTracker;
  }
  
  /**
   * Check rate limit for API calls
   */
  private checkRateLimit(key: string = 'default'): void {
    const now = Date.now();
    const requests = this.rateLimitTracker.get(key) || [];
    
    // Remove requests outside the window
    const validRequests = requests.filter(time => now - time < SECURITY_LIMITS.RATE_LIMIT_WINDOW_MS);
    
    if (validRequests.length >= SECURITY_LIMITS.RATE_LIMIT_REQUESTS) {
      throw new Error(`Rate limit exceeded. Max ${SECURITY_LIMITS.RATE_LIMIT_REQUESTS} requests per minute.`);
    }
    
    validRequests.push(now);
    this.rateLimitTracker.set(key, validRequests);
  }
  
  /**
   * Fetch data from GitHub API with caching and rate limiting
   */
  async fetchFromGitHub(url: string): Promise<any> {
    try {
      // Check rate limit
      this.checkRateLimit('github_api');
      
      // Check cache first
      const cached = this.apiCache.get(url);
      if (cached) {
        return cached;
      }
      
      // Add GitHub token if available for higher rate limits
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'DollhouseMCP/1.0'
      };
      
      if (process.env.GITHUB_TOKEN) {
        headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
      }
      
      // Create fetch with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch(url, {
        headers,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        if (response.status === 403) {
          throw new Error('GitHub API rate limit exceeded. Consider setting GITHUB_TOKEN environment variable.');
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Cache the successful response
      this.apiCache.set(url, data);
      
      return data;
    } catch (error) {
      // Preserve original error information
      const errorMessage = error instanceof Error ? error.message : String(error);
      const mcpError = new McpError(
        ErrorCode.InternalError,
        `Failed to fetch from GitHub: ${errorMessage}`
      );
      
      // Attach original error as cause if supported
      if (error instanceof Error && 'cause' in mcpError) {
        (mcpError as any).cause = error;
      }
      
      throw mcpError;
    }
  }
}