/**
 * Tool for submitting content to GitHub portfolio repositories
 * Replaces the broken issue-based submission with direct repository saves
 * 
 * FIXES IMPLEMENTED (PR #503):
 * 1. TYPE SAFETY FIX #1 (Issue #497): Changed apiCache from 'any' to proper APICache type
 * 2. TYPE SAFETY FIX #2 (Issue #497): Replaced complex type casting with PortfolioElementAdapter
 * 3. PERFORMANCE (PR #496 recommendation): Using FileDiscoveryUtil for optimized file search
 */

import { GitHubAuthManager } from '../../auth/GitHubAuthManager.js';
import { PortfolioRepoManager } from '../../portfolio/PortfolioRepoManager.js';
import { TokenManager } from '../../security/tokenManager.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { PortfolioIndexManager } from '../../portfolio/PortfolioIndexManager.js';
import { ElementType } from '../../portfolio/types.js';
import { logger } from '../../utils/logger.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { APICache } from '../../cache/APICache.js';
import { PortfolioElementAdapter } from './PortfolioElementAdapter.js';
import { FileDiscoveryUtil } from '../../utils/FileDiscoveryUtil.js';
import { ErrorHandler } from '../../utils/ErrorHandler.js';
import { 
  FILE_SIZE_LIMITS, 
  RETRY_CONFIG, 
  SEARCH_CONFIG,
  PortfolioElementMetadata,
  getValidatedTimeout,
  calculateRetryDelay
} from '../../config/portfolio-constants.js';
import { githubRateLimiter } from '../../utils/GitHubRateLimiter.js';
import { EarlyTerminationSearch } from '../../utils/EarlyTerminationSearch.js';
import { CollectionErrorCode, formatCollectionError } from '../../config/error-codes.js';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface SubmitToPortfolioParams {
  name: string;
  type?: ElementType;
}

export interface PortfolioElement {
  type: ElementType;
  metadata: PortfolioElementMetadata;
  content: string;
}

export interface SubmitToPortfolioResult {
  success: boolean;
  message: string;
  url?: string;
  error?: string;
}

export interface ElementDetectionMatch {
  type: ElementType;
  path: string;
}

export interface ElementDetectionResult {
  found: boolean;
  matches: ElementDetectionMatch[];
}

export class SubmitToPortfolioTool {
  private authManager: GitHubAuthManager;
  private portfolioManager: PortfolioRepoManager;

  constructor(apiCache: APICache) {
    // TYPE SAFETY FIX #1: Proper typing for apiCache parameter
    // Previously: constructor(apiCache: any)
    // Now: constructor(apiCache: APICache) with proper import
    this.authManager = new GitHubAuthManager(apiCache);
    this.portfolioManager = new PortfolioRepoManager();
  }

  /**
   * Validates and normalizes input parameters to prevent Unicode attacks and ensure data safety
   * @param params The input parameters from the user
   * @returns Validation result with normalized name or error response
   */
  private async validateAndNormalizeParams(params: SubmitToPortfolioParams): Promise<{
    success: boolean;
    safeName?: string;
    error?: SubmitToPortfolioResult;
  }> {
    // Normalize user input to prevent Unicode attacks (DMCP-SEC-004)
    const normalizedName = UnicodeValidator.normalize(params.name);
    if (!normalizedName.isValid) {
      SecurityMonitor.logSecurityEvent({
        type: 'UNICODE_VALIDATION_ERROR',
        severity: 'MEDIUM',
        source: 'SubmitToPortfolioTool.execute',
        details: `Invalid Unicode in element name: ${normalizedName.detectedIssues?.[0] || 'unknown error'}`
      });
      return {
        success: false,
        error: {
          success: false,
          message: `Invalid characters in element name: ${normalizedName.detectedIssues?.[0] || 'unknown error'}`,
          error: 'INVALID_INPUT'
        }
      };
    }
    
    return {
      success: true,
      safeName: normalizedName.normalizedContent
    };
  }

  /**
   * Checks if the user is authenticated with GitHub
   * @returns Authentication check result with status or error response
   */
  private async checkAuthentication(): Promise<{
    success: boolean;
    authStatus?: any;
    error?: SubmitToPortfolioResult;
  }> {
    const authStatus = await this.authManager.getAuthStatus();
    if (!authStatus.isAuthenticated) {
      // Log authentication required (using existing event type)
      logger.warn('User attempted portfolio submission without authentication');
      return {
        success: false,
        error: {
          success: false,
          message: 'Not authenticated. Please authenticate first using the GitHub OAuth flow.\n\n' +
                   'Visit: https://docs.anthropic.com/en/docs/claude-code/oauth-setup\n' +
                   'Or run: gh auth login --web',
          error: 'NOT_AUTHENTICATED'
        }
      };
    }

    return {
      success: true,
      authStatus
    };
  }

  /**
   * Discovers content locally with smart type detection
   * @param safeName The normalized name to search for
   * @param explicitType Optional explicit element type provided by user
   * @param originalName Original user-provided name for error messages
   * @returns Content discovery result with element type and path or error response
   */
  private async discoverContentWithTypeDetection(
    safeName: string, 
    explicitType?: ElementType, 
    originalName?: string
  ): Promise<{
    success: boolean;
    elementType?: ElementType;
    localPath?: string;
    error?: SubmitToPortfolioResult;
  }> {
    let elementType = explicitType;
    let localPath: string | null = null;
    
    if (elementType) {
      // Type explicitly provided - search in that specific directory only
      localPath = await this.findLocalContent(safeName, elementType);
      if (!localPath) {
        // UX IMPROVEMENT: Provide helpful suggestions for finding content
        const portfolioManager = PortfolioManager.getInstance();
        const elementDir = portfolioManager.getElementDir(elementType);
        
        return {
          success: false,
          error: {
            success: false,
            message: `Could not find ${elementType} named "${originalName || safeName}" in local portfolio.\n\n` +
                    `**Searched in**: ${elementDir}\n\n` +
                    `**Troubleshooting Tips**:\n` +
                    `• Check if the file exists using your file explorer\n` +
                    `• Try using the exact filename (without extension)\n` +
                    `• Use \`list_portfolio\` to see all available ${elementType}\n` +
                    `• If unsure of the type, omit --type and let the system detect it\n\n` +
                    `**Common name formats that work**:\n` +
                    `• "my-element" (kebab-case)\n` +
                    `• "My Element" (with spaces)\n` +
                    `• "MyElement" (PascalCase)\n` +
                    `• Partial matches are supported`,
            error: 'CONTENT_NOT_FOUND'
          }
        };
      }
    } else {
      // CRITICAL FIX: No type provided - implement smart detection across ALL element types
      // This prevents the previous hardcoded default to PERSONA and enables proper type detection
      const detectionResult = await this.detectElementType(safeName);
      
      if (!detectionResult.found) {
        // UX IMPROVEMENT: Enhanced guidance with specific suggestions
        const availableTypes = Object.values(ElementType).join(', ');
        
        // Get suggestions for similar names
        const suggestions = await this.generateNameSuggestions(safeName);
        
        let message = `Content "${originalName || safeName}" not found in portfolio.\n\n`;
        message += `🔍 **Searched in all element types**: ${availableTypes}\n\n`;
        
        if (suggestions.length > 0) {
          message += `💡 **Did you mean one of these?**\n`;
          for (const suggestion of suggestions.slice(0, SEARCH_CONFIG.MAX_SUGGESTIONS)) {
            message += `  • "${suggestion.name}" (${suggestion.type})\n`;
          }
          message += `\n`;
        }
        
        message += `🛠️ **Troubleshooting Steps**:\n`;
        message += `1. 📝 Use \`list_portfolio\` to see all available content\n`;
        message += `2. 🔍 Check exact spelling and try variations:\n`;
        message += `   • "${(originalName || safeName).toLowerCase()}" (lowercase)\n`;
        message += `   • "${(originalName || safeName).replace(/[^a-z0-9]/gi, '-').toLowerCase()}" (normalized)\n`;
        if ((originalName || safeName).includes('.')) {
          message += `   • "${(originalName || safeName).replace(/\./g, '')}" (no dots)\n`;
        }
        message += `3. 🎯 Specify element type: \`submit_content "${originalName || safeName}" --type=personas\`\n`;
        message += `4. 📁 Check if file exists in portfolio directories\n\n`;
        message += `📝 **Tip**: The system searches filenames AND metadata names with fuzzy matching.`;
        
        return {
          success: false,
          error: {
            success: false,
            message,
            error: 'CONTENT_NOT_FOUND'
          }
        };
      }
      
      if (detectionResult.matches.length > 1) {
        // Multiple matches found - ask user to specify type
        const matchDetails = detectionResult.matches.map(m => `- ${m.type}: ${m.path}`).join('\n');
        return {
          success: false,
          error: {
            success: false,
            message: `Content "${originalName || safeName}" found in multiple element types:\n\n${matchDetails}\n\n` +
                    `Please specify the element type using the --type parameter to avoid ambiguity.`,
            error: 'MULTIPLE_MATCHES_FOUND'
          }
        };
      }
      
      // Single match found - use it
      const match = detectionResult.matches[0];
      elementType = match.type;
      localPath = match.path;
      
      logger.info(`Smart detection: Found "${safeName}" as ${elementType}`, { 
        name: safeName,
        detectedType: elementType,
        path: localPath
      });
    }

    return {
      success: true,
      elementType,
      localPath
    };
  }

  /**
   * Validates file size and content security before processing
   * @param localPath Path to the local file to validate
   * @returns Validation result with content or error response
   */
  private async validateFileAndContent(localPath: string): Promise<{
    success: boolean;
    content?: string;
    error?: SubmitToPortfolioResult;
  }> {
    // SECURITY ENHANCEMENT (Task #7): Validate file path before processing
    const pathValidation = await this.validatePortfolioPath(localPath);
    if (!pathValidation.isValid) {
      return {
        success: false,
        error: pathValidation.error
      };
    }

    // Use the validated safe path for all subsequent operations
    const safePath = pathValidation.safePath!;

    // Validate file size before reading
    const stats = await fs.stat(safePath);
    if (stats.size > FILE_SIZE_LIMITS.MAX_FILE_SIZE) {
      SecurityMonitor.logSecurityEvent({
        type: 'RATE_LIMIT_EXCEEDED',
        severity: 'MEDIUM',
        source: 'SubmitToPortfolioTool.execute',
        details: `File size ${stats.size} exceeds limit of ${FILE_SIZE_LIMITS.MAX_FILE_SIZE}`
      });
      return {
        success: false,
        error: {
          success: false,
          message: `File size exceeds ${FILE_SIZE_LIMITS.MAX_FILE_SIZE_MB}MB limit`,
          error: 'FILE_TOO_LARGE'
        }
      };
    }

    // Validate content security
    const content = await fs.readFile(safePath, 'utf-8');
    const validationResult = ContentValidator.validateAndSanitize(content);

    if (!validationResult.isValid && validationResult.severity === 'critical') {
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_INJECTION_ATTEMPT',
        severity: 'HIGH',
        source: 'SubmitToPortfolioTool.execute',
        details: `Critical security issues detected: ${validationResult.detectedPatterns?.join(', ')}`
      });
      return {
        success: false,
        error: {
          success: false,
          message: `Content validation failed: ${validationResult.detectedPatterns?.join(', ')}`,
          error: 'VALIDATION_FAILED'
        }
      };
    }

    return {
      success: true,
      content
    };
  }

  /**
   * Prepares metadata for the portfolio element
   * @param safeName The normalized name of the element
   * @param elementType The type of the element
   * @param authStatus Authentication status containing username
   * @returns Metadata object for the element
   */
  private prepareElementMetadata(
    safeName: string, 
    elementType: ElementType, 
    authStatus: any
  ): PortfolioElementMetadata {
    return {
      name: safeName,
      description: `${elementType} submitted from local portfolio`,
      author: authStatus.username || 'unknown',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      version: '1.0.0'
    };
  }

  /**
   * Validates GitHub token and checks for expiration before usage
   * SECURITY ENHANCEMENT (Task #5): Token expiration validation to prevent stale token usage
   * @param token The GitHub token to validate
   * @returns Validation result with status and expiration info
   */
  private async validateTokenBeforeUsage(token: string): Promise<{
    isValid: boolean;
    isNearExpiry?: boolean;
    error?: SubmitToPortfolioResult;
  }> {
    try {
      // Check token format first (basic validation)
      if (!TokenManager.validateTokenFormat(token)) {
        SecurityMonitor.logSecurityEvent({
          type: 'TOKEN_VALIDATION_FAILURE',
          severity: 'MEDIUM',
          source: 'SubmitToPortfolioTool.validateTokenBeforeUsage',
          details: 'Token has invalid format'
        });
        
        return {
          isValid: false,
          error: {
            success: false,
            message: 'Invalid token format. Please re-authenticate.',
            error: 'INVALID_TOKEN_FORMAT'
          }
        };
      }

      // Validate token with GitHub API to check expiration and permissions
      // NOTE: OAuth tokens use 'public_repo' scope, not 'repo'
      // Using centralized scope management for consistency
      const requiredScopes = TokenManager.getRequiredScopes('collection');
      const validationResult = await TokenManager.validateTokenScopes(token, requiredScopes);

      if (!validationResult.isValid) {
        SecurityMonitor.logSecurityEvent({
          type: 'TOKEN_VALIDATION_FAILURE',
          severity: 'MEDIUM',
          source: 'SubmitToPortfolioTool.validateTokenBeforeUsage',
          details: `Token validation failed: ${validationResult.error}`
        });

        // Enhanced OAuth-specific error messages
        const tokenType = TokenManager.getTokenType(token);
        let errorCode: CollectionErrorCode;
        let enhancedDetails: string | undefined = validationResult.error;
        
        if (validationResult.error?.includes('Missing required scopes')) {
          errorCode = CollectionErrorCode.COLL_AUTH_002;
          // Provide OAuth-specific guidance if it's an OAuth token
          if (tokenType === 'OAuth Access Token') {
            enhancedDetails = `OAuth token missing 'public_repo' scope. Please re-authenticate with 'setup_github_auth' to get the correct scope.`;
          }
        } else {
          errorCode = CollectionErrorCode.COLL_AUTH_001;
        }

        return {
          isValid: false,
          error: {
            success: false,
            message: formatCollectionError(errorCode, 3, 5, enhancedDetails),
            error: errorCode
          }
        };
      }

      // Check if token is near expiration (rate limit reset time can indicate token freshness)
      let isNearExpiry = false;
      if (validationResult.rateLimit?.resetTime) {
        const now = new Date();
        const timeUntilReset = validationResult.rateLimit.resetTime.getTime() - now.getTime();
        const oneHour = 60 * 60 * 1000;
        
        // Consider token "near expiry" if rate limit reset is more than 23 hours away
        // (GitHub rate limits reset every hour, so this suggests token age)
        if (timeUntilReset > 23 * oneHour) {
          isNearExpiry = true;
          logger.warn('GitHub token may be near expiration', {
            tokenPrefix: TokenManager.getTokenPrefix(token),
            rateLimitResetTime: validationResult.rateLimit.resetTime,
            recommendation: 'Consider re-authenticating for long operations'
          });
        }
      }

      // Log successful validation
      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_SUCCESS',
        severity: 'LOW',
        source: 'SubmitToPortfolioTool.validateTokenBeforeUsage',
        details: 'GitHub token validated successfully before usage',
        metadata: {
          tokenType: TokenManager.getTokenType(token),
          scopes: validationResult.scopes,
          rateLimitRemaining: validationResult.rateLimit?.remaining,
          isNearExpiry
        }
      });

      return {
        isValid: true,
        isNearExpiry
      };

    } catch (error: any) {
      // Handle rate limit exceeded specifically
      if (error?.code === 'RATE_LIMIT_EXCEEDED') {
        logger.warn('Token validation rate limited, allowing operation to proceed with cached status');
        // Still allow operation but log with COLL_API_001
        SecurityMonitor.logSecurityEvent({
          type: 'TOKEN_VALIDATION_SUCCESS',
          severity: 'LOW',
          source: 'SubmitToPortfolioTool.validateTokenBeforeUsage',
          details: 'Token validation rate limited but proceeding with cached status'
        });
        return { isValid: true }; // Allow to proceed if rate limited, as basic format check passed
      }

      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_FAILURE',
        severity: 'HIGH',
        source: 'SubmitToPortfolioTool.validateTokenBeforeUsage',
        details: `Token validation error: ${error.message || 'unknown error'}`
      });

      return {
        isValid: false,
        error: {
          success: false,
          message: 'Unable to validate GitHub token. Please check your connection and try again.',
          error: 'TOKEN_VALIDATION_ERROR'
        }
      };
    }
  }

  /**
   * Enhanced path validation for portfolio operations with comprehensive security checks
   * SECURITY ENHANCEMENT (Task #7): Additional validation for special characters and malicious patterns
   * @param filePath The file path to validate
   * @returns Validation result with secure path or error response
   */
  private async validatePortfolioPath(filePath: string): Promise<{
    isValid: boolean;
    safePath?: string;
    error?: SubmitToPortfolioResult;
  }> {
    try {
      // Basic null/undefined check
      if (!filePath || typeof filePath !== 'string') {
        SecurityMonitor.logSecurityEvent({
          type: 'PATH_TRAVERSAL_ATTEMPT',
          severity: 'MEDIUM',
          source: 'SubmitToPortfolioTool.validatePortfolioPath',
          details: 'Invalid path provided - null, undefined, or non-string'
        });
        
        return {
          isValid: false,
          error: {
            success: false,
            message: 'Invalid file path provided',
            error: 'INVALID_PATH'
          }
        };
      }

      // Check for suspicious patterns that could indicate path traversal or injection
      const suspiciousPatterns = [
        /\.\./,                    // Path traversal
        /\/\.\./,                  // Unix path traversal
        /\\\.\./,                  // Windows path traversal
        /\x00/,                    // Null bytes
        /[\x01-\x1f\x7f-\x9f]/,    // Control characters
        /[<>:"|?*]/,               // Invalid filename characters on Windows
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i, // Reserved Windows names
        /^\./,                     // Hidden files (starting with dot)
        /\s+$/,                    // Trailing whitespace
        /^[\s]*$/,                 // Only whitespace
        /%[0-9a-fA-F]{2}/,         // URL encoding (potential bypass attempt)
        /\\x[0-9a-fA-F]{2}/,       // Hex encoding
        /\$\{.*\}/,                // Template literal injection
        /`.*`/,                    // Backtick injection
        /[\\\/]{2,}/               // Multiple consecutive slashes
      ];

      for (const pattern of suspiciousPatterns) {
        if (pattern.test(filePath)) {
          SecurityMonitor.logSecurityEvent({
            type: 'PATH_TRAVERSAL_ATTEMPT',
            severity: 'HIGH',
            source: 'SubmitToPortfolioTool.validatePortfolioPath',
            details: `Suspicious pattern detected in file path: ${pattern.source}`,
            metadata: {
              pathLength: filePath.length,
              pattern: pattern.source
            }
          });
          
          return {
            isValid: false,
            error: {
              success: false,
              message: 'File path contains invalid or suspicious characters',
              error: 'SUSPICIOUS_PATH_PATTERN'
            }
          };
        }
      }

      // Check path length (prevent buffer overflow attempts)
      const MAX_PATH_LENGTH = process.platform === 'win32' ? 260 : 4096;
      if (filePath.length > MAX_PATH_LENGTH) {
        SecurityMonitor.logSecurityEvent({
          type: 'PATH_TRAVERSAL_ATTEMPT',
          severity: 'MEDIUM',
          source: 'SubmitToPortfolioTool.validatePortfolioPath',
          details: `File path exceeds maximum length: ${filePath.length} > ${MAX_PATH_LENGTH}`
        });
        
        return {
          isValid: false,
          error: {
            success: false,
            message: 'File path is too long',
            error: 'PATH_TOO_LONG'
          }
        };
      }

      // Normalize path to resolve any relative components safely
      let normalizedPath: string;
      try {
        // Remove null bytes and normalize
        const cleanPath = filePath.replace(/\x00/g, '');
        normalizedPath = path.normalize(cleanPath);
        
        // Check if path is within the portfolio directory
        const portfolioManager = PortfolioManager.getInstance();
        const portfolioBase = portfolioManager.getBaseDir();
        
        // For absolute paths, verify they're within the portfolio directory
        if (path.isAbsolute(normalizedPath)) {
          const resolvedPath = path.resolve(normalizedPath);
          const resolvedBase = path.resolve(portfolioBase);
          
          // Path must be within the portfolio directory
          if (!resolvedPath.startsWith(resolvedBase)) {
            throw new Error('Path is outside portfolio directory');
          }
        } else if (normalizedPath.includes('..')) {
          // Relative paths with .. are not allowed
          throw new Error('Path contains directory traversal');
        }
      } catch (error) {
        SecurityMonitor.logSecurityEvent({
          type: 'PATH_TRAVERSAL_ATTEMPT',
          severity: 'HIGH',
          source: 'SubmitToPortfolioTool.validatePortfolioPath',
          details: `Path normalization failed: ${error instanceof Error ? error.message : 'unknown error'}`
        });
        
        return {
          isValid: false,
          error: {
            success: false,
            message: 'File path could not be safely processed',
            error: 'PATH_NORMALIZATION_FAILED'
          }
        };
      }

      // Validate file extension (only allow safe extensions for portfolio content)
      const allowedExtensions = ['.md', '.markdown', '.txt', '.yml', '.yaml', '.json'];
      const fileExtension = path.extname(normalizedPath).toLowerCase();
      
      if (fileExtension && !allowedExtensions.includes(fileExtension)) {
        SecurityMonitor.logSecurityEvent({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'MEDIUM',
          source: 'SubmitToPortfolioTool.validatePortfolioPath',
          details: `Disallowed file extension: ${fileExtension}`,
          metadata: {
            allowedExtensions: allowedExtensions.join(', ')
          }
        });
        
        return {
          isValid: false,
          error: {
            success: false,
            message: `File extension '${fileExtension}' is not allowed. Allowed extensions: ${allowedExtensions.join(', ')}`,
            error: 'INVALID_FILE_EXTENSION'
          }
        };
      }

      // Validate filename characters (only allow safe characters)
      const basename = path.basename(normalizedPath);
      const safeFilenamePattern = /^[a-zA-Z0-9\-_.\s()[\]{}]+$/;
      
      if (basename && !safeFilenamePattern.test(basename)) {
        SecurityMonitor.logSecurityEvent({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'MEDIUM',
          source: 'SubmitToPortfolioTool.validatePortfolioPath',
          details: 'Filename contains potentially dangerous characters',
          metadata: {
            filename: basename,
            allowedPattern: safeFilenamePattern.source
          }
        });
        
        return {
          isValid: false,
          error: {
            success: false,
            message: 'Filename contains invalid characters. Only letters, numbers, spaces, hyphens, underscores, dots, and common brackets are allowed.',
            error: 'INVALID_FILENAME_CHARACTERS'
          }
        };
      }

      // Log successful validation
      SecurityMonitor.logSecurityEvent({
        type: 'CONTENT_INJECTION_ATTEMPT',
        severity: 'LOW',
        source: 'SubmitToPortfolioTool.validatePortfolioPath',
        details: 'File path validation successful',
        metadata: {
          originalPathLength: filePath.length,
          normalizedPathLength: normalizedPath.length,
          fileExtension: fileExtension || 'none'
        }
      });

      return {
        isValid: true,
        safePath: normalizedPath
      };

    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'HIGH',
        source: 'SubmitToPortfolioTool.validatePortfolioPath',
        details: `Path validation error: ${error instanceof Error ? error.message : 'unknown error'}`
      });
      
      return {
        isValid: false,
        error: {
          success: false,
          message: 'Unable to validate file path. Please check the file path and try again.',
          error: 'PATH_VALIDATION_ERROR'
        }
      };
    }
  }

  /**
   * Smart token management for long operations with refresh-like capabilities
   * SECURITY ENHANCEMENT (Task #14): Token refresh logic for long operations
   * 
   * Note: GitHub OAuth device flow tokens don't have traditional refresh tokens,
   * but we can implement smart validation and guidance for long operations
   * 
   * @param operationType Type of operation being performed
   * @returns Token management result with recommendations
   */
  private async manageTokenForLongOperation(operationType: 'portfolio_creation' | 'collection_submission' | 'file_upload'): Promise<{
    canProceed: boolean;
    token?: string;
    refreshRecommended?: boolean;
    error?: SubmitToPortfolioResult;
  }> {
    try {
      // Get current token
      const token = await TokenManager.getGitHubTokenAsync();
      if (!token) {
        return {
          canProceed: false,
          error: {
            success: false,
            message: 'No GitHub token available. Please authenticate first.',
            error: 'NO_TOKEN'
          }
        };
      }

      // Validate token for the specific operation
      const validation = await this.validateTokenBeforeUsage(token);
      if (!validation.isValid) {
        return {
          canProceed: false,
          error: validation.error
        };
      }

      // Check if this is a long operation that might benefit from fresh authentication
      const longOperations = ['portfolio_creation', 'collection_submission'];
      const isLongOperation = longOperations.includes(operationType);

      // Get token type to determine refresh capabilities
      const tokenType = TokenManager.getTokenType(token);
      let refreshRecommended = false;

      // For long operations, check token age and recommend refresh if needed
      if (isLongOperation && validation.isNearExpiry) {
        refreshRecommended = true;
        
        SecurityMonitor.logSecurityEvent({
          type: 'TOKEN_VALIDATION_SUCCESS',
          severity: 'LOW',
          source: 'SubmitToPortfolioTool.manageTokenForLongOperation',
          details: 'Long operation detected with aging token - refresh recommended',
          metadata: {
            operationType,
            tokenType,
            refreshRecommended: true
          }
        });

        logger.warn('Long operation with potentially aging token detected', {
          operationType,
          tokenType,
          recommendation: 'Consider re-authenticating if operation fails'
        });
      }

      // For OAuth tokens in long operations, we can provide guidance
      if (tokenType === 'OAuth Access Token' && isLongOperation) {
        logger.info('OAuth token detected for long operation', {
          operationType,
          tokenType,
          guidance: 'OAuth tokens are time-limited. If operation fails, re-authenticate using setup_github_auth'
        });
      }

      // Log successful token management
      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_SUCCESS',
        severity: 'LOW',
        source: 'SubmitToPortfolioTool.manageTokenForLongOperation',
        details: 'Token management successful for long operation',
        metadata: {
          operationType,
          tokenType,
          isLongOperation,
          refreshRecommended
        }
      });

      return {
        canProceed: true,
        token,
        refreshRecommended
      };

    } catch (error: any) {
      SecurityMonitor.logSecurityEvent({
        type: 'TOKEN_VALIDATION_FAILURE',
        severity: 'MEDIUM',
        source: 'SubmitToPortfolioTool.manageTokenForLongOperation',
        details: `Token management error: ${error.message || 'unknown error'}`
      });

      return {
        canProceed: false,
        error: {
          success: false,
          message: 'Unable to manage token for operation. Please check your authentication and try again.',
          error: 'TOKEN_MANAGEMENT_ERROR'
        }
      };
    }
  }

  /**
   * Provides user guidance for token refresh when operations fail due to token issues
   * SECURITY ENHANCEMENT (Task #14): User guidance for authentication refresh
   */
  private formatTokenRefreshGuidance(operationType: string, tokenType: string): string {
    let guidance = '\n\n🔄 **Token Refresh Guidance**:\n';
    
    if (tokenType === 'OAuth Access Token') {
      guidance += '• Your OAuth token may have expired\n';
      guidance += '• Run `setup_github_auth` to authenticate again\n';
      guidance += '• This will generate a fresh token for continued access\n';
    } else if (tokenType === 'Personal Access Token') {
      guidance += '• Your Personal Access Token may have expired\n';
      guidance += '• Check your GitHub settings: https://github.com/settings/tokens\n';
      guidance += '• Generate a new token if needed and update GITHUB_TOKEN environment variable\n';
    } else {
      guidance += '• Your GitHub token may have expired or been revoked\n';
      guidance += '• Re-authenticate using `setup_github_auth`\n';
      guidance += '• Ensure your token has the required permissions\n';
    }

    guidance += `\n**Operation**: ${operationType}\n`;
    guidance += '**Required scopes**: repo, user:email\n\n';
    guidance += '💡 **Tip**: Fresh tokens work better for complex operations like portfolio creation.';

    return guidance;
  }

  /**
   * Sets up GitHub repository access and ensures portfolio repository exists
   * @param authStatus Authentication status containing username
   * @returns Setup result or error response
   */
  private async setupGitHubRepository(authStatus: any): Promise<{
    success: boolean;
    error?: SubmitToPortfolioResult;
  }> {
    // SECURITY ENHANCEMENT (Task #14): Smart token management for long operations
    const tokenManagement = await this.manageTokenForLongOperation('portfolio_creation');
    if (!tokenManagement.canProceed) {
      return {
        success: false,
        error: tokenManagement.error
      };
    }

    const token = tokenManagement.token!;

    // Provide user guidance if refresh is recommended for this long operation
    if (tokenManagement.refreshRecommended) {
      const tokenType = TokenManager.getTokenType(token);
      const guidance = this.formatTokenRefreshGuidance('portfolio creation', tokenType);
      logger.warn(`Token refresh recommended for portfolio creation:${guidance}`);
    }

    this.portfolioManager.setToken(token);

    // Check if portfolio exists and create if needed
    const username = authStatus.username || 'unknown';
    const portfolioExists = await this.portfolioManager.checkPortfolioExists(username);
    
    if (!portfolioExists) {
      logger.info('Creating portfolio repository...');
      // Request consent for portfolio creation
      const repoUrl = await this.portfolioManager.createPortfolio(username, true);
      if (!repoUrl) {
        return {
          success: false,
          error: {
            success: false,
            message: 'Failed to create portfolio repository',
            error: 'CREATE_FAILED'
          }
        };
      }
    }

    return { success: true };
  }

  /**
   * Submits element to portfolio and handles the complete response workflow
   * @param safeName The normalized name of the element
   * @param elementType The type of the element
   * @param metadata The metadata for the element
   * @param content The content of the element
   * @param authStatus Authentication status containing username and token
   * @returns Complete submission result with success message or error
   */
  private async submitElementAndHandleResponse(
    safeName: string,
    elementType: ElementType,
    metadata: PortfolioElementMetadata,
    content: string,
    authStatus: any
  ): Promise<SubmitToPortfolioResult> {
    // Create element structure to save
    const element: PortfolioElement = {
      type: elementType,
      metadata,
      content
    };
    
    // TYPE SAFETY FIX #2: Use adapter pattern instead of complex type casting
    // Previously: element as unknown as Parameters<typeof this.portfolioManager.saveElement>[0]
    // Now: Clean adapter pattern that implements IElement interface properly
    const adapter = new PortfolioElementAdapter(element);
    
    // UX IMPROVEMENT: Add retry logic for transient failures
    const fileUrl = await this.saveElementWithRetry(adapter, safeName, elementType);
    
    if (!fileUrl) {
      return {
        success: false,
        message: 'Failed to save element to GitHub portfolio after multiple attempts.\n\n' +
                '💡 **Troubleshooting Tips**:\n' +
                '• Check your GitHub authentication: `gh auth status`\n' +
                '• Verify repository permissions\n' +
                '• Try again in a few minutes (GitHub API rate limits)\n' +
                '• Check GitHub status: https://status.github.com',
        error: 'SAVE_FAILED'
      };
    }

    // Log successful submission (DMCP-SEC-006)
    logger.info(`Successfully submitted ${safeName} to GitHub portfolio`, {
      elementType,
      username: authStatus.username,
      fileUrl
    });

    // SECURITY ENHANCEMENT (Task #14): Smart token management for collection submission
    const collectionTokenManagement = await this.manageTokenForLongOperation('collection_submission');
    if (!collectionTokenManagement.canProceed) {
      // Token management failed for collection submission, but main submission succeeded
      const errorMessage = collectionTokenManagement.error?.message || 'Token management failed';
      return {
        success: true,
        message: `✅ Successfully uploaded ${safeName} to your GitHub portfolio!\n📁 Portfolio URL: ${fileUrl}\n\n⚠️ Collection submission skipped: ${errorMessage}`,
        url: fileUrl
      };
    }

    const token = collectionTokenManagement.token!;

    // Provide refresh guidance if recommended for collection submission
    if (collectionTokenManagement.refreshRecommended) {
      const tokenType = TokenManager.getTokenType(token);
      logger.info('Collection submission proceeding with aging token', {
        tokenType,
        recommendation: 'If collection submission fails, try re-authenticating with setup_github_auth'
      });
    }

    // ENHANCEMENT (Issue #549): Ask user if they want to submit to collection
    // This completes the community contribution workflow
    const collectionSubmissionResult = await this.promptForCollectionSubmission({
      elementName: safeName,
      elementType,
      portfolioUrl: fileUrl,
      username: authStatus.username || 'unknown',
      metadata,
      token
    });

    // Build the response message based on what happened
    let message = `✅ Successfully uploaded ${safeName} to your GitHub portfolio!\n`;
    message += `📁 Portfolio URL: ${fileUrl}\n\n`;
    
    if (collectionSubmissionResult.submitted) {
      message += `🎉 Also submitted to DollhouseMCP collection for community review!\n`;
      message += `📋 Issue: ${collectionSubmissionResult.issueUrl}`;
    } else if (collectionSubmissionResult.declined) {
      message += `💡 You can submit to the collection later using the same command.`;
    } else if (collectionSubmissionResult.error) {
      message += `⚠️ Collection submission failed: ${collectionSubmissionResult.error}\n`;
      message += `💡 You can manually submit at: https://github.com/DollhouseMCP/collection/issues/new`;
    }

    return {
      success: true,
      message,
      url: fileUrl
    };
  }

  async execute(params: SubmitToPortfolioParams): Promise<SubmitToPortfolioResult> {
    try {
      // Validate and normalize input parameters
      const validationResult = await this.validateAndNormalizeParams(params);
      if (!validationResult.success) {
        return validationResult.error!;
      }
      const safeName = validationResult.safeName!;

      // Check authentication status
      const authResult = await this.checkAuthentication();
      if (!authResult.success) {
        return authResult.error!;
      }
      const authStatus = authResult.authStatus!;

      // Find content locally with smart type detection
      const contentResult = await this.discoverContentWithTypeDetection(safeName!, params.type, params.name);
      if (!contentResult.success) {
        return contentResult.error!;
      }
      const elementType = contentResult.elementType!;
      const localPath = contentResult.localPath!;

      // Validate file and content security
      const securityResult = await this.validateFileAndContent(localPath);
      if (!securityResult.success) {
        return securityResult.error!;
      }
      const content = securityResult.content!;

      // Get user consent (placeholder for now - could add interactive prompt later)
      logger.info(`Preparing to submit ${safeName} to GitHub portfolio`);

      // Prepare metadata for element
      const metadata = this.prepareElementMetadata(safeName!, elementType, authStatus);

      // Set up GitHub repository access
      const repoResult = await this.setupGitHubRepository(authStatus);
      if (!repoResult.success) {
        return repoResult.error!;
      }

      // Submit element to portfolio and handle collection submission
      return await this.submitElementAndHandleResponse(
        safeName!, 
        elementType, 
        metadata, 
        content, 
        authStatus
      );

    } catch (error) {
      // SECURITY ENHANCEMENT (Task #14): Enhanced error handling with token refresh guidance
      ErrorHandler.logError('submitToPortfolio', error, {
        elementName: params.name,
        elementType: params.type
      });

      // Check if error is token-related and provide refresh guidance
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTokenError = errorMessage.toLowerCase().includes('token') || 
                          errorMessage.toLowerCase().includes('auth') ||
                          errorMessage.toLowerCase().includes('401') ||
                          errorMessage.toLowerCase().includes('403');

      let formattedError = ErrorHandler.formatForResponse(error);

      if (isTokenError) {
        try {
          // Get current token to determine type for guidance
          const currentToken = await TokenManager.getGitHubTokenAsync();
          if (currentToken) {
            const tokenType = TokenManager.getTokenType(currentToken);
            const refreshGuidance = this.formatTokenRefreshGuidance('portfolio submission', tokenType);
            
            // Append refresh guidance to error message
            if (formattedError.message) {
              formattedError.message += refreshGuidance;
            }
          }
        } catch (tokenError) {
          // If we can't get token info, provide generic guidance
          formattedError.message += '\n\n🔄 **Authentication Issue**: Try running `setup_github_auth` to refresh your authentication.';
        }
      }

      return formattedError;
    }
  }

  /**
   * Prompts user to submit content to the DollhouseMCP collection
   * ENHANCEMENT (Issue #549): Complete the community contribution workflow
   */
  private async promptForCollectionSubmission(params: {
    elementName: string;
    elementType: ElementType;
    portfolioUrl: string;
    username: string;
    metadata: PortfolioElementMetadata;
    token: string;
  }): Promise<{ submitted: boolean; declined: boolean; error?: string; issueUrl?: string }> {
    try {
      // Create a simple prompt message for the user
      // Note: In MCP context, we can't do interactive prompts, so we'll need to
      // either make this automatic or require a parameter
      
      // For now, let's check if the user has set an environment variable
      // to auto-submit to collection (opt-in behavior)
      const autoSubmit = process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION === 'true';
      
      if (!autoSubmit) {
        // User hasn't opted in to auto-submission
        logger.info('Collection submission skipped (set DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION=true to enable)');
        // Use COLL_CFG_001 error code for auto-submit disabled
        const errorMessage = formatCollectionError(CollectionErrorCode.COLL_CFG_001, 5, 5);
        return { submitted: false, declined: true, error: errorMessage };
      }

      logger.info('Auto-submitting to DollhouseMCP collection...');

      // Create the issue in the collection repository
      const issueUrl = await this.createCollectionIssue({
        ...params,
        token: params.token
      });

      if (issueUrl) {
        logger.info('Successfully created collection submission issue', { issueUrl });
        return { submitted: true, declined: false, issueUrl };
      } else {
        return { submitted: false, declined: false, error: 'Failed to create issue' };
      }

    } catch (error) {
      logger.error('Error in collection submission prompt', { error });
      return {
        submitted: false,
        declined: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Creates an issue in the DollhouseMCP/collection repository
   * ENHANCEMENT (Issue #549): GitHub API integration for collection submission
   */
  private async createCollectionIssue(params: {
    elementName: string;
    elementType: ElementType;
    portfolioUrl: string;
    username: string;
    metadata: PortfolioElementMetadata;
    token: string;
  }): Promise<string | null> {
    try {

      // Format the issue title
      const title = `[${params.elementType}] Add ${params.elementName} by @${params.username}`;

      // Format the issue body with all relevant information
      const body = `## New ${params.elementType} Submission

` +
        `**Name**: ${params.elementName}\n` +
        `**Author**: @${params.username}\n` +
        `**Type**: ${params.elementType}\n` +
        `**Description**: ${params.metadata.description || 'No description provided'}\n\n` +
        `### Portfolio Link\n` +
        `${params.portfolioUrl}\n\n` +
        `### Metadata\n` +
        `\`\`\`json\n${JSON.stringify(params.metadata, null, 2)}\n\`\`\`\n\n` +
        `### Review Checklist\n` +
        `- [ ] Content is appropriate and follows community guidelines\n` +
        `- [ ] No security vulnerabilities or malicious patterns\n` +
        `- [ ] Metadata is complete and accurate\n` +
        `- [ ] Element works as described\n` +
        `- [ ] No duplicate of existing collection content\n\n` +
        `---\n` +
        `*This submission was created automatically via the DollhouseMCP submit_content tool.*`;

      // Determine labels based on element type
      const labels = [
        'contribution',  // All submissions get this
        'pending-review', // Needs review
        params.elementType.toLowerCase() // Element type label
      ];

      // PERFORMANCE OPTIMIZATION (Task #6): Use GitHub rate limiter for API calls
      // This prevents hitting GitHub rate limits and provides better error handling
      const issueUrl = await githubRateLimiter.queueRequest(
        'create-collection-issue',
        async () => {
          const url = 'https://api.github.com/repos/DollhouseMCP/collection/issues';
          
          // Create AbortController for timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), getValidatedTimeout());
          
          try {
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `Bearer ${params.token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'DollhouseMCP/1.0'
              },
              body: JSON.stringify({
                title,
                body,
                labels
              }),
              signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            // PERFORMANCE OPTIMIZATION (Task #15): Enhanced rate limit logging
            // Log rate limit headers for diagnostics
            const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
            const rateLimitReset = response.headers.get('X-RateLimit-Reset');
            const rateLimitLimit = response.headers.get('X-RateLimit-Limit');
            
            logger.debug('GitHub API rate limit status', {
              operation: 'create-collection-issue',
              remaining: rateLimitRemaining,
              limit: rateLimitLimit,
              resetTime: rateLimitReset ? new Date(parseInt(rateLimitReset) * 1000) : undefined,
              responseStatus: response.status
            });
            
            // Log warning if approaching rate limit
            if (rateLimitRemaining && parseInt(rateLimitRemaining) < 100) {
              logger.warn('Approaching GitHub API rate limit', {
                operation: 'create-collection-issue',
                remaining: rateLimitRemaining,
                resetTime: rateLimitReset ? new Date(parseInt(rateLimitReset) * 1000) : undefined,
                recommendation: 'Consider reducing API usage frequency or authenticating for higher limits'
              });
            }

            if (!response.ok) {
              const errorText = await response.text();
              logger.error('GitHub API error creating issue', { 
                status: response.status, 
                statusText: response.statusText,
                error: errorText,
                rateLimitRemaining,
                rateLimitReset
              });
              
              if (response.status === 404) {
                logger.error('Collection repository not found or no access');
              } else if (response.status === 403) {
                logger.error('Permission denied to create issue in collection repo');
              } else if (response.status === 401) {
                logger.error('Authentication failed for collection submission');
              }
              throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            return data.html_url;
            
          } catch (fetchError: any) {
            // Re-throw to outer catch block
            throw fetchError;
          } finally {
            clearTimeout(timeoutId);
          }
        },
        'high' // High priority for collection submission
      );
      
      return issueUrl;

    } catch (error: any) {
      // Handle timeout specifically
      if (error.name === 'AbortError') {
        logger.error(`GitHub API request timeout after ${getValidatedTimeout()}ms`);
      } else {
        logger.error('Failed to create collection issue', { 
          error: error.message || error
        });
      }
      return null;
    }
  }

  private async findLocalContent(name: string, type: ElementType): Promise<string | null> {
    try {
      // METADATA INDEX FIX: Use portfolio index for fast metadata-based lookups
      // This solves the critical issue where "Safe Roundtrip Tester" couldn't be found
      // because findLocalContent only searched filenames, not metadata names
      const indexManager = PortfolioIndexManager.getInstance();
      
      // UX IMPROVEMENT: Enhanced search with fuzzy matching
      const indexEntry = await indexManager.findByName(name, { 
        elementType: type,
        fuzzyMatch: true
      });
      
      if (indexEntry) {
        logger.debug('Found content via metadata index', { 
          searchName: name, 
          metadataName: indexEntry.metadata.name,
          filename: indexEntry.filename,
          filePath: indexEntry.filePath,
          type 
        });
        return indexEntry.filePath;
      }
      
      // FALLBACK: Use original file discovery if index lookup fails
      // This maintains backward compatibility and handles edge cases
      logger.debug('Index lookup failed, falling back to file discovery', { name, type });
      
      const portfolioManager = PortfolioManager.getInstance();
      const portfolioDir = portfolioManager.getElementDir(type);
      
      // UX IMPROVEMENT: Try multiple search strategies for better user experience
      let file = await FileDiscoveryUtil.findFile(portfolioDir, name, {
        extensions: ['.md', '.json', '.yaml', '.yml'],
        partialMatch: true,
        cacheResults: true
      });
      
      // If not found, try normalizing the name (e.g., "J.A.R.V.I.S." -> "j-a-r-v-i-s")
      if (!file) {
        const normalizedName = name.toLowerCase()
          .replace(/[^a-z0-9]/gi, '-')  // Replace non-alphanumeric with dashes
          .replace(/-+/g, '-')         // Replace multiple dashes with single dash
          .replace(/^-|-$/g, '');      // Remove leading/trailing dashes
          
        if (normalizedName !== name.toLowerCase()) {
          logger.debug('Trying normalized name search', { 
            original: name, 
            normalized: normalizedName,
            type 
          });
          
          file = await FileDiscoveryUtil.findFile(portfolioDir, normalizedName, {
            extensions: ['.md', '.json', '.yaml', '.yml'],
            partialMatch: true,
            cacheResults: true
          });
        }
      }
      
      // If still not found, try searching by display name patterns
      if (!file) {
        // Try common variations like removing dots, spaces, etc.
        const variations = [
          name.replace(/\./g, ''),        // Remove dots: "J.A.R.V.I.S." -> "JARVIS"
          name.replace(/\s+/g, '-'),      // Replace spaces with dashes
          name.replace(/[\s\.]/g, ''),    // Remove spaces and dots
          name.replace(/[\s\.]/g, '-'),   // Replace spaces and dots with dashes
        ].filter(v => v !== name && v.length > 0);
        
        for (const variation of variations) {
          file = await FileDiscoveryUtil.findFile(portfolioDir, variation, {
            extensions: ['.md', '.json', '.yaml', '.yml'],
            partialMatch: true,
            cacheResults: true
          });
          
          if (file) {
            logger.debug('Found content using name variation', {
              original: name,
              variation,
              file,
              type
            });
            break;
          }
        }
      }
      
      if (file) {
        logger.debug('Found local content file via fallback', { name, type, file });
        return file;
      }
      
      logger.debug('No content found', { name, type });
      return null;
      
    } catch (error) {
      logger.error('Error finding local content', {
        name,
        type,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Smart element type detection - searches across ALL element types for content
   * PERFORMANCE OPTIMIZATION (Task #9): Uses early termination for exact matches
   * This replaces the previous hardcoded default to PERSONA and enables proper type detection
   * 
   * @param name The content name to search for
   * @returns Detection result with found matches across all element types
   */
  private async detectElementType(name: string): Promise<ElementDetectionResult> {
    try {
      // PERFORMANCE OPTIMIZATION (Task #9): Use early termination search utility
      // Create search functions for each element type
      const elementTypes = Object.values(ElementType);
      const searchFunctions = elementTypes.map((type) => async () => {
        try {
          const filePath = await this.findLocalContent(name, type);
          if (filePath) {
            return { type: type as ElementType, path: filePath };
          }
          return null;
        } catch (error: any) {
          // Log unexpected errors but don't fail the search
          if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
            logger.debug(`Error searching ${type} directory for content detection`, { 
              name,
              type,
              error: error?.message || String(error),
              code: error?.code 
            });
          }
          // Return null instead of throwing to let other searches continue
          return null;
        }
      });

      // PERFORMANCE OPTIMIZATION (Task #9): Define exact match criteria
      const isExactMatch = (match: ElementDetectionMatch): boolean => {
        const filename = path.basename(match.path, path.extname(match.path));
        return filename.toLowerCase() === name.toLowerCase();
      };

      // Execute searches with early termination optimization
      const searchResults = await EarlyTerminationSearch.executeWithEarlyTermination(
        searchFunctions,
        isExactMatch,
        {
          operationName: 'element-type-detection',
          timeoutAfterExactMatch: 1000, // Wait 1 second for other searches after exact match
          maxParallelSearches: 8 // Limit concurrent searches to avoid overwhelming the system
        }
      );

      // PERFORMANCE OPTIMIZATION (Task #8): Enhanced batch operation reporting
      const batchResults = {
        name,
        totalSearches: searchResults.totalSearches,
        completedSearches: searchResults.completedSearches,
        matches: searchResults.matches.length,
        failures: searchResults.failures.length,
        exactMatchFound: !!searchResults.exactMatch,
        exactMatchType: searchResults.exactMatch?.type,
        earlyTerminationTriggered: searchResults.earlyTerminationTriggered,
        performanceGain: searchResults.performanceGain,
        matchedTypes: searchResults.matches.map(m => m.type),
        failedTypes: searchResults.failures.map(f => elementTypes[f.index]).filter(Boolean)
      };

      logger.debug('Element type detection completed with early termination optimization', batchResults);

      // PERFORMANCE OPTIMIZATION (Task #8): Clear reporting of partial failures
      if (searchResults.failures.length > 0) {
        logger.warn('Some element type searches failed during batch operation', {
          name,
          failures: searchResults.failures.map(f => ({
            type: elementTypes[f.index] || 'unknown',
            error: f.error.substring(0, 100) // Truncate long error messages
          })),
          successRate: `${searchResults.completedSearches}/${searchResults.totalSearches}`,
          impactOnResults: searchResults.matches.length > 0 
            ? 'No impact - matches found in successful searches' 
            : 'Potential impact - no matches found'
        });

        // If we have failures and no matches, provide actionable guidance
        if (searchResults.matches.length === 0 && searchResults.failures.length > 0) {
          logger.warn('Batch operation had failures and no matches found', {
            name,
            recommendation: 'Consider checking file permissions or portfolio structure',
            failureCount: searchResults.failures.length,
            totalSearches: searchResults.totalSearches
          });
        }
      }

      // Log performance gains from early termination
      if (searchResults.earlyTerminationTriggered) {
        logger.info('Early termination optimization applied successfully', {
          name,
          exactMatchType: searchResults.exactMatch?.type,
          performanceGain: searchResults.performanceGain,
          searchesCompleted: searchResults.completedSearches,
          searchesTotal: searchResults.totalSearches
        });
      }

      return {
        found: searchResults.matches.length > 0,
        matches: searchResults.matches
      };

    } catch (error) {
      logger.error('Error in element type detection', {
        name,
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Return empty result on detection failure
      return {
        found: false,
        matches: []
      };
    }
  }

  /**
   * UX IMPROVEMENT: Generate name suggestions for similar content
   * PERFORMANCE OPTIMIZATION (Task #8): Enhanced batch operation handling with clear partial failure reporting
   * Helps users find content when exact matches fail
   */
  private async generateNameSuggestions(searchName: string): Promise<Array<{name: string, type: string}>> {
    try {
      const suggestions: Array<{name: string, type: string}> = [];
      const searchLower = searchName.toLowerCase();
      const elementTypes = Object.values(ElementType);
      
      // Track batch operation results for better diagnostics
      const batchResults = {
        searchName,
        totalTypes: elementTypes.length,
        successfulScans: 0,
        failedScans: 0,
        failureDetails: [] as Array<{ type: ElementType; error: string }>,
        totalSuggestions: 0,
        suggestionsByType: {} as Record<string, number>
      };
      
      // Process all element types for suggestions
      for (const elementType of elementTypes) {
        try {
          const portfolioManager = PortfolioManager.getInstance();
          const elementDir = portfolioManager.getElementDir(elementType);
          
          // Get files in this directory
          const files = await FileDiscoveryUtil.findFile(elementDir, '*', {
            extensions: ['.md', '.json', '.yaml', '.yml'],
            partialMatch: false,
            cacheResults: true
          });
          
          let typeSuggestions = 0;
          
          if (Array.isArray(files)) {
            for (const filePath of files) {
              const basename = path.basename(filePath, path.extname(filePath));
              
              // Calculate similarity using simple metrics
              if (this.calculateSimilarity(searchLower, basename.toLowerCase()) > SEARCH_CONFIG.MIN_SIMILARITY_SCORE) {
                suggestions.push({
                  name: basename,
                  type: elementType
                });
                typeSuggestions++;
              }
            }
          } else if (files) {
            const basename = path.basename(files, path.extname(files));
            if (this.calculateSimilarity(searchLower, basename.toLowerCase()) > SEARCH_CONFIG.MIN_SIMILARITY_SCORE) {
              suggestions.push({
                name: basename,
                type: elementType
              });
              typeSuggestions++;
            }
          }
          
          batchResults.successfulScans++;
          batchResults.suggestionsByType[elementType] = typeSuggestions;
          
        } catch (error) {
          // PERFORMANCE OPTIMIZATION (Task #8): Track and report partial failures
          batchResults.failedScans++;
          batchResults.failureDetails.push({
            type: elementType,
            error: error instanceof Error ? error.message : String(error)
          });
          
          // Log individual failures for diagnostics
          logger.debug('Failed to scan element type for suggestions', {
            elementType,
            searchName,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      
      batchResults.totalSuggestions = suggestions.length;
      
      // PERFORMANCE OPTIMIZATION (Task #8): Comprehensive batch operation reporting
      logger.debug('Name suggestion batch operation completed', {
        ...batchResults,
        successRate: `${batchResults.successfulScans}/${batchResults.totalTypes}`,
        // Don't log full failure details at debug level to avoid spam
        hasFailures: batchResults.failedScans > 0
      });
      
      // Report failures clearly if they occurred
      if (batchResults.failedScans > 0) {
        logger.warn('Some element type scans failed during name suggestion generation', {
          searchName,
          failedTypes: batchResults.failureDetails.map(f => f.type),
          successfulTypes: batchResults.successfulScans,
          impactOnResults: batchResults.totalSuggestions > 0 
            ? 'Partial impact - suggestions found from successful scans' 
            : 'Potential impact - no suggestions generated',
          recommendation: batchResults.totalSuggestions === 0 && batchResults.failedScans > 0
            ? 'Check portfolio directory structure and file permissions'
            : 'Suggestion generation partially successful despite some failures'
        });
      }
      
      // Sort by similarity (higher is better) and return top suggestions
      const sortedSuggestions = suggestions.sort((a, b) => {
        const simA = this.calculateSimilarity(searchLower, a.name.toLowerCase());
        const simB = this.calculateSimilarity(searchLower, b.name.toLowerCase());
        return simB - simA;
      });
      
      logger.debug('Name suggestions generated successfully', {
        searchName,
        totalSuggestions: sortedSuggestions.length,
        topSuggestions: sortedSuggestions.slice(0, 3).map(s => s.name)
      });
      
      return sortedSuggestions;
      
    } catch (error) {
      logger.warn('Failed to generate name suggestions - batch operation failed completely', { 
        searchName, 
        error: error instanceof Error ? error.message : String(error),
        recommendation: 'Check portfolio structure and permissions'
      });
      return [];
    }
  }
  
  /**
   * Simple similarity calculation using Levenshtein-like approach
   * Returns value between 0 and 1, where 1 is identical
   */
  private calculateSimilarity(str1: string, str2: string): number {
    // Handle exact matches
    if (str1 === str2) return 1;
    
    // Handle substring matches
    if (str1.includes(str2) || str2.includes(str1)) return 0.8;
    
    // Handle partial matches
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 0;
    
    // Count common characters
    let common = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (longer.includes(shorter[i])) {
        common++;
      }
    }
    
    return common / longer.length;
  }
  
  /**
   * UX IMPROVEMENT: Save element with automatic retry logic for transient failures
   * Handles common GitHub API issues like rate limits and temporary network problems
   */
  private async saveElementWithRetry(
    adapter: PortfolioElementAdapter, 
    elementName: string, 
    elementType: ElementType,
    maxRetries: number = RETRY_CONFIG.MAX_ATTEMPTS
  ): Promise<string | null> {
    let lastError: any = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.debug(`Attempting to save element (attempt ${attempt}/${maxRetries})`, {
          elementName,
          elementType,
          attempt
        });
        
        const fileUrl = await this.portfolioManager.saveElement(adapter, true);
        
        if (fileUrl) {
          if (attempt > 1) {
            logger.info(`Element saved successfully after ${attempt} attempts`, {
              elementName,
              elementType,
              fileUrl
            });
          }
          return fileUrl;
        }
        
        // If saveElement returns null, treat as a failure but don't retry immediately
        lastError = new Error(`saveElement returned null on attempt ${attempt}`);
        
      } catch (error: any) {
        lastError = error;
        const isRetryable = this.isRetryableError(error);
        
        logger.warn(`Save attempt ${attempt} failed`, {
          elementName,
          elementType,
          attempt,
          error: error.message,
          isRetryable,
          willRetry: isRetryable && attempt < maxRetries
        });
        
        // If this is not a retryable error, fail immediately
        if (!isRetryable) {
          logger.error('Non-retryable error encountered, aborting retries', {
            elementName,
            error: error.message
          });
          break;
        }
        
        // If we have more attempts, wait before retrying
        if (attempt < maxRetries) {
          const delay = calculateRetryDelay(attempt);
          logger.debug(`Waiting ${delay}ms before retry`, { attempt, delay });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    // All attempts failed
    logger.error(`All ${maxRetries} save attempts failed`, {
      elementName,
      elementType,
      lastError: lastError?.message
    });
    
    return null;
  }
  
  /**
   * Determine if an error is worth retrying
   * Retryable: network issues, rate limits, temporary GitHub API problems
   * Non-retryable: authentication issues, validation errors, permanent failures
   */
  private isRetryableError(error: any): boolean {
    const errorMessage = error?.message?.toLowerCase() || '';
    const errorCode = error?.code;
    const statusCode = error?.status || error?.statusCode;
    
    // Network and timeout errors
    if (errorCode === 'ENOTFOUND' || errorCode === 'ECONNRESET' || errorCode === 'ETIMEDOUT') {
      return true;
    }
    
    // GitHub API rate limits
    if (statusCode === 429 || errorMessage.includes('rate limit')) {
      return true;
    }
    
    // Temporary GitHub API issues
    if (statusCode >= 500 && statusCode < 600) {
      return true;
    }
    
    // Temporary GitHub API problems
    if (errorMessage.includes('temporarily unavailable') || 
        errorMessage.includes('service unavailable') ||
        errorMessage.includes('internal server error')) {
      return true;
    }
    
    // Connection issues
    if (errorMessage.includes('connection') && 
        (errorMessage.includes('timeout') || errorMessage.includes('reset'))) {
      return true;
    }
    
    // Don't retry authentication or permission issues
    if (statusCode === 401 || statusCode === 403 || 
        errorMessage.includes('unauthorized') || 
        errorMessage.includes('forbidden') ||
        errorMessage.includes('authentication')) {
      return false;
    }
    
    // Don't retry validation errors
    if (statusCode === 400 || statusCode === 422 ||
        errorMessage.includes('invalid') ||
        errorMessage.includes('validation')) {
      return false;
    }
    
    // Default to not retrying for unknown errors to avoid infinite loops
    return false;
  }
}