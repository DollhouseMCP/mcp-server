/**
 * GitHub authentication manager using OAuth device flow
 * Handles authentication for MCP servers without requiring client secrets
 */

import { TokenManager } from '../security/tokenManager.js';
import { logger } from '../utils/logger.js';
import { APICache } from '../cache/APICache.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { ErrorHandler, ErrorCategory } from '../utils/ErrorHandler.js';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface AuthStatus {
  isAuthenticated: boolean;
  hasToken: boolean;
  username?: string;
  scopes?: string[];
  expiresAt?: Date;
}

/**
 * Manages GitHub authentication using the OAuth device flow
 * This is the recommended approach for CLI/desktop applications
 */
export class GitHubAuthManager {
  // GitHub OAuth App Client ID for DollhouseMCP
  // Uses environment variable if available, otherwise falls back to hardcoded value
  // The hardcoded CLIENT_ID is safe for device flow (no client secret required)
  // OAuth app owned by DollhouseMCP organization with Device Flow enabled
  private static readonly HARDCODED_CLIENT_ID = 'Ov23liOrPRXkNN7PMCBt'; // Production CLIENT_ID
  
  /**
   * Get the CLIENT_ID, preferring environment variable over hardcoded value
   */
  private static getClientId(): string {
    return process.env.DOLLHOUSE_GITHUB_CLIENT_ID || GitHubAuthManager.HARDCODED_CLIENT_ID;
  }
  
  // GitHub OAuth endpoints
  private static readonly DEVICE_CODE_URL = 'https://github.com/login/device/code';
  private static readonly TOKEN_URL = 'https://github.com/login/oauth/access_token';
  private static readonly USER_URL = 'https://api.github.com/user';
  
  // Polling configuration
  private static readonly DEFAULT_POLL_INTERVAL = 5000; // 5 seconds
  private static readonly MAX_POLL_ATTEMPTS = 180; // 15 minutes total
  
  private apiCache: APICache;
  private activePolling: AbortController | null = null;
  
  constructor(apiCache: APICache) {
    this.apiCache = apiCache;
  }
  
  /**
   * Execute a network request with retry logic
   */
  private async fetchWithRetry(
    url: string, 
    options: RequestInit, 
    maxRetries: number = 3,
    retryDelay: number = 1000
  ): Promise<Response> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, options);
        return response;
      } catch (error) {
        lastError = error as Error;
        ErrorHandler.logError('GitHubAuthManager.fetchWithRetry', error, { url, attempt });
        
        // Check if it's a network error that should be retried
        const isNetworkError = error instanceof Error && (
          error.message.includes('ECONNREFUSED') ||
          error.message.includes('ETIMEDOUT') ||
          error.message.includes('ENOTFOUND') ||
          error.message.includes('network')
        );
        
        if (isNetworkError && attempt < maxRetries) {
          logger.debug(`Network request failed, retrying (${attempt}/${maxRetries})`, {
            url,
            error: error.message,
            nextRetryIn: retryDelay * attempt
          });
          
          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        } else {
          // Not a network error or last attempt, throw immediately
          throw error;
        }
      }
    }
    
    throw lastError || new Error('Network request failed after all retries');
  }
  
  /**
   * Check current authentication status
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const token = await TokenManager.getGitHubTokenAsync();
    
    if (!token) {
      return {
        isAuthenticated: false,
        hasToken: false
      };
    }
    
    try {
      // Try to get user info to validate token
      const userInfo = await this.fetchUserInfo(token);
      
      return {
        isAuthenticated: true,
        hasToken: true,
        username: userInfo.login,
        scopes: userInfo.scopes
      };
    } catch (error) {
      // Token might be invalid or expired
      ErrorHandler.logError('GitHubAuthManager.checkAuthStatus', error);
      return {
        isAuthenticated: false,
        hasToken: true // Has token but it's invalid
      };
    }
  }
  
  /**
   * Initiate the device flow authentication process
   */
  async initiateDeviceFlow(): Promise<DeviceCodeResponse> {
    const clientId = GitHubAuthManager.getClientId();
    
    if (!clientId) {
      throw new Error(
        'GitHub OAuth is not configured. This should not happen. ' +
        'Please report this issue at: https://github.com/DollhouseMCP/mcp-server/issues'
      );
    }
    
    try {
      const response = await this.fetchWithRetry(GitHubAuthManager.DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: clientId,
          scope: 'public_repo read:user'
        })
      });
      
      if (!response.ok) {
        // Provide user-friendly error messages based on status codes
        const errorMessage = this.getErrorMessageForStatus(response.status, 'device flow initialization');
        logger.debug('Device flow initiation failed', { 
          status: response.status, 
          statusText: response.statusText 
        });
        throw new Error(errorMessage);
      }
      
      const data = await response.json();
      
      // Validate response
      if (!data.device_code || !data.user_code || !data.verification_uri) {
        throw new Error('Invalid device flow response from GitHub');
      }
      
      // Log security event for audit trail
      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_SUCCESS',
        severity: 'LOW',
        source: 'GitHubAuthManager.initiateDeviceFlow',
        details: 'GitHub OAuth device flow initiated successfully',
        metadata: {
          userCode: data.user_code,
          expiresIn: data.expires_in,
          interval: data.interval
        }
      });
      
      return data as DeviceCodeResponse;
    } catch (error) {
      ErrorHandler.logError('GitHubAuthManager.initiateDeviceFlow', error);
      
      // Re-throw if it's already a properly formatted error
      if (error instanceof Error && error.message.includes('GitHub OAuth')) {
        throw error;
      }
      
      throw new Error('Failed to start GitHub authentication. Please check your internet connection.');
    }
  }
  
  /**
   * Poll for token after user has authorized the device
   */
  async pollForToken(deviceCode: string, interval: number = GitHubAuthManager.DEFAULT_POLL_INTERVAL): Promise<TokenResponse> {
    // Create new abort controller for this polling session
    this.activePolling = new AbortController();
    const signal = this.activePolling.signal;
    
    let attempts = 0;
    
    try {
      while (attempts < GitHubAuthManager.MAX_POLL_ATTEMPTS) {
        // Check if polling was aborted
        if (signal.aborted) {
          throw new Error('Authentication polling was cancelled');
        }
        
        attempts++;
        
        try {
        const response = await fetch(GitHubAuthManager.TOKEN_URL, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            client_id: GitHubAuthManager.getClientId(),
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          })
        });
        
        const data = await response.json();
        
        // Check for various response states
        if (data.error) {
          switch (data.error) {
            case 'authorization_pending':
              // User hasn't authorized yet, keep polling
              break;
              
            case 'slow_down':
              // Increase polling interval
              interval = Math.min(interval * 1.5, 30000); // Max 30 seconds
              logger.debug('Slowing down polling interval', { newInterval: interval });
              break;
              
            case 'expired_token':
              throw new Error('The authorization code has expired. Please start over.');
              
            case 'access_denied':
              throw new Error('Authorization was denied. Please try again.');
              
            default:
              // Log the actual error for debugging
              logger.debug('OAuth device flow error', { 
                error: data.error, 
                description: data.error_description 
              });
              throw new Error('Authentication failed. Please try starting the process again.');
          }
        } else if (data.access_token) {
          // Success!
          return data as TokenResponse;
        }
        
        // Wait before next poll
        // Wait for interval with abort support
        await this.waitWithAbort(interval, signal);
        
      } catch (error) {
        // Network errors shouldn't stop polling
        ErrorHandler.logError('GitHubAuthManager.pollForToken', error, { attempt: attempts });
        await this.waitWithAbort(interval, signal);
      }
    }
    
    throw new Error('Authentication timed out. Please try again.');
    } finally {
      // Clear active polling reference
      this.activePolling = null;
    }
  }
  
  /**
   * Complete the authentication flow and store the token
   */
  async completeAuthentication(tokenResponse: TokenResponse): Promise<AuthStatus> {
    // Store token securely
    await this.storeToken(tokenResponse.access_token);
    
    // Get user info
    const userInfo = await this.fetchUserInfo(tokenResponse.access_token);
    
    // Log successful authentication completion
    SecurityMonitor.logSecurityEvent({
      type: 'TOKEN_VALIDATION_SUCCESS',
      severity: 'LOW',
      source: 'GitHubAuthManager.completeAuthentication',
      details: 'GitHub OAuth device flow completed successfully',
      metadata: {
        username: userInfo.login,
        scopes: tokenResponse.scope.split(' '),
        tokenType: TokenManager.getTokenType(tokenResponse.access_token)
      }
    });
    
    return {
      isAuthenticated: true,
      hasToken: true,
      username: userInfo.login,
      scopes: tokenResponse.scope.split(' ')
    };
  }
  
  /**
   * Clear stored authentication and revoke token
   */
  async clearAuthentication(): Promise<void> {
    try {
      // Get the token before clearing it
      const token = await TokenManager.getGitHubTokenAsync();
      
      if (token) {
        // Attempt to revoke the token on GitHub
        // Note: GitHub OAuth tokens don't have a revocation endpoint for device flow tokens
        // But we'll clear the cache and remove from storage
        
        // Clear cached user info
        this.apiCache.clear();
        
        // Log security event for audit trail
        SecurityMonitor.logSecurityEvent({
          type: 'TOKEN_CACHE_CLEARED',
          severity: 'LOW',
          source: 'GitHubAuthManager.clearAuthentication',
          details: 'GitHub authentication cleared by user request',
          metadata: {
            hadToken: true,
            tokenPrefix: TokenManager.getTokenPrefix(token)
          }
        });
      }
      
      // Remove from secure storage
      await TokenManager.removeStoredToken();
      
      logger.info('GitHub authentication cleared successfully');
    } catch (error) {
      ErrorHandler.logError('GitHubAuthManager.clearAuthentication', error);
      throw ErrorHandler.createError('Failed to clear authentication', ErrorCategory.AUTH_ERROR, undefined, error);
    }
  }
  
  /**
   * Store token securely using encrypted file storage
   */
  private async storeToken(token: string): Promise<void> {
    try {
      await TokenManager.storeGitHubToken(token);
      logger.info('GitHub token stored securely. You are now authenticated!');
    } catch (error) {
      ErrorHandler.logError('GitHubAuthManager.storeToken', error);
      // Fallback to environment variable instructions
      logger.info('For manual setup, you can set GITHUB_TOKEN environment variable.');
      throw ErrorHandler.wrapError(error, 'Failed to store GitHub token', ErrorCategory.AUTH_ERROR);
    }
  }
  
  /**
   * Fetch user information from GitHub
   */
  private async fetchUserInfo(token: string): Promise<any> {
    // Check cache first
    const cached = this.apiCache.get(GitHubAuthManager.USER_URL);
    if (cached) {
      return cached;
    }
    
    const response = await this.fetchWithRetry(GitHubAuthManager.USER_URL, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    if (!response.ok) {
      const errorMessage = this.getErrorMessageForStatus(response.status, 'user information fetch');
      logger.debug('Failed to fetch user info', { status: response.status });
      throw new Error(errorMessage);
    }
    
    const data = await response.json();
    
    // Normalize username and other text fields to prevent Unicode attacks
    if (data.login) {
      const validation = UnicodeValidator.normalize(data.login);
      if (!validation.isValid) {
        SecurityMonitor.logSecurityEvent({
          type: 'UNICODE_VALIDATION_ERROR',
          severity: 'MEDIUM',
          source: 'GitHubAuthManager.fetchUserInfo',
          details: 'GitHub username contains invalid Unicode',
          metadata: { 
            originalLength: data.login.length,
            detectedIssues: validation.detectedIssues 
          }
        });
        throw new Error('Invalid username format from GitHub');
      }
      data.login = validation.normalizedContent;
    }
    
    // Normalize display name if present
    if (data.name) {
      const nameValidation = UnicodeValidator.normalize(data.name);
      if (nameValidation.isValid) {
        data.name = nameValidation.normalizedContent;
      } else {
        // Don't fail on display name, just remove it
        delete data.name;
      }
    }
    
    // Add scopes from response headers
    const scopeHeader = response.headers.get('x-oauth-scopes');
    if (scopeHeader) {
      data.scopes = scopeHeader.split(',').map(s => s.trim());
    }
    
    // Log successful authentication for audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'TOKEN_VALIDATION_SUCCESS',
      severity: 'LOW',
      source: 'GitHubAuthManager.fetchUserInfo',
      details: 'GitHub user authenticated successfully',
      metadata: {
        username: data.login,
        hasEmail: !!data.email,
        scopes: data.scopes || []
      }
    });
    
    // Cache the result
    this.apiCache.set(GitHubAuthManager.USER_URL, data);
    
    return data;
  }
  
  /**
   * Format authentication instructions for users
   */
  formatAuthInstructions(deviceResponse: DeviceCodeResponse): string {
    return `🔐 **GitHub Authentication Required**

To access all DollhouseMCP features, please authenticate with GitHub:

1. Visit: **${deviceResponse.verification_uri}**
2. Enter code: **${deviceResponse.user_code}**
3. Authorize 'DollhouseMCP Collection'

This will grant access to:
✅ Browse the public collection
✅ Install community content  
✅ Submit your own creations

Don't have a GitHub account? You'll be prompted to create one (it's free!)

⏱️ This code expires in ${Math.floor(deviceResponse.expires_in / 60)} minutes.`;
  }
  
  /**
   * Check if user needs to authenticate for a specific action
   */
  needsAuthForAction(action: string): boolean {
    const authRequiredActions = ['submit', 'create_pr', 'manage_content'];
    return authRequiredActions.includes(action.toLowerCase());
  }
  
  /**
   * Wait with abort signal support
   */
  private async waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, ms);
      
      // Listen for abort signal
      const abortHandler = () => {
        clearTimeout(timeout);
        reject(new Error('Wait aborted'));
      };
      
      signal.addEventListener('abort', abortHandler, { once: true });
      
      // Clean up after timeout
      setTimeout(() => {
        signal.removeEventListener('abort', abortHandler);
      }, ms);
    });
  }
  
  /**
   * Clean up any active operations (called on server shutdown)
   */
  async cleanup(): Promise<void> {
    // Abort any active polling
    if (this.activePolling) {
      this.activePolling.abort();
      this.activePolling = null;
      
      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_CACHE_CLEARED',
        severity: 'LOW',
        source: 'GitHubAuthManager.cleanup',
        details: 'GitHub auth manager cleaned up on shutdown',
        metadata: {
          hadActivePolling: true
        }
      });
      
      logger.info('GitHub authentication polling cancelled due to shutdown');
    }
    
    // Clear API cache
    this.apiCache.clear();
  }
  
  /**
   * Get user-friendly error message based on HTTP status code
   * Avoids exposing sensitive information while providing helpful guidance
   */
  private getErrorMessageForStatus(status: number, operation: string): string {
    switch (status) {
      case 400:
        return `Invalid request to GitHub. Please ensure the OAuth app is properly configured.`;
      case 401:
        return `GitHub OAuth is not configured. Please report this issue at: https://github.com/DollhouseMCP/mcp-server/issues`;
      case 403:
        return `Access denied by GitHub. The OAuth app may lack required permissions.`;
      case 404:
        return `GitHub service not found. This may indicate an API change.`;
      case 422:
        return `Invalid parameters sent to GitHub. Please check your configuration.`;
      case 429:
        return `Too many requests to GitHub. Please wait a moment and try again.`;
      case 500:
      case 502:
      case 503:
      case 504:
        return `GitHub service temporarily unavailable. Please try again in a few moments.`;
      default:
        // Log the actual status for debugging, but don't expose it to users
        logger.debug(`Unexpected status code during ${operation}`, { status });
        return `Failed to complete ${operation}. Please check your internet connection and try again.`;
    }
  }
}