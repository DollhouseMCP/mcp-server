/**
 * Secure GitHub token management and validation
 */

import { logger } from '../utils/logger.js';

export interface TokenScopes {
  required: string[];
  optional?: string[];
}

export interface TokenValidationResult {
  isValid: boolean;
  scopes?: string[];
  rateLimit?: {
    remaining: number;
    resetTime: Date;
  };
  error?: string;
}

/**
 * Secure GitHub token manager with validation and protection
 */
export class TokenManager {
  private static readonly GITHUB_TOKEN_PATTERNS = {
    PERSONAL_ACCESS_TOKEN: /^ghp_[A-Za-z0-9_]{36,}$/,
    INSTALLATION_TOKEN: /^ghs_[A-Za-z0-9_]{36,}$/,
    USER_ACCESS_TOKEN: /^ghu_[A-Za-z0-9_]{36,}$/,
    REFRESH_TOKEN: /^ghr_[A-Za-z0-9_]{36,}$/
  };

  /**
   * Validate GitHub token format
   */
  static validateTokenFormat(token: string): boolean {
    if (!token || typeof token !== 'string') {
      return false;
    }

    // Check against all known GitHub token patterns
    return Object.values(this.GITHUB_TOKEN_PATTERNS).some(pattern => 
      pattern.test(token)
    );
  }

  /**
   * Get GitHub token from environment with validation
   */
  static getGitHubToken(): string | null {
    const token = process.env.GITHUB_TOKEN;
    
    if (!token) {
      logger.debug('No GitHub token found in environment');
      return null;
    }

    if (!this.validateTokenFormat(token)) {
      logger.warn('Invalid GitHub token format detected', {
        tokenPrefix: this.getTokenPrefix(token),
        length: token.length
      });
      return null;
    }

    logger.debug('Valid GitHub token found', {
      tokenType: this.getTokenType(token),
      tokenPrefix: this.getTokenPrefix(token)
    });

    return token;
  }

  /**
   * Redact token for safe logging
   */
  static redactToken(token: string): string {
    if (!token || token.length < 8) {
      return '[REDACTED]';
    }
    
    return token.substring(0, 4) + '...' + token.substring(token.length - 4);
  }

  /**
   * Get token type from format
   */
  static getTokenType(token: string): string {
    if (this.GITHUB_TOKEN_PATTERNS.PERSONAL_ACCESS_TOKEN.test(token)) {
      return 'Personal Access Token';
    }
    if (this.GITHUB_TOKEN_PATTERNS.INSTALLATION_TOKEN.test(token)) {
      return 'Installation Token';
    }
    if (this.GITHUB_TOKEN_PATTERNS.USER_ACCESS_TOKEN.test(token)) {
      return 'User Access Token';
    }
    if (this.GITHUB_TOKEN_PATTERNS.REFRESH_TOKEN.test(token)) {
      return 'Refresh Token';
    }
    return 'Unknown';
  }

  /**
   * Get safe token prefix for logging
   */
  static getTokenPrefix(token: string): string {
    if (!token || token.length < 4) {
      return '[INVALID]';
    }
    return token.substring(0, 4) + '...';
  }

  /**
   * Validate token scopes via GitHub API
   */
  static async validateTokenScopes(
    token: string, 
    requiredScopes: TokenScopes
  ): Promise<TokenValidationResult> {
    try {
      // Make a test API call to check token validity and scopes
      const response = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'DollhouseMCP/1.0'
        }
      });

      const rateLimitRemaining = parseInt(response.headers.get('x-ratelimit-remaining') || '0');
      const rateLimitReset = parseInt(response.headers.get('x-ratelimit-reset') || '0');

      if (!response.ok) {
        const error = `GitHub API error: ${response.status} ${response.statusText}`;
        logger.warn('Token validation failed', {
          status: response.status,
          tokenPrefix: this.getTokenPrefix(token)
        });
        
        return {
          isValid: false,
          error: error
        };
      }

      // Extract scopes from response headers
      const scopesHeader = response.headers.get('x-oauth-scopes') || '';
      const tokenScopes = scopesHeader.split(',').map(s => s.trim()).filter(s => s);

      // Check if required scopes are present
      const hasRequiredScopes = requiredScopes.required.every(scope => 
        tokenScopes.includes(scope)
      );

      if (!hasRequiredScopes) {
        const missingScopes = requiredScopes.required.filter(scope => 
          !tokenScopes.includes(scope)
        );
        
        logger.warn('Token missing required scopes', {
          tokenPrefix: this.getTokenPrefix(token),
          missingScopes: missingScopes,
          currentScopes: tokenScopes
        });

        return {
          isValid: false,
          scopes: tokenScopes,
          error: `Missing required scopes: ${missingScopes.join(', ')}`
        };
      }

      logger.info('Token validation successful', {
        tokenType: this.getTokenType(token),
        tokenPrefix: this.getTokenPrefix(token),
        scopes: tokenScopes,
        rateLimitRemaining: rateLimitRemaining
      });

      return {
        isValid: true,
        scopes: tokenScopes,
        rateLimit: {
          remaining: rateLimitRemaining,
          resetTime: new Date(rateLimitReset * 1000)
        }
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Token validation error', {
        error: errorMessage,
        tokenPrefix: this.getTokenPrefix(token)
      });

      return {
        isValid: false,
        error: `Validation error: ${errorMessage}`
      };
    }
  }

  /**
   * Create safe error message without token exposure
   */
  static createSafeErrorMessage(error: string, token?: string): string {
    // Remove any potential token data from error messages
    let safeMessage = error
      .replace(/ghp_[A-Za-z0-9_]{36,}/g, '[REDACTED_PAT]')
      .replace(/ghs_[A-Za-z0-9_]{36,}/g, '[REDACTED_INSTALL]')
      .replace(/ghu_[A-Za-z0-9_]{36,}/g, '[REDACTED_USER]')
      .replace(/ghr_[A-Za-z0-9_]{36,}/g, '[REDACTED_REFRESH]');

    if (token) {
      const tokenPrefix = this.getTokenPrefix(token);
      safeMessage += ` (Token: ${tokenPrefix})`;
    }

    return safeMessage;
  }

  /**
   * Get minimum required scopes for different operations
   */
  static getRequiredScopes(operation: 'read' | 'write' | 'marketplace' | 'gist'): TokenScopes {
    switch (operation) {
      case 'read':
        return {
          required: ['repo'],
          optional: ['user:email']
        };
      
      case 'write':
        return {
          required: ['repo'],
          optional: ['user:email']
        };
      
      case 'marketplace':
        return {
          required: ['repo'],
          optional: ['user:email']
        };
      
      case 'gist':
        return {
          required: ['gist'],
          optional: ['user:email']
        };
      
      default:
        return {
          required: ['repo']
        };
    }
  }

  /**
   * Check if token has sufficient permissions for operation
   */
  static async ensureTokenPermissions(
    operation: 'read' | 'write' | 'marketplace' | 'gist'
  ): Promise<TokenValidationResult> {
    const token = this.getGitHubToken();
    
    if (!token) {
      return {
        isValid: false,
        error: 'No GitHub token available'
      };
    }

    const requiredScopes = this.getRequiredScopes(operation);
    return this.validateTokenScopes(token, requiredScopes);
  }
}