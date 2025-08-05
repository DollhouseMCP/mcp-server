/**
 * Secure GitHub token management and validation
 */

import { logger } from '../utils/logger.js';
import { RateLimiter } from '../update/RateLimiter.js';
import { SecurityError } from './errors.js';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { SecurityMonitor } from './securityMonitor.js';
import { UnicodeValidator } from './validators/unicodeValidator.js';

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
  rateLimitExceeded?: boolean;
  retryAfterMs?: number;
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

  // Secure storage configuration
  private static readonly TOKEN_DIR = path.join(homedir(), '.dollhouse', '.auth');
  private static readonly TOKEN_FILE = 'github_token.enc';
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly KEY_LENGTH = 32;
  private static readonly IV_LENGTH = 16;
  private static readonly TAG_LENGTH = 16;
  private static readonly SALT_LENGTH = 32;
  private static readonly ITERATIONS = 100000;

  // Rate limiter for token validation operations - prevents brute force attacks
  private static tokenValidationLimiter: RateLimiter | null = null;

  /**
   * Get or create the token validation rate limiter
   * Prevents brute force token validation attacks
   */
  private static getTokenValidationLimiter(): RateLimiter {
    if (!this.tokenValidationLimiter) {
      this.tokenValidationLimiter = this.createTokenValidationLimiter();
    }
    return this.tokenValidationLimiter;
  }

  /**
   * Create a rate limiter specifically for token validation
   * Conservative limits to prevent abuse while allowing legitimate usage
   */
  static createTokenValidationLimiter(): RateLimiter {
    return new RateLimiter({
      maxRequests: 10,          // 10 validation attempts
      windowMs: 60 * 60 * 1000, // per hour
      minDelayMs: 5 * 1000      // 5 seconds minimum between attempts
    });
  }

  /**
   * Reset the token validation rate limiter
   * Useful for testing or manual intervention
   */
  static resetTokenValidationLimiter(): void {
    this.tokenValidationLimiter?.reset();
  }

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
    // Validate token format before consuming rate limit
    if (!this.validateTokenFormat(token)) {
      return {
        isValid: false,
        error: 'Invalid token format'
      };
    }

    // Check rate limit before making API call
    const rateLimiter = this.getTokenValidationLimiter();
    const rateLimitStatus = rateLimiter.checkLimit();

    if (!rateLimitStatus.allowed) {
      logger.warn('Token validation rate limit exceeded', {
        tokenPrefix: this.getTokenPrefix(token),
        retryAfterMs: rateLimitStatus.retryAfterMs,
        remainingTokens: rateLimitStatus.remainingTokens
      });

      throw new SecurityError(
        `Token validation rate limit exceeded. Please retry in ${Math.ceil((rateLimitStatus.retryAfterMs || 0) / 1000)} seconds.`,
        'RATE_LIMIT_EXCEEDED'
      );
    }

    try {
      // Consume rate limit token for this validation attempt
      rateLimiter.consumeToken();
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
      // Handle SecurityError (including rate limit errors) separately
      if (error instanceof SecurityError && error.code === 'RATE_LIMIT_EXCEEDED') {
        const currentStatus = rateLimiter.checkLimit();
        return {
          isValid: false,
          rateLimitExceeded: true,
          retryAfterMs: currentStatus.retryAfterMs,
          error: error.message
        };
      }

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
   * 
   * NOTE: The 'marketplace' scope identifier is kept for backward compatibility
   * with existing token validations. This is an internal scope name and does not
   * affect user-facing functionality. (PR #280)
   */
  static getRequiredScopes(operation: 'read' | 'write' | 'marketplace' | 'collection' | 'gist'): TokenScopes {
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
      
      case 'marketplace': // Internal scope name kept for compatibility (PR #280)
      case 'collection': // New preferred name
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
   * 
   * NOTE: The 'marketplace' operation type is kept for backward compatibility.
   * This is called internally when accessing collection features. (PR #280)
   */
  static async ensureTokenPermissions(
    operation: 'read' | 'write' | 'marketplace' | 'collection' | 'gist'
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

  /**
   * Derive encryption key from a passphrase
   */
  private static deriveKey(passphrase: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(passphrase, salt, this.ITERATIONS, this.KEY_LENGTH, 'sha256');
  }

  /**
   * Get machine-specific passphrase for encryption
   * Uses a combination of machine ID and user info for uniqueness
   */
  private static getMachinePassphrase(): string {
    // Use a combination of hostname, username, and a fixed app identifier
    const hostname = crypto.createHash('sha256').update(homedir()).digest('hex').substring(0, 16);
    const username = crypto.createHash('sha256').update(process.env.USER || 'default').digest('hex').substring(0, 16);
    const appId = 'DollhouseMCP-TokenStore-v1';
    
    return `${appId}-${hostname}-${username}`;
  }

  /**
   * Store GitHub token securely to file
   */
  static async storeGitHubToken(token: string): Promise<void> {
    try {
      // Validate token format first
      if (!this.validateTokenFormat(token)) {
        throw new SecurityError('Invalid token format');
      }

      // Normalize and validate token
      const validation = UnicodeValidator.normalize(token);
      if (!validation.isValid) {
        throw new SecurityError('Token contains invalid characters');
      }

      // Ensure directory exists
      await fs.mkdir(this.TOKEN_DIR, { recursive: true, mode: 0o700 });

      // Generate encryption components
      const salt = crypto.randomBytes(this.SALT_LENGTH);
      const iv = crypto.randomBytes(this.IV_LENGTH);
      const passphrase = this.getMachinePassphrase();
      const key = this.deriveKey(passphrase, salt);

      // Encrypt token
      const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);
      const encrypted = Buffer.concat([
        cipher.update(validation.normalizedContent, 'utf8'),
        cipher.final()
      ]);
      const tag = cipher.getAuthTag();

      // Create storage format: salt + iv + tag + encrypted
      const stored = Buffer.concat([salt, iv, tag, encrypted]);

      // Write to file with restricted permissions
      const tokenPath = path.join(this.TOKEN_DIR, this.TOKEN_FILE);
      await fs.writeFile(tokenPath, stored, { mode: 0o600 });

      // Log security event
      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_SUCCESS',
        severity: 'LOW',
        source: 'TokenManager.storeGitHubToken',
        details: 'GitHub token stored securely',
        metadata: {
          tokenType: this.getTokenType(token),
          tokenPrefix: this.getTokenPrefix(token)
        }
      });

      logger.info('GitHub token stored securely');
    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_FAILURE',
        severity: 'MEDIUM',
        source: 'TokenManager.storeGitHubToken',
        details: `Failed to store GitHub token: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
      
      throw new SecurityError(`Failed to store token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Retrieve GitHub token from secure storage
   */
  static async retrieveGitHubToken(): Promise<string | null> {
    try {
      const tokenPath = path.join(this.TOKEN_DIR, this.TOKEN_FILE);
      
      // Check if file exists
      try {
        await fs.access(tokenPath);
      } catch {
        // No stored token
        return null;
      }

      // Read encrypted data
      const stored = await fs.readFile(tokenPath);
      
      // Extract components
      const salt = stored.subarray(0, this.SALT_LENGTH);
      const iv = stored.subarray(this.SALT_LENGTH, this.SALT_LENGTH + this.IV_LENGTH);
      const tag = stored.subarray(this.SALT_LENGTH + this.IV_LENGTH, this.SALT_LENGTH + this.IV_LENGTH + this.TAG_LENGTH);
      const encrypted = stored.subarray(this.SALT_LENGTH + this.IV_LENGTH + this.TAG_LENGTH);

      // Derive decryption key
      const passphrase = this.getMachinePassphrase();
      const key = this.deriveKey(passphrase, salt);

      // Decrypt token
      const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]).toString('utf8');

      // Validate decrypted token
      if (!this.validateTokenFormat(decrypted)) {
        SecurityMonitor.logSecurityEvent({
          type: 'TOKEN_VALIDATION_FAILURE',
          severity: 'HIGH',
          source: 'TokenManager.retrieveGitHubToken',
          details: 'Decrypted token has invalid format'
        });
        return null;
      }

      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_SUCCESS',
        severity: 'LOW',
        source: 'TokenManager.retrieveGitHubToken',
        details: 'GitHub token retrieved from secure storage',
        metadata: {
          tokenType: this.getTokenType(decrypted),
          tokenPrefix: this.getTokenPrefix(decrypted)
        }
      });

      return decrypted;
    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_FAILURE',
        severity: 'MEDIUM',
        source: 'TokenManager.retrieveGitHubToken',
        details: `Failed to retrieve GitHub token: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
      
      logger.debug('Failed to retrieve stored token', { error });
      return null;
    }
  }

  /**
   * Remove stored GitHub token
   */
  static async removeStoredToken(): Promise<void> {
    try {
      const tokenPath = path.join(this.TOKEN_DIR, this.TOKEN_FILE);
      
      // Check if file exists before attempting deletion
      try {
        await fs.access(tokenPath);
        await fs.unlink(tokenPath);
        
        SecurityMonitor.logSecurityEvent({
          type: 'TOKEN_CACHE_CLEARED',
          severity: 'LOW',
          source: 'TokenManager.removeStoredToken',
          details: 'GitHub token removed from secure storage'
        });
        
        logger.info('Stored GitHub token removed');
      } catch (error) {
        // File doesn't exist or couldn't be deleted
        logger.debug('No stored token to remove');
      }
    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_CACHE_CLEARED',
        severity: 'LOW',
        source: 'TokenManager.removeStoredToken',
        details: `Failed to remove stored token: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
      
      logger.warn('Failed to remove stored token', { error });
    }
  }

  /**
   * Get GitHub token from environment or secure storage
   * Updated to check secure storage if environment variable not set
   */
  static async getGitHubTokenAsync(): Promise<string | null> {
    // First check environment variable
    const envToken = this.getGitHubToken();
    if (envToken) {
      return envToken;
    }

    // Fall back to secure storage
    return this.retrieveGitHubToken();
  }
}