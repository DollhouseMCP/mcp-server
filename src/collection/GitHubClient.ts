/**
 * GitHub API client for collection integration
 */

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { APICache } from '../cache/APICache.js';
import { SECURITY_LIMITS } from '../security/constants.js';
import { TokenManager } from '../security/tokenManager.js';

export class GitHubClient {
  private apiCache: APICache;
  private rateLimitTracker: Map<string, number[]>;
  private tokenManager: TokenManager;

  constructor(apiCache: APICache, rateLimitTracker: Map<string, number[]>, tokenManager: TokenManager) {
    this.apiCache = apiCache;
    this.rateLimitTracker = rateLimitTracker;
    this.tokenManager = tokenManager;
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
  async fetchFromGitHub(url: string, requireAuth: boolean = false): Promise<any> {
    let timeoutId: NodeJS.Timeout | null = null;
    const controller = new AbortController();

    // Validate URL is a GitHub API or content endpoint to prevent SSRF
    const parsedUrl = new URL(url);
    if (!['api.github.com', 'raw.githubusercontent.com'].includes(parsedUrl.hostname)) {
      throw new Error(`GitHubClient: Refusing to fetch non-GitHub URL: ${parsedUrl.hostname}`);
    }

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
      
      // Use TokenManager for secure token handling
      // CRITICAL FIX #471: Must use async method to retrieve OAuth tokens from secure storage
      // The OAuth flow (setup_github_auth) stores tokens in secure OS keychain/credential store
      // which requires async access. The sync method only checks environment variables,
      // missing tokens stored by the OAuth authentication flow.
      const token = await this.tokenManager.getGitHubTokenAsync();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      } else if (requireAuth) {
        throw new Error('GitHub authentication required but no valid token available. Please use setup_github_auth or set GITHUB_TOKEN environment variable.');
      }
      
      // Create fetch with timeout
      timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch(url, {
        headers,
        signal: controller.signal
      });
      
      if (!response.ok) {
        if (response.status === 403) {
          const errorMsg = token 
            ? 'GitHub API rate limit exceeded or token lacks required permissions.'
            : 'GitHub API rate limit exceeded. Consider using setup_github_auth or setting GITHUB_TOKEN environment variable.';
          throw new Error(errorMsg);
        }
        if (response.status === 401) {
          throw new Error('GitHub API authentication failed. Please check your GITHUB_TOKEN.');
        }
        // Provide helpful error messages based on status code
        if (response.status === 404) {
          throw new Error(`File not found in collection. Try using search to get the correct path: search_collection_enhanced "your-search-term"`);
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Cache the successful response
      this.apiCache.set(url, data);
      
      return data;
    } catch (error) {
      // Use TokenManager for safe error handling
      const errorMessage = error instanceof Error ? error.message : String(error);
      const safeMessage = this.tokenManager.createSafeErrorMessage(errorMessage);
      
      // codeql[js/clear-text-logging] — URL is a GitHub API endpoint (api.github.com/raw.githubusercontent.com),
      // validated at method entry. Auth tokens are in headers, not the URL.
      const errorDetails: any = {
        originalMessage: safeMessage,
        url
      };
      
      // Preserve stack trace and error type information
      if (error instanceof Error) {
        errorDetails.errorType = error.constructor.name;
        errorDetails.stack = error.stack;
        
        // Special handling for common error types
        if (error.name === 'AbortError') {
          errorDetails.timeout = true;
        }
      }
      
      const mcpError = new McpError(
        ErrorCode.InternalError,
        `Failed to fetch from GitHub: ${safeMessage}`,
        errorDetails
      );
      
      // Also preserve original error for debugging
      (mcpError as any).cause = error;
      
      throw mcpError;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    }
  }

  /**
   * Validate token permissions for collection operations
   */
  async validateCollectionPermissions(): Promise<void> {
    // NOTE: Using 'marketplace' scope for backward compatibility with TokenManager.
    // This is an internal implementation detail that doesn't affect functionality. (PR #280)
    const validation = await this.tokenManager.ensureTokenPermissions('marketplace');
    if (!validation.isValid) {
      const safeMessage = this.tokenManager.createSafeErrorMessage(validation.error || 'Unknown validation error');
      throw new Error(`GitHub token validation failed: ${safeMessage}`);
    }
  }
}
