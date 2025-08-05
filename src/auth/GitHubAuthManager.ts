/**
 * GitHub authentication manager using OAuth device flow
 * Handles authentication for MCP servers without requiring client secrets
 */

import { TokenManager } from '../security/tokenManager.js';
import { logger } from '../utils/logger.js';
import { APICache } from '../cache/APICache.js';

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
  // This is public and safe to embed in the code
  private static readonly CLIENT_ID = process.env.DOLLHOUSE_GITHUB_CLIENT_ID || 'Ov23li8KZDXQyFnXOVjn';
  
  // GitHub OAuth endpoints
  private static readonly DEVICE_CODE_URL = 'https://github.com/login/device/code';
  private static readonly TOKEN_URL = 'https://github.com/login/oauth/access_token';
  private static readonly USER_URL = 'https://api.github.com/user';
  
  // Polling configuration
  private static readonly DEFAULT_POLL_INTERVAL = 5000; // 5 seconds
  private static readonly MAX_POLL_ATTEMPTS = 180; // 15 minutes total
  
  private apiCache: APICache;
  
  constructor(apiCache: APICache) {
    this.apiCache = apiCache;
  }
  
  /**
   * Check current authentication status
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const token = TokenManager.getGitHubToken();
    
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
      logger.debug('Token validation failed', { error });
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
    try {
      const response = await fetch(GitHubAuthManager.DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: GitHubAuthManager.CLIENT_ID,
          scope: 'public_repo read:user'
        })
      });
      
      if (!response.ok) {
        throw new Error(`Failed to initiate device flow: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Validate response
      if (!data.device_code || !data.user_code || !data.verification_uri) {
        throw new Error('Invalid device flow response from GitHub');
      }
      
      return data as DeviceCodeResponse;
    } catch (error) {
      logger.error('Failed to initiate device flow', { error });
      throw new Error('Failed to start GitHub authentication. Please check your internet connection.');
    }
  }
  
  /**
   * Poll for token after user has authorized the device
   */
  async pollForToken(deviceCode: string, interval: number = GitHubAuthManager.DEFAULT_POLL_INTERVAL): Promise<TokenResponse> {
    let attempts = 0;
    
    while (attempts < GitHubAuthManager.MAX_POLL_ATTEMPTS) {
      attempts++;
      
      try {
        const response = await fetch(GitHubAuthManager.TOKEN_URL, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            client_id: GitHubAuthManager.CLIENT_ID,
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
              throw new Error(`Authentication failed: ${data.error_description || data.error}`);
          }
        } else if (data.access_token) {
          // Success!
          return data as TokenResponse;
        }
        
        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, interval));
        
      } catch (error) {
        // Network errors shouldn't stop polling
        logger.debug('Poll attempt failed', { attempt: attempts, error });
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
    
    throw new Error('Authentication timed out. Please try again.');
  }
  
  /**
   * Complete the authentication flow and store the token
   */
  async completeAuthentication(tokenResponse: TokenResponse): Promise<AuthStatus> {
    // Store token securely
    await this.storeToken(tokenResponse.access_token);
    
    // Get user info
    const userInfo = await this.fetchUserInfo(tokenResponse.access_token);
    
    return {
      isAuthenticated: true,
      hasToken: true,
      username: userInfo.login,
      scopes: tokenResponse.scope.split(' ')
    };
  }
  
  /**
   * Clear stored authentication
   */
  async clearAuthentication(): Promise<void> {
    // For now, we rely on environment variables
    // In the future, this could clear from secure storage
    logger.info('Authentication cleared. Remove GITHUB_TOKEN from environment to complete.');
  }
  
  /**
   * Store token securely
   * For now, this logs instructions for manual setup
   * Future: Use system keychain or encrypted storage
   */
  private async storeToken(token: string): Promise<void> {
    // TODO: Implement secure storage (keychain, encrypted file, etc.)
    // For now, provide manual instructions
    logger.info('Token obtained successfully. For persistent auth, set GITHUB_TOKEN environment variable.');
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
    
    const response = await fetch(GitHubAuthManager.USER_URL, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch user info: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Add scopes from response headers
    const scopeHeader = response.headers.get('x-oauth-scopes');
    if (scopeHeader) {
      data.scopes = scopeHeader.split(',').map(s => s.trim());
    }
    
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
}