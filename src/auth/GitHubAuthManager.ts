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
import { ConfigManager } from '../config/ConfigManager.js';

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
  /**
   * DollhouseMCP's official OAuth App Client ID
   * This is PUBLIC information - OAuth Client IDs are meant to be visible.
   * Only Client Secrets are private (device flow doesn't use secrets).
   * 
   * This Client ID enables the GitHub device flow authentication
   * allowing users to authenticate with an 8-character code.
   */
  private static readonly DEFAULT_CLIENT_ID = 'Ov23li9gyNZP6m9aJ2EP';
  
  /**
   * Get the CLIENT_ID from environment variable, ConfigManager, or default
   * Priority: Environment variable > ConfigManager > Default Client ID
   * 
   * @returns The OAuth Client ID to use for authentication
   */
  public static async getClientId(): Promise<string | null> {
    // Check environment variable first (for backward compatibility)
    const envClientId = process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
    if (envClientId) {
      logger.debug('Using OAuth Client ID from environment variable');
      return envClientId;
    }

    // Check ConfigManager for stored configuration
    try {
      const configManager = ConfigManager.getInstance();
      await configManager.initialize();
      const configClientId = configManager.getGitHubClientId();
      if (configClientId) {
        logger.debug('Using OAuth Client ID from config');
        return configClientId;
      }
    } catch (error) {
      logger.debug('No OAuth Client ID in config', { error });
    }
    
    // Use default DollhouseMCP OAuth App Client ID
    // This enables "just works" experience for NPM installs
    logger.debug('Using default DollhouseMCP OAuth Client ID');
    return GitHubAuthManager.DEFAULT_CLIENT_ID;
  }
  
  // GitHub OAuth endpoints
  private static readonly DEVICE_CODE_URL = 'https://github.com/login/device/code';
  private static readonly TOKEN_URL = 'https://github.com/login/oauth/access_token';
  private static readonly USER_URL = 'https://api.github.com/user';
  
  // Polling configuration
  private static readonly DEFAULT_POLL_INTERVAL = 5000; // 5 seconds
  private static readonly MAX_POLL_ATTEMPTS = 180; // 15 minutes total

  /**
   * OAuth error codes that require immediate propagation per RFC 6749/8628.
   * These are terminal errors that cannot be recovered by retrying.
   */
  private static readonly TERMINAL_OAUTH_ERROR_CODES = [
    'expired_token',      // Authorization code has expired
    'access_denied',      // User explicitly denied authorization
    'unsupported_grant_type',  // Invalid grant type (configuration error)
    'invalid_grant'       // Invalid or expired device code
  ] as const;

  /**
   * Error message patterns that indicate terminal OAuth errors.
   * Used for message-based error detection when error codes aren't available.
   */
  private static readonly TERMINAL_ERROR_PATTERNS = [
    'authorization code has expired',
    'Authorization was denied',
    'Authentication failed',
    'expired_token',
    'access_denied'
  ] as const;

  private apiCache: APICache;
  private activePolling: AbortController | null = null;
  
  constructor(apiCache: APICache) {
    this.apiCache = apiCache;
  }

  /**
   * Determines if an OAuth error is terminal and should propagate immediately.
   *
   * Per RFC 6749 (OAuth 2.0) and RFC 8628 (Device Authorization Grant):
   * - Terminal errors (expired_token, access_denied) MUST stop polling immediately
   * - Transient errors (network failures, slow_down) should be retried
   *
   * Error Detection Priority (most to least reliable):
   * 1. Explicit error code parameter (from GitHub API response)
   * 2. Error code embedded in Error object properties
   * 3. Message pattern matching (fallback for compatibility)
   *
   * @param error - The error to check
   * @param errorCode - Optional OAuth error code from API response
   * @returns true if error is terminal and should propagate, false if retriable
   *
   * @see https://datatracker.ietf.org/doc/html/rfc8628#section-3.5
   * @see https://docs.github.com/en/developers/apps/authorizing-oauth-apps
   */
  private static isTerminalOAuthError(error: Error, errorCode?: string): boolean {
    // PRIORITY 1: Check explicit error code parameter (most reliable)
    // This comes directly from GitHub's API response: { error: "expired_token" }
    if (errorCode && GitHubAuthManager.TERMINAL_OAUTH_ERROR_CODES.includes(errorCode as any)) {
      return true;
    }

    // PRIORITY 2: Check if error has embedded error code in properties
    // GitHub often includes error code in Error object properties
    const errorObj = error as any;
    if (errorObj.code && GitHubAuthManager.TERMINAL_OAUTH_ERROR_CODES.includes(errorObj.code)) {
      return true;
    }

    // PRIORITY 3: Fall back to message pattern matching (least reliable)
    // Only used for backward compatibility and unknown error formats
    // Message text can change, so this is brittle but necessary for robustness
    const errorMessage = error.message.toLowerCase();
    return GitHubAuthManager.TERMINAL_ERROR_PATTERNS.some(pattern =>
      errorMessage.includes(pattern.toLowerCase())
    );
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
    const clientId = await GitHubAuthManager.getClientId();
    // getClientId() always returns a value (env, config, or default)
    
    // Log the OAuth flow step for debugging
    logger.debug('OAUTH_STEP_1: Getting client ID', { clientId: clientId?.substring(0, 8) + '...' });
    
    if (!clientId) {
      throw new Error('OAUTH_NO_CLIENT_ID: No OAuth client ID configured. Set DOLLHOUSE_GITHUB_CLIENT_ID environment variable.');
    }
    
    logger.debug('OAUTH_STEP_2: Initiating device flow', { url: GitHubAuthManager.DEVICE_CODE_URL });
    
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
      
      logger.debug('OAUTH_STEP_3: GitHub response', { 
        status: response.status, 
        statusText: response.statusText,
        headers: {
          'x-github-request-id': response.headers.get('x-github-request-id'),
          'x-ratelimit-remaining': response.headers.get('x-ratelimit-remaining')
        }
      });
      
      if (!response.ok) {
        const responseText = await response.text();
        logger.error('GitHub OAuth endpoint error', { 
          status: response.status,
          statusText: response.statusText,
          responseBody: responseText,
          clientId: clientId?.substring(0, 8) + '...'
        });
        
        // Parse GitHub's error response for specific error codes
        try {
          const errorData = JSON.parse(responseText);
          
          if (errorData.error === 'unauthorized_client') {
            throw new Error(`OAUTH_CLIENT_UNAUTHORIZED: OAuth app '${clientId?.substring(0, 8)}...' is not authorized for device flow. The app may need reconfiguration.`);
          }
          
          if (errorData.error === 'invalid_client') {
            throw new Error(`OAUTH_CLIENT_INVALID: GitHub rejected OAuth client ID '${clientId?.substring(0, 8)}...'. The app may not exist or be disabled.`);
          }
          
          if (errorData.error_description) {
            throw new Error(`OAUTH_API_ERROR: ${errorData.error_description}`);
          }
        } catch (parseError) {
          // If we can't parse the error, provide HTTP status specific error
          if (response.status === 401) {
            throw new Error(`OAUTH_CLIENT_INVALID: GitHub rejected OAuth client ID '${clientId?.substring(0, 8)}...'. The app may not exist or be disabled.`);
          }
          
          if (response.status === 403) {
            throw new Error(`OAUTH_DEVICE_FLOW_DISABLED: This OAuth app doesn't have device flow enabled. Contact administrator.`);
          }
          
          if (response.status === 429) {
            throw new Error(`OAUTH_RATE_LIMITED: Too many authentication attempts. Please wait before trying again.`);
          }
          
          throw new Error(`OAUTH_HTTP_${response.status}: GitHub OAuth failed - ${response.statusText}`);
        }
      }
      
      const data = await response.json();
      
      // Validate response
      if (!data.device_code || !data.user_code || !data.verification_uri) {
        logger.error('Invalid device flow response structure', { 
          hasDeviceCode: !!data.device_code,
          hasUserCode: !!data.user_code,
          hasVerificationUri: !!data.verification_uri
        });
        throw new Error('OAUTH_INVALID_RESPONSE: Invalid device flow response from GitHub - missing required fields');
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
      
      // Check if it's a network error
      if (error instanceof Error) {
        // Re-throw if it's already a properly formatted error with code
        if (error.message.startsWith('OAUTH_')) {
          throw error;
        }
        
        // Format network errors
        if (error.message.includes('ECONNREFUSED') || 
            error.message.includes('ETIMEDOUT') || 
            error.message.includes('ENOTFOUND')) {
          throw new Error(`OAUTH_NETWORK_ERROR: Unable to reach GitHub servers (https://github.com/login/device/code). Check your internet connection.`);
        }
        
        if (error.message.includes('network')) {
          throw new Error(`OAUTH_NETWORK_ERROR: Network error while connecting to GitHub. Please check your internet connection.`);
        }
      }
      
      // Generic fallback (should rarely happen)
      throw new Error(`OAUTH_UNKNOWN_ERROR: Failed to start GitHub authentication - ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  /**
   * Poll GitHub for OAuth token using device flow.
   *
   * Implements OAuth 2.0 Device Authorization Grant (RFC 8628) with proper error handling.
   *
   * ## OAuth 2.0 Compliance (RFC 6749/8628)
   *
   * ### Terminal Errors (MUST propagate immediately):
   * - `expired_token` - Authorization code has expired, user must restart flow
   * - `access_denied` - User explicitly denied authorization
   * - `unsupported_grant_type` - Invalid grant type (configuration error)
   * - `invalid_grant` - Invalid or expired device code
   *
   * ### Transient Errors (should be retried):
   * - `authorization_pending` - User hasn't completed authorization yet
   * - `slow_down` - Polling too frequently, increase interval
   * - Network errors (ECONNREFUSED, ETIMEDOUT, etc.)
   *
   * ### Error Handling Flow:
   * 1. GitHub returns error code in response (e.g., `{error: "expired_token"}`)
   * 2. Check if error is terminal using `isTerminalOAuthError()`
   * 3. Terminal errors throw immediately, stopping polling
   * 4. Transient errors are logged and polling continues
   * 5. After MAX_POLL_ATTEMPTS (15 minutes), timeout error is thrown
   *
   * @param deviceCode - Device code from GitHub authorization flow
   * @param interval - Polling interval in milliseconds (default: 5000ms)
   * @returns Promise resolving to TokenResponse with access token
   * @throws {Error} Terminal OAuth errors (expired_token, access_denied, etc.)
   * @throws {Error} Timeout after MAX_POLL_ATTEMPTS (180 attempts = 15 minutes)
   * @throws {Error} Network errors that persist beyond retry logic
   *
   * @see https://datatracker.ietf.org/doc/html/rfc8628 - OAuth 2.0 Device Authorization Grant
   * @see https://datatracker.ietf.org/doc/html/rfc6749 - OAuth 2.0 Authorization Framework
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
            client_id: await GitHubAuthManager.getClientId() || '',
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          })
        });
        
        const data = await response.json();

        // RFC 8628 Section 3.5: Handle OAuth device flow responses
        if (data.error) {
          const errorCode = data.error;  // Extract error code for robust detection

          switch (errorCode) {
            case 'authorization_pending':
              // Transient: User hasn't authorized yet, continue polling
              logger.debug('Authorization pending, continuing to poll', { attempt: attempts });
              break;

            case 'slow_down':
              // Transient: Server requests slower polling, adjust interval
              interval = Math.min(interval * 1.5, 30000); // Max 30 seconds
              logger.debug('Slowing down polling interval per server request', {
                newInterval: interval,
                attempt: attempts
              });
              break;

            case 'expired_token':
              // TERMINAL: Authorization code expired (RFC 8628 Section 3.5)
              throw new Error('The authorization code has expired. Please start over.');

            case 'access_denied':
              // TERMINAL: User explicitly denied authorization (RFC 8628 Section 3.5)
              throw new Error('Authorization was denied. Please try again.');

            case 'unsupported_grant_type':
            case 'invalid_grant':
              // TERMINAL: Configuration or code issue (RFC 6749 Section 5.2)
              logger.error('OAuth grant error', {
                error: errorCode,
                description: data.error_description
              });
              throw new Error('Authentication failed. Please try starting the process again.');

            default:
              // Unknown error - treat as terminal to avoid infinite polling
              logger.debug('Unknown OAuth error, treating as terminal', {
                error: errorCode,
                description: data.error_description
              });
              // Embed error code in Error object for isTerminalOAuthError detection
              const unknownError = new Error('Authentication failed. Please try starting the process again.');
              (unknownError as any).code = errorCode;
              throw unknownError;
          }
        } else if (data.access_token) {
          // Success! User authorized and token is ready
          logger.info('OAuth device flow completed successfully', { attempts });
          return data as TokenResponse;
        }

        // No error and no token - wait and continue polling
        await this.waitWithAbort(interval, signal);

      } catch (error) {
        // RFC 6749/8628 Compliance: Terminal errors MUST propagate immediately
        // Use helper function for robust terminal error detection
        // Pass error code if available for priority detection
        const errorCode = (error as any)?.code;
        if (error instanceof Error && GitHubAuthManager.isTerminalOAuthError(error, errorCode)) {
          logger.debug('Terminal OAuth error detected, stopping polling', {
            error: error.message,
            errorCode: errorCode,
            attempt: attempts
          });
          throw error;  // Terminal error - propagate immediately, stop polling
        }

        // Transient errors (network failures, etc.) - log and retry
        // These shouldn't stop polling as they may be temporary issues
        ErrorHandler.logError('GitHubAuthManager.pollForToken', error, {
          attempt: attempts,
          willRetry: true
        });
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