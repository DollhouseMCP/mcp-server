/**
 * Secure Token Manager for DollhouseMCP
 * 
 * Provides secure GitHub token management with validation,
 * caching, and error sanitization.
 * 
 * Security: SEC-004 - Token exposure vulnerability protection
 */

import { SecurityError } from '../errors/SecurityError.js';
import { SecurityMonitor } from './securityMonitor.js';

export enum TokenScope {
  READ = 'read',
  WRITE = 'write',
  ADMIN = 'admin'
}

interface TokenMetadata {
  token: string;
  scope: TokenScope;
  createdAt: number;
  lastUsed: number;
}

export class SecureTokenManager {
  private static tokenCache: Map<string, TokenMetadata> = new Map();
  private static readonly TOKEN_ROTATION_INTERVAL = 3600000; // 1 hour
  
  // Token patterns to sanitize from errors
  private static readonly TOKEN_PATTERNS = [
    /ghp_[a-zA-Z0-9]{36}/g,
    /gho_[a-zA-Z0-9]{36}/g,
    /github_pat_[a-zA-Z0-9_]{82}/g,
    /Bearer\s+[a-zA-Z0-9_-]+/g,
  ];

  // Valid token formats
  private static readonly VALID_TOKEN_FORMATS = [
    /^ghp_[a-zA-Z0-9]{36}$/,      // Personal access token (classic)
    /^gho_[a-zA-Z0-9]{36}$/,      // OAuth access token
    /^github_pat_[a-zA-Z0-9_]{82}$/ // Fine-grained personal access token
  ];

  /**
   * Get a secure GitHub token for the specified scope
   * @param scope The required permission scope
   * @returns The validated token
   * @throws SecurityError if token is invalid or missing
   */
  static async getSecureGitHubToken(scope: TokenScope): Promise<string> {
    try {
      // Check cache first
      const cached = this.tokenCache.get('github');
      if (cached && this.isTokenFresh(cached)) {
        await this.validateTokenPermissions(cached.token, scope);
        cached.lastUsed = Date.now();
        return cached.token;
      }

      // Get token from environment
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new SecurityError(
          'GitHub token not found in environment variables',
          'TOKEN_NOT_FOUND',
          'high',
          { scope }
        );
      }

      // Validate format
      this.validateTokenFormat(token);

      // Validate permissions
      await this.validateTokenPermissions(token, scope);

      // Cache the token
      const metadata: TokenMetadata = {
        token,
        scope,
        createdAt: Date.now(),
        lastUsed: Date.now()
      };
      this.tokenCache.set('github', metadata);

      // Log security event
      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_SUCCESS',
        severity: 'LOW',
        source: 'SecureTokenManager',
        details: 'GitHub token validated successfully',
        additionalData: { scope }
      });

      return token;
    } catch (error) {
      // Sanitize error before re-throwing
      const sanitizedError = this.sanitizeError(error);
      
      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_FAILURE',
        severity: 'HIGH',
        source: 'SecureTokenManager',
        details: 'Token validation failed',
        additionalData: { 
          scope,
          error: sanitizedError.message 
        }
      });

      throw sanitizedError;
    }
  }

  /**
   * Validate token format
   * @param token The token to validate
   * @throws SecurityError if format is invalid
   */
  private static validateTokenFormat(token: string): void {
    const isValid = this.VALID_TOKEN_FORMATS.some(pattern => pattern.test(token));
    
    if (!isValid) {
      throw new SecurityError(
        'Invalid GitHub token format',
        'INVALID_TOKEN_FORMAT',
        'high'
      );
    }

    // Additional security checks
    if (token.length < 40) {
      throw new SecurityError(
        'GitHub token too short',
        'TOKEN_TOO_SHORT',
        'high'
      );
    }

    if (token.includes(' ') || token.includes('\n') || token.includes('\t')) {
      throw new SecurityError(
        'GitHub token contains invalid characters',
        'TOKEN_INVALID_CHARS',
        'high'
      );
    }
  }

  /**
   * Validate token has required permissions
   * @param token The token to validate
   * @param scope The required scope
   * @throws SecurityError if permissions are insufficient
   */
  private static async validateTokenPermissions(token: string, scope: TokenScope): Promise<void> {
    try {
      // Make a test API call to verify token and permissions
      const response = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'DollhouseMCP/1.2.0'
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new SecurityError(
            'GitHub token is invalid or expired',
            'TOKEN_INVALID_OR_EXPIRED',
            'high'
          );
        } else if (response.status === 403) {
          throw new SecurityError(
            'GitHub token lacks required permissions',
            'INSUFFICIENT_PERMISSIONS',
            'high',
            { scope }
          );
        }
        throw new SecurityError(
          `GitHub API error: ${response.status}`,
          'GITHUB_API_ERROR',
          'medium'
        );
      }

      // Check rate limit headers for token validity
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (remaining && parseInt(remaining) < 100) {
        SecurityMonitor.logSecurityEvent({
          type: 'RATE_LIMIT_WARNING',
          severity: 'MEDIUM',
          source: 'SecureTokenManager',
          details: 'GitHub API rate limit low',
          additionalData: { remaining }
        });
      }

      // For write/admin scopes, verify additional permissions
      if (scope === TokenScope.WRITE || scope === TokenScope.ADMIN) {
        const scopes = response.headers.get('x-oauth-scopes');
        if (!scopes || !this.hasRequiredScopes(scopes, scope)) {
          throw new SecurityError(
            `Token lacks required ${scope} permissions`,
            'INSUFFICIENT_SCOPES',
            'high',
            { required: scope, actual: scopes }
          );
        }
      }
    } catch (error) {
      // Network errors should not expose token
      if (error instanceof SecurityError) {
        throw error;
      }
      throw new SecurityError(
        'Failed to validate token permissions',
        'PERMISSION_VALIDATION_FAILED',
        'medium'
      );
    }
  }

  /**
   * Check if token has required OAuth scopes
   */
  private static hasRequiredScopes(scopes: string, requiredScope: TokenScope): boolean {
    const scopeList = scopes.split(',').map(s => s.trim());
    
    switch (requiredScope) {
      case TokenScope.READ:
        return scopeList.includes('repo') || scopeList.includes('public_repo');
      case TokenScope.WRITE:
        return scopeList.includes('repo') || scopeList.includes('public_repo');
      case TokenScope.ADMIN:
        return scopeList.includes('repo') && scopeList.includes('admin:org');
      default:
        return false;
    }
  }

  /**
   * Check if cached token is still fresh
   */
  private static isTokenFresh(metadata: TokenMetadata): boolean {
    const age = Date.now() - metadata.createdAt;
    return age < this.TOKEN_ROTATION_INTERVAL;
  }

  /**
   * Sanitize error messages to remove sensitive data
   * @param error The error to sanitize
   * @returns A safe error object
   */
  private static sanitizeError(error: any): Error {
    let message = error?.message || 'Unknown error';
    let stack = error?.stack || '';

    // Sanitize all token patterns
    for (const pattern of this.TOKEN_PATTERNS) {
      message = message.replace(pattern, '[REDACTED]');
      stack = stack.replace(pattern, '[REDACTED]');
    }

    // Remove any environment variable values
    message = message.replace(/GITHUB_TOKEN=\S+/g, 'GITHUB_TOKEN=[REDACTED]');
    stack = stack.replace(/GITHUB_TOKEN=\S+/g, 'GITHUB_TOKEN=[REDACTED]');

    const sanitizedError = new Error(message);
    sanitizedError.stack = stack;
    
    return sanitizedError;
  }

  /**
   * Clear cached tokens (useful for testing or forced rotation)
   */
  static clearCache(): void {
    this.tokenCache.clear();
    
    SecurityMonitor.logSecurityEvent({
      type: 'TOKEN_CACHE_CLEARED',
      severity: 'LOW',
      source: 'SecureTokenManager',
      details: 'Token cache cleared'
    });
  }

  /**
   * Get token cache statistics (for monitoring)
   */
  static getCacheStats(): { size: number; tokens: string[] } {
    return {
      size: this.tokenCache.size,
      tokens: Array.from(this.tokenCache.keys())
    };
  }
}