/**
 * Tool for submitting content to GitHub portfolio repositories
 * Replaces the broken issue-based submission with direct repository saves
 * 
 * FIXES IMPLEMENTED (PR #503):
 * 1. TYPE SAFETY FIX #1 (Issue #497): Changed apiCache from 'any' to proper APICache type
 * 2. TYPE SAFETY FIX #2 (Issue #497): Replaced complex type casting with PortfolioElementAdapter
 * 3. PERFORMANCE (PR #496 recommendation): Using FileDiscoveryUtil for optimized file search
 */

import { createHash } from 'node:crypto';
import { GitHubAuthManager } from '../../auth/GitHubAuthManager.js';
import { PortfolioRepoManager } from '../../portfolio/PortfolioRepoManager.js';
import { TokenManager } from '../../security/tokenManager.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { PortfolioManager, getElementFileExtension } from '../../portfolio/PortfolioManager.js';
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
import { SubmitToPortfolioParams, SubmitToPortfolioResult } from './types.js';

// Re-export types for backward compatibility
export type { PortfolioElement, SubmitToPortfolioParams, SubmitToPortfolioResult } from './types.js';
import { IRateLimiter } from '../../utils/GitHubRateLimiter.js';
import { EarlyTerminationSearch } from '../../utils/EarlyTerminationSearch.js';
import { CollectionErrorCode, formatCollectionError } from '../../config/error-codes.js';
import * as path from 'node:path';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import { IFileOperationsService, isAbsentKindError } from '../../services/FileOperationsService.js';
import { PACKAGE_VERSION } from '../../generated/version.js';
import { TenantMemoryOperationProvider, type BoundMemoryOperation } from '../../storage/TenantMemoryOperationProvider.js';
import type { DatabaseTenantMemoryRegistry } from '../../storage/DatabaseTenantMemoryRegistry.js';

// PortfolioElement, SubmitToPortfolioParams, and SubmitToPortfolioResult
// are imported from ./types.ts and re-exported above

export interface ElementDetectionMatch {
  type: ElementType;
  path: string;
}

/** Metadata fields rendered into a collection issue when present. */
interface ExtendedMeta extends PortfolioElementMetadata {
  category?: string;
  triggers?: string[];
  age_rating?: string;
  ai_generated?: boolean;
  generation_method?: string;
  license?: string;
  tags?: string[];
}

interface CollectionIssueParams {
  elementName: string;
  elementType: ElementType;
  portfolioUrl: string;
  username: string;
  metadata: PortfolioElementMetadata;
  token: string;
  localPath?: string;  // Path to the local element file
}

/** Patterns that could indicate path traversal or injection in a submitted file path. */
const SUSPICIOUS_PATH_PATTERNS: readonly RegExp[] = [
  /\.\./,                    // Path traversal
  /\/\.\./,                  // Unix path traversal
  /\\\.\./,                  // Windows path traversal
  // eslint-disable-next-line no-control-regex -- Intentionally detecting null bytes for security
  /\u0000/,                    // NOSONAR - Null bytes detection for security
  // eslint-disable-next-line no-control-regex -- Intentionally detecting control chars for security
  /[\u0001-\u001f\u007f-\u009f]/,    // NOSONAR - Control characters detection for security
  /[<>:"|?*]/,               // Invalid filename characters on Windows
  /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i, // Reserved Windows names
  /^\./,                     // Hidden files (starting with dot)
  /\s$/,                     // Trailing whitespace
  /^\s*$/,                   // Only whitespace
  /%[0-9a-fA-F]{2}/,         // URL encoding (potential bypass attempt)
  /\\x[0-9a-fA-F]{2}/,       // Hex encoding
  /\$\{.*\}/,                // Template literal injection
  /`.*`/,                    // Backtick injection
  /[\\/]{2,}/                // Multiple consecutive slashes
];
const ALLOWED_PORTFOLIO_EXTENSIONS = ['.md', '.markdown', '.txt', '.yml', '.yaml', '.json'];
const SAFE_FILENAME_PATTERN = /^[a-zA-Z0-9\-_.\s()[\]{}]+$/;

const COLLECTION_ISSUE_STATUS_DETAIL: Record<number, string> = {
  404: 'Collection repository not found or no access',
  403: 'Permission denied to create issue in collection repo',
  401: 'Authentication failed for collection submission',
};

function collectionIssueDetails(meta: ExtendedMeta): string[] {
  const details: string[] = [];
  if (meta.category) details.push(`**Category**: ${meta.category}`);
  if (meta.version) details.push(`**Version**: ${meta.version}`);
  if (Array.isArray(meta.triggers) && meta.triggers.length > 0) details.push(`**Triggers**: ${meta.triggers.join(', ')}`);
  if (meta.age_rating) details.push(`**Age Rating**: ${meta.age_rating}`);
  if (meta.ai_generated !== undefined) details.push(`**AI Generated**: ${meta.ai_generated ? 'Yes' : 'No'}`);
  if (meta.generation_method) details.push(`**Generation Method**: ${meta.generation_method}`);
  if (meta.license) details.push(`**License**: ${meta.license}`);
  if (Array.isArray(meta.tags) && meta.tags.length > 0) details.push(`**Tags**: ${meta.tags.join(', ')}`);
  return details;
}

export interface ElementDetectionResult {
  found: boolean;
  matches: ElementDetectionMatch[];
}

export interface SubmitToPortfolioToolDependencies {
  authManager: GitHubAuthManager;
  portfolioRepoManager: PortfolioRepoManager;
  portfolioManager: PortfolioManager;
  portfolioIndexManager?: PortfolioIndexManager;
  memoryRegistry?: DatabaseTenantMemoryRegistry;
  rateLimiter: IRateLimiter;
  fileOperations: IFileOperationsService;
  tokenManager: TokenManager;
  isAutoSubmitEnabled?: () => boolean;
}

export class SubmitToPortfolioTool {
  private memoryOperation?: { readonly provider: TenantMemoryOperationProvider; readonly operation: BoundMemoryOperation };

  bindMemoryOperation(provider: TenantMemoryOperationProvider, operation: BoundMemoryOperation,
    portfolioIndexManager: PortfolioIndexManager): SubmitToPortfolioTool {
    if (!(provider instanceof TenantMemoryOperationProvider)) throw new TypeError('Actual memory provider required');
    if (this.memoryRegistry) provider.assertRegistry(this.memoryRegistry);
    provider.assertOperation(operation);
    const bound = new SubmitToPortfolioTool(this.apiCache, { authManager: this.authManager,
      portfolioRepoManager: this.portfolioRepoManager, portfolioManager: this.portfolioManager,
      portfolioIndexManager, memoryRegistry: this.memoryRegistry, rateLimiter: this.rateLimiter,
      fileOperations: this.fileOperations, tokenManager: this.tokenManager,
      isAutoSubmitEnabled: () => this.isAutoSubmitEnabled() });
    bound.memoryOperation = Object.freeze({ provider, operation });
    return bound;
  }

  private originalBindingFailure?: { readonly cause: unknown };
  private assertMemoryOperation(): void {
    if (this.originalBindingFailure) throw this.originalBindingFailure.cause;
    if (!this.memoryOperation) return;
    try { this.memoryOperation.provider.assertOperation(this.memoryOperation.operation); }
    catch (cause) { this.originalBindingFailure = { cause }; throw cause; }
  }

  private assertSubmissionType(type: ElementType): void {
    this.assertMemoryOperation();
    if (!this.memoryOperation) return;
    if (!Object.values(ElementType).includes(type)) throw new Error('Unknown portfolio submission type');
    if (type === ElementType.MEMORY && this.memoryOperation.operation.manager.isGuardedHeadUpdateEnabled()) {
      throw new Error('Guarded database memory remote submission requires a local file and is unsupported; get_element_details or read-only console inspection does not provide an equivalent submission or backup');
    }
  }

  private readonly authManager: GitHubAuthManager;
  private readonly portfolioRepoManager: PortfolioRepoManager;
  private readonly portfolioManager: PortfolioManager;
  private readonly fixedIndex?: PortfolioIndexManager;
  private readonly memoryRegistry?: DatabaseTenantMemoryRegistry;
  private get portfolioIndexManager(): PortfolioIndexManager {
    this.assertMemoryOperation();
    if (!this.fixedIndex) throw new Error('Authentic selected portfolio index required');
    return this.fixedIndex;
  }
  private readonly rateLimiter: IRateLimiter;
  private readonly fileOperations: IFileOperationsService;
  private readonly tokenManager: TokenManager;
  private isAutoSubmitEnabled: () => boolean;

  constructor(private readonly apiCache: APICache, dependencies: SubmitToPortfolioToolDependencies) {
    // TYPE SAFETY FIX #1: Proper typing for apiCache parameter
    // Previously: constructor(apiCache: any)
    // Now: constructor(apiCache: APICache) with proper import
    if (!dependencies?.authManager) {
      throw new Error('SubmitToPortfolioTool requires a GitHubAuthManager instance');
    }
    if (!dependencies.portfolioManager) {
      throw new Error('SubmitToPortfolioTool requires a PortfolioManager instance');
    }
    if (!dependencies.portfolioIndexManager && !dependencies.memoryRegistry) {
      throw new Error('SubmitToPortfolioTool requires a PortfolioIndexManager instance');
    }
    if (!dependencies.rateLimiter) {
      throw new Error('SubmitToPortfolioTool requires an IRateLimiter instance');
    }

    this.authManager = dependencies.authManager;
    this.portfolioRepoManager = dependencies.portfolioRepoManager;
    this.portfolioManager = dependencies.portfolioManager;
    this.fixedIndex = dependencies.portfolioIndexManager;
    this.memoryRegistry = dependencies.memoryRegistry;
    this.rateLimiter = dependencies.rateLimiter;
    this.fileOperations = dependencies.fileOperations;
    this.tokenManager = dependencies.tokenManager;
    this.isAutoSubmitEnabled = dependencies.isAutoSubmitEnabled
      ?? (() => process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION === 'true');
  }

  /** Wire the auto-submit check after CollectionHandler is constructed. */
  setAutoSubmitCheck(check: () => boolean): void {
    this.isAutoSubmitEnabled = check;
  }

  /**
   * Validates and normalizes input parameters to prevent Unicode attacks and ensure data safety
   * @param params The input parameters from the user
   * @returns Validation result with normalized name or error response
   */
  private validateAndNormalizeParams(params: SubmitToPortfolioParams): {
    success: boolean;
    safeName?: string;
    error?: SubmitToPortfolioResult;
  } {
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
    this.assertMemoryOperation();
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
    const displayName = originalName || safeName;
    if (explicitType) {
      // Type explicitly provided - search in that specific directory only
      const localPath = await this.findLocalContent(safeName, explicitType);
      if (localPath) return { success: true, elementType: explicitType, localPath };
      return { success: false, error: this.typedNotFound(explicitType, displayName) };
    }
    // CRITICAL FIX: No type provided - implement smart detection across ALL element types
    // This prevents the previous hardcoded default to PERSONA and enables proper type detection
    const detectionResult = await this.detectElementType(safeName);
    this.assertMemoryOperation();
    if (!detectionResult.found) {
      // UX IMPROVEMENT: Enhanced guidance with specific suggestions
      const suggestions = await this.generateNameSuggestions(safeName);
      this.assertMemoryOperation();
      return { success: false, error: this.untypedNotFound(displayName, suggestions) };
    }
    if (detectionResult.matches.length > 1) {
      // Multiple matches found - ask user to specify type
      const matchDetails = detectionResult.matches.map(m => `- ${m.type}: ${m.path}`).join('\n');
      return {
        success: false,
        error: {
          success: false,
          message: `Content "${displayName}" found in multiple element types:\n\n${matchDetails}\n\n` +
                  `Please specify the element type using the --type parameter to avoid ambiguity.`,
          error: 'MULTIPLE_MATCHES_FOUND'
        }
      };
    }
    const match = detectionResult.matches[0];
    logger.info(`Smart detection: Found "${safeName}" as ${match.type}`, { name: safeName, detectedType: match.type, path: match.path });
    return { success: true, elementType: match.type, localPath: match.path };
  }

  /** UX IMPROVEMENT: Provide helpful suggestions for finding content of one type. */
  private typedNotFound(elementType: ElementType, displayName: string): SubmitToPortfolioResult {
    const elementDir = this.portfolioManager.getElementDir(elementType);
    return {
      success: false,
      message: `Could not find ${elementType} named "${displayName}" in local portfolio.\n\n` +
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
    };
  }

  private untypedNotFound(displayName: string, suggestions: Array<{ name: string; type: string }>): SubmitToPortfolioResult {
    const availableTypes = Object.values(ElementType).join(', ');
    let message = `Content "${displayName}" not found in portfolio.\n\n`;
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
    message += `   • "${displayName.toLowerCase()}" (lowercase)\n`;
    message += `   • "${displayName.replaceAll(/[^a-z0-9]/gi, '-').toLowerCase()}" (normalized)\n`;
    if (displayName.includes('.')) {
      message += `   • "${displayName.replaceAll('.', '')}" (no dots)\n`;
    }
    message += `3. 🎯 Specify element type: \`submit_collection_content "${displayName}" --type=personas\`\n`;
    message += `4. 📁 Check if file exists in portfolio directories\n\n`;
    message += `📝 **Tip**: The system searches filenames AND metadata names with fuzzy matching.`;
    return { success: false, message, error: 'CONTENT_NOT_FOUND' };
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
    const pathValidation = this.validatePortfolioPath(localPath);
    this.assertMemoryOperation();
    if (!pathValidation.isValid) {
      return {
        success: false,
        error: pathValidation.error
      };
    }

    // Use the validated safe path for all subsequent operations
    const safePath = pathValidation.safePath!;

    // Validate file size before reading
    const stats = await this.fileOperations.stat(safePath);
    this.assertMemoryOperation();
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
    const content = await this.fileOperations.readFile(safePath, { source: 'SubmitToPortfolioTool.validateFileAndContent' });
    this.assertMemoryOperation();
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
  private async prepareElementMetadata(
    safeName: string,
    elementType: ElementType,
    authStatus: any,
    filePath?: string
  ): Promise<PortfolioElementMetadata> {
    // Try to extract metadata from the file if path is provided
    const fileMetadata: Record<string, any> | null = filePath ? await this.extractElementMetadata(filePath) : null;

    // Build metadata with real values from file, falling back to defaults
    const metadata: ExtendedMeta = {
      name: safeName,
      description: fileMetadata?.description ||
                   fileMetadata?.summary ||
                   `${elementType} submitted from local portfolio`,
      author: authStatus.username || fileMetadata?.author || 'unknown',
      created: fileMetadata?.created ||
               fileMetadata?.created_date ||
               new Date().toISOString(),
      updated: fileMetadata?.updated ||
               fileMetadata?.modified ||
               new Date().toISOString(),
      version: fileMetadata?.version || '1.0.0'
    };

    // Preserve other metadata fields that might be useful (with type safety)
    // The field order is part of the serialized form the portfolio duplicate check hashes.
    if (fileMetadata) {
      const stringField = (field: 'category' | 'age_rating' | 'generation_method' | 'license') => {
        if (fileMetadata[field] && typeof fileMetadata[field] === 'string') metadata[field] = fileMetadata[field];
      };
      if (Array.isArray(fileMetadata.triggers)) metadata.triggers = fileMetadata.triggers;
      stringField('category');
      stringField('age_rating');
      if (fileMetadata.ai_generated !== undefined) metadata.ai_generated = Boolean(fileMetadata.ai_generated);
      stringField('generation_method');
      stringField('license');
      if (Array.isArray(fileMetadata.tags)) metadata.tags = fileMetadata.tags;
    }

    logger.info('Prepared element metadata', {
      elementName: safeName,
      hasFileMetadata: !!fileMetadata,
      description: metadata.description.substring(0, 100) // Log first 100 chars
    });
    return metadata;
  }

  /**
   * Formats metadata as YAML string for display
   * PERFORMANCE: Uses array join instead of string concatenation for better performance
   */
  private formatMetadataAsYaml(baseMetadata: PortfolioElementMetadata, extendedMeta: any): string {
    const yamlLines: string[] = [
      `name: ${baseMetadata.name}`,
      `description: ${baseMetadata.description}`,
      `author: ${baseMetadata.author}`,
      `version: ${baseMetadata.version}`,
      `created: ${baseMetadata.created}`,
      `updated: ${baseMetadata.updated}`
    ];
    
    // Add optional fields if present
    if (extendedMeta.category) {
      yamlLines.push(`category: ${extendedMeta.category}`);
    }
    if (extendedMeta.triggers && Array.isArray(extendedMeta.triggers) && extendedMeta.triggers.length > 0) {
      yamlLines.push(`triggers: [${extendedMeta.triggers.join(', ')}]`);
    }
    if (extendedMeta.age_rating) {
      yamlLines.push(`age_rating: ${extendedMeta.age_rating}`);
    }
    if (extendedMeta.ai_generated !== undefined) {
      yamlLines.push(`ai_generated: ${extendedMeta.ai_generated}`);
    }
    if (extendedMeta.generation_method) {
      yamlLines.push(`generation_method: ${extendedMeta.generation_method}`);
    }
    if (extendedMeta.license) {
      yamlLines.push(`license: ${extendedMeta.license}`);
    }
    if (extendedMeta.tags && Array.isArray(extendedMeta.tags) && extendedMeta.tags.length > 0) {
      yamlLines.push(`tags: [${extendedMeta.tags.join(', ')}]`);
    }
    
    return yamlLines.join('\n');
  }
  
  /**
   * Extracts metadata from an element file
   * Parses YAML frontmatter to get the actual metadata
   * SECURITY: Uses SecureYamlParser instead of yaml.load to prevent code execution (DMCP-SEC-005)
   * @param filePath Path to the element file
   * @returns Extracted metadata or null if parsing fails
   */
  private async extractElementMetadata(filePath: string): Promise<Record<string, any> | null> {
    try {
      const content = await this.fileOperations.readFile(filePath, { source: 'SubmitToPortfolioTool.extractElementMetadata' });
      this.assertMemoryOperation();
      // SECURITY FIX: Use SecureYamlParser to prevent YAML deserialization attacks
      // Previously would have used: yaml.load(yamlContent) which is vulnerable
      try {
        const parsed = SecureYamlParser.parse(content, {
          maxYamlSize: 64 * 1024,  // 64KB limit for YAML
          validateContent: false,    // Don't validate content field (just metadata)
          validateFields: false      // Don't enforce persona-specific rules
        });
        // Ensure we got an object back
        if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
          logger.debug('Extracted metadata from element file', { path: filePath, metadataKeys: Object.keys(parsed.data) });
          return parsed.data;
        }
        logger.debug('Parsed data is not a valid metadata object', { path: filePath });
        return null;
      } catch {
        // SecureYamlParser throws on invalid YAML, try alternate frontmatter pattern
        return this.parseFrontmatterFallback(content, filePath);
      }
    } catch (error) {
      this.assertMemoryOperation();
      logger.warn('Failed to extract metadata from element file', {
        path: filePath,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /** Handle files that have frontmatter without the full document structure. */
  private parseFrontmatterFallback(content: string, filePath: string): Record<string, any> | null {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
    if (frontmatter) {
      try {
        // Reconstruct full document for SecureYamlParser
        const parsed = SecureYamlParser.parse(`---\n${frontmatter}\n---\n`, {
          maxYamlSize: 64 * 1024,
          validateContent: false,
          validateFields: false
        });
        if (parsed.data && typeof parsed.data === 'object') return parsed.data;
      } catch (innerError) {
        logger.debug('Failed to parse frontmatter with SecureYamlParser', {
          path: filePath,
          error: innerError instanceof Error ? innerError.message : String(innerError)
        });
      }
    }
    logger.debug('No valid frontmatter found in element file', { path: filePath });
    return null;
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
      if (!this.tokenManager.validateTokenFormat(token)) {
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
      const requiredScopes = this.tokenManager.getRequiredScopes('collection');
      const validationResult = await this.tokenManager.validateTokenScopes(token, requiredScopes);
      this.assertMemoryOperation();

      if (!validationResult.isValid) {
        SecurityMonitor.logSecurityEvent({
          type: 'TOKEN_VALIDATION_FAILURE',
          severity: 'MEDIUM',
          source: 'SubmitToPortfolioTool.validateTokenBeforeUsage',
          details: `Token validation failed: ${validationResult.error}`
        });

        // Enhanced OAuth-specific error messages
        const tokenType = this.tokenManager.getTokenType(token);
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
            tokenPrefix: this.tokenManager.getTokenPrefix(token),
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
          tokenType: this.tokenManager.getTokenType(token),
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
      this.assertMemoryOperation();
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
  private validatePortfolioPath(filePath: string): {
    isValid: boolean;
    safePath?: string;
    error?: SubmitToPortfolioResult;
  } {
    const refuse = (event: Omit<Parameters<typeof SecurityMonitor.logSecurityEvent>[0], 'source'>, message: string, code: string) => {
      SecurityMonitor.logSecurityEvent({ source: 'SubmitToPortfolioTool.validatePortfolioPath', ...event });
      return { isValid: false, error: { success: false, message, error: code } };
    };
    try {
      // Basic null/undefined check
      if (!filePath || typeof filePath !== 'string') {
        return refuse({ type: 'PATH_TRAVERSAL_ATTEMPT', severity: 'MEDIUM', details: 'Invalid path provided - null, undefined, or non-string' },
          'Invalid file path provided', 'INVALID_PATH');
      }
      // Check for suspicious patterns that could indicate path traversal or injection
      const suspicious = SUSPICIOUS_PATH_PATTERNS.find(pattern => pattern.test(filePath));
      if (suspicious) {
        return refuse({ type: 'PATH_TRAVERSAL_ATTEMPT', severity: 'HIGH',
          details: `Suspicious pattern detected in file path: ${suspicious.source}`,
          metadata: { pathLength: filePath.length, pattern: suspicious.source } },
          'File path contains invalid or suspicious characters', 'SUSPICIOUS_PATH_PATTERN');
      }
      // Check path length (prevent buffer overflow attempts)
      const MAX_PATH_LENGTH = process.platform === 'win32' ? 260 : 4096;
      if (filePath.length > MAX_PATH_LENGTH) {
        return refuse({ type: 'PATH_TRAVERSAL_ATTEMPT', severity: 'MEDIUM',
          details: `File path exceeds maximum length: ${filePath.length} > ${MAX_PATH_LENGTH}` },
          'File path is too long', 'PATH_TOO_LONG');
      }
      // Normalize path to resolve any relative components safely
      let normalizedPath: string;
      try {
        normalizedPath = this.normalizeWithinPortfolio(filePath);
      } catch (error) {
        this.assertMemoryOperation();
        return refuse({ type: 'PATH_TRAVERSAL_ATTEMPT', severity: 'HIGH',
          details: `Path normalization failed: ${error instanceof Error ? error.message : 'unknown error'}` },
          'File path could not be safely processed', 'PATH_NORMALIZATION_FAILED');
      }
      // Validate file extension (only allow safe extensions for portfolio content)
      const fileExtension = path.extname(normalizedPath).toLowerCase();
      if (fileExtension && !ALLOWED_PORTFOLIO_EXTENSIONS.includes(fileExtension)) {
        return refuse({ type: 'CONTENT_INJECTION_ATTEMPT', severity: 'MEDIUM', details: `Disallowed file extension: ${fileExtension}`,
          metadata: { allowedExtensions: ALLOWED_PORTFOLIO_EXTENSIONS.join(', ') } },
          `File extension '${fileExtension}' is not allowed. Allowed extensions: ${ALLOWED_PORTFOLIO_EXTENSIONS.join(', ')}`, 'INVALID_FILE_EXTENSION');
      }
      // Validate filename characters (only allow safe characters)
      const basename = path.basename(normalizedPath);
      if (basename && !SAFE_FILENAME_PATTERN.test(basename)) {
        return refuse({ type: 'CONTENT_INJECTION_ATTEMPT', severity: 'MEDIUM', details: 'Filename contains potentially dangerous characters',
          metadata: { filename: basename, allowedPattern: SAFE_FILENAME_PATTERN.source } },
          'Filename contains invalid characters. Only letters, numbers, spaces, hyphens, underscores, dots, and common brackets are allowed.',
          'INVALID_FILENAME_CHARACTERS');
      }
      // Log successful validation with the event type for path validation
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_VALIDATION_SUCCESS',
        severity: 'LOW',
        source: 'SubmitToPortfolioTool.validatePortfolioPath',
        details: 'File path validation successful',
        metadata: {
          originalPathLength: filePath.length,
          normalizedPathLength: normalizedPath.length,
          fileExtension: fileExtension || 'none'
        }
      });
      return { isValid: true, safePath: normalizedPath };
    } catch (error) {
      this.assertMemoryOperation();
      return refuse({ type: 'PATH_TRAVERSAL_ATTEMPT', severity: 'HIGH',
        details: `Path validation error: ${error instanceof Error ? error.message : 'unknown error'}` },
        'Unable to validate file path. Please check the file path and try again.', 'PATH_VALIDATION_ERROR');
    }
  }

  /** Normalize a path and refuse one that leaves the portfolio directory. */
  private normalizeWithinPortfolio(filePath: string): string {
    if (filePath.includes('\0')) throw new Error('Null bytes are not allowed in a path');
    const normalizedPath = path.normalize(filePath);
    const portfolioBase = path.resolve(this.portfolioManager.getBaseDir());
    if (path.isAbsolute(normalizedPath)) {
      // Native path.relative applies Windows case folding and checks directory boundaries.
      const relative = path.relative(portfolioBase, path.resolve(normalizedPath));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Path is outside portfolio directory');
      }
    } else if (normalizedPath.includes('..')) {
      throw new Error('Path contains directory traversal');
    }
    return normalizedPath;
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
      const token = await this.tokenManager.getGitHubTokenAsync();
      this.assertMemoryOperation();
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
      this.assertMemoryOperation();
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
      // codeql[js/clear-text-logging] — Only tokenType (a descriptive string like "OAuth Access Token") is logged, never the actual token value
      const tokenType = this.tokenManager.getTokenType(token);
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
      this.assertMemoryOperation();
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
    this.assertMemoryOperation();
    if (!tokenManagement.canProceed) {
      return {
        success: false,
        error: tokenManagement.error
      };
    }

    const token = tokenManagement.token!;

    // Provide user guidance if refresh is recommended for this long operation
    if (tokenManagement.refreshRecommended) {
      const tokenType = this.tokenManager.getTokenType(token);
      const guidance = this.formatTokenRefreshGuidance('portfolio creation', tokenType);
      logger.warn(`Token refresh recommended for portfolio creation:${guidance}`);
    }

    this.portfolioRepoManager.setToken(token);

    // Check if portfolio exists and create if needed
    const username = authStatus.username || 'unknown';
    const portfolioExists = await this.portfolioRepoManager.checkPortfolioExists(username);
    this.assertMemoryOperation();
    
    if (!portfolioExists) {
      logger.info('Creating portfolio repository...');
      // Request consent for portfolio creation
      this.assertMemoryOperation();
      const repoUrl = await this.portfolioRepoManager.createPortfolio(username, true);
      this.assertMemoryOperation();
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
   * Check if content already exists in the portfolio repository
   * Prevents duplicate uploads by comparing content hashes
   * @param repoFullName GitHub repository full name (owner/repo)
   * @param filePath Path to the file in the repository
   * @param content Content to check against existing
   * @returns true if identical content exists, false otherwise
   */
  private async checkExistingContent(
    repoFullName: string, 
    filePath: string, 
    content: string,
    token: string
  ): Promise<boolean> {
    try {
      // Attempt to fetch existing file from GitHub
      const url = `https://api.github.com/repos/${repoFullName}/contents/${filePath}`;
      
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'DollhouseMCP/1.0'
        }
      });
      this.assertMemoryOperation();

      if (response.status === 404) {
        // File doesn't exist, not a duplicate
        return false;
      }

      if (!response.ok) {
        logger.warn('Failed to check existing content', {
          status: response.status,
          path: filePath
        });
        // On error, allow upload to proceed
        return false;
      }

      const data = await response.json();
      this.assertMemoryOperation();
      
      // GitHub returns content as base64
      const existingContent = Buffer.from(data.content, 'base64').toString('utf-8');
      
      // Compare content hashes
      const existingHash = createHash('sha256').update(existingContent).digest('hex');
      const newHash = createHash('sha256').update(content).digest('hex');
      
      const isDuplicate = existingHash === newHash;
      
      if (isDuplicate) {
        logger.info('Duplicate content detected, skipping upload', {
          path: filePath,
          hash: newHash.substring(0, 8) // Log partial hash for debugging
        });
      }
      
      return isDuplicate;
      
    } catch (error) {
      this.assertMemoryOperation();
      logger.warn('Error checking for existing content', {
        error: error instanceof Error ? error.message : String(error),
        path: filePath
      });
      // On error, allow upload to proceed rather than blocking
      return false;
    }
  }

  /**
   * Check if an issue for this content already exists in the collection
   * @param elementName Name of the element to check
   * @param username User submitting the element
   * @param token GitHub token for API access
   * @returns URL of existing issue if found, null otherwise
   */
  private async checkExistingIssue(
    elementName: string,
    username: string,
    token: string
  ): Promise<string | null> {
    try {
      // Search for existing issues with this element name
      // Using both title and author to ensure it's the same submission
      const query = `repo:DollhouseMCP/collection is:issue "${elementName}" in:title author:${username}`;
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=created&order=desc`;
      
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'DollhouseMCP/1.0'
        }
      });
      this.assertMemoryOperation();

      if (!response.ok) {
        logger.warn('Failed to search for existing issues', {
          status: response.status
        });
        return null;
      }

      const data = await response.json();
      this.assertMemoryOperation();
      
      if (data.items && data.items.length > 0) {
        // Found existing issue(s)
        const existingIssue = data.items[0];
        logger.info('Found existing collection issue', {
          issueUrl: existingIssue.html_url,
          elementName
        });
        return existingIssue.html_url;
      }
      
      return null;
      
    } catch (error) {
      this.assertMemoryOperation();
      logger.warn('Error checking for existing collection issue', {
        error: error instanceof Error ? error.message : String(error),
        elementName
      });
      // On error, allow submission to proceed
      return null;
    }
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
    authStatus: any,
    localPath?: string  // Local file path for collection submission
  ): Promise<SubmitToPortfolioResult> {
    const published = await this.publishToPortfolio(safeName, elementType, metadata, content, authStatus);
    if (!published) {
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
    const { fileUrl, wasDuplicate } = published;
    // Log submission result (DMCP-SEC-006)
    logger.info(wasDuplicate ? `Skipped duplicate upload for ${safeName} - already in portfolio` : `Successfully submitted ${safeName} to GitHub portfolio`, {
      elementType,
      username: authStatus.username,
      fileUrl
    });
    const portfolioMessage = wasDuplicate ?
      `✅ ${safeName} already exists in your GitHub portfolio (no changes needed)` :
      `✅ Successfully uploaded ${safeName} to your GitHub portfolio!`;

    // SECURITY ENHANCEMENT (Task #14): Smart token management for collection submission
    const collectionTokenManagement = await this.manageTokenForLongOperation('collection_submission');
    this.assertMemoryOperation();
    if (!collectionTokenManagement.canProceed) {
      // Token management failed for collection submission, but main submission succeeded
      const errorMessage = collectionTokenManagement.error?.message || 'Token management failed';
      return {
        success: true,
        message: `${portfolioMessage}\n📁 Portfolio URL: ${fileUrl}\n\n⚠️ Collection submission skipped: ${errorMessage}`,
        url: fileUrl
      };
    }

    const token = collectionTokenManagement.token!;
    // Provide refresh guidance if recommended for collection submission
    if (collectionTokenManagement.refreshRecommended) {
      logger.info('Collection submission proceeding with aging token', {
        tokenType: this.tokenManager.getTokenType(token),
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
      token,
      localPath  // Pass the local file path for reading content
    });
    this.assertMemoryOperation();

    return {
      success: true,
      message: `${portfolioMessage}\n📁 Portfolio URL: ${fileUrl}\n\n${this.describeCollectionOutcome(collectionSubmissionResult)}`,
      url: fileUrl
    };
  }

  /** Upload the definition unless the portfolio already holds identical content. */
  private async publishToPortfolio(
    safeName: string,
    elementType: ElementType,
    metadata: PortfolioElementMetadata,
    content: string,
    authStatus: any
  ): Promise<{ fileUrl: string; wasDuplicate: boolean } | null> {
    // DUPLICATE DETECTION: Check if content already exists in portfolio
    const repoFullName = `${authStatus.username}/${this.portfolioRepoManager.getRepositoryName()}`;
    // Issue #815: Use correct file extension per element type
    const filePath = `${elementType}/${safeName}${getElementFileExtension(elementType)}`;
    // Issue #852: Memories are pure YAML — don't wrap in markdown frontmatter
    const isYamlType = getElementFileExtension(elementType) === '.yaml';
    const fullContent = isYamlType
      ? content  // YAML elements: use raw content (matches serialize() output)
      : `---\n${JSON.stringify(metadata, null, 2)}\n---\n\n${content}`;
    const isDuplicate = await this.checkExistingContent(repoFullName, filePath, fullContent, authStatus.token);
    this.assertMemoryOperation();

    let fileUrl: string | null;
    if (isDuplicate) {
      // Content already exists, construct the URL without uploading
      fileUrl = `https://github.com/${repoFullName}/blob/main/${filePath}`;
      logger.info('Skipped duplicate upload to portfolio', { elementName: safeName, path: filePath });
    } else {
      // TYPE SAFETY FIX #2: Use adapter pattern instead of complex type casting
      const adapter = new PortfolioElementAdapter({ type: elementType, metadata, content });
      // UX IMPROVEMENT: Add retry logic for transient failures
      fileUrl = await this.saveElementWithRetry(adapter, safeName, elementType);
    }
    if (!fileUrl) return null;
    // A duplicate skip is recognisable by its blob URL; an upload reports a commit URL.
    return { fileUrl, wasDuplicate: fileUrl.includes('blob/main/') && !fileUrl.includes('/commit/') };
  }

  private describeCollectionOutcome(result: { submitted: boolean; declined: boolean; error?: string; issueUrl?: string; isDuplicate?: boolean }): string {
    if (result.submitted) {
      return result.isDuplicate
        ? `📋 Collection issue already exists (no new submission needed)\n🔗 Issue: ${result.issueUrl}`
        : `🎉 Also submitted to DollhouseMCP collection for community review!\n📋 Issue: ${result.issueUrl}`;
    }
    if (result.declined) return `💡 You can submit to the collection later using the same command.`;
    if (result.error) {
      return `⚠️ Collection submission failed: ${result.error}\n💡 You can manually submit at: https://github.com/DollhouseMCP/collection/issues/new`;
    }
    return '';
  }

  async execute(params: SubmitToPortfolioParams): Promise<SubmitToPortfolioResult> {
    this.assertMemoryOperation();
    if (this.memoryRegistry && !this.memoryOperation) throw new Error('Authentic selected portfolio submission operation required');
    if (params.type !== undefined) this.assertSubmissionType(params.type);
    const startTime = Date.now();
    const timings: Record<string, number> = {};
    const step = async <R>(index: number, key: string, title: string, work: () => Promise<R>,
      summary: (result: R) => Record<string, unknown> = () => ({})): Promise<R> => {
      logger.info(`Step ${index}/8: ${title}...`);
      const started = Date.now();
      const result = await work();
      this.assertMemoryOperation();
      timings[key] = Date.now() - started;
      logger.info(`✅ Step ${index} complete (${timings[key]}ms)`, summary(result));
      return result;
    };

    logger.info('🚀 SUBMISSION WORKFLOW STARTING', {
      params: JSON.stringify(params),
      timestamp: new Date().toISOString()
    });

    try {
      // Step 1: Validate and normalize input parameters
      const validation = await step(1, 'validation', '📋 Validating parameters', () => Promise.resolve(this.validateAndNormalizeParams(params)));
      if (!validation.success) return validation.error!;
      const safeName = validation.safeName!;

      // Step 2: Find content locally with smart type detection
      const discovery = await step(2, 'contentDiscovery', '🔍 Finding content locally',
        () => this.discoverContentWithTypeDetection(safeName, params.type, params.name),
        result => ({ found: result.success, elementType: result.elementType, path: result.localPath }));
      if (!discovery.success) return discovery.error!;
      const elementType = discovery.elementType!;
      this.assertSubmissionType(elementType);
      const localPath = discovery.localPath!;

      // Step 3: Validate file and content security (including size check), BEFORE authentication
      // so users get immediate feedback about file issues
      const security = await step(3, 'security', '🔒 Validating security and file size', () => this.validateFileAndContent(localPath));
      if (!security.success) return security.error!;
      const content = security.content!;

      // Step 4: Check authentication status, AFTER file validation so users don't need to auth
      // just to learn their file is too large
      const auth = await step(4, 'authentication', '🔐 Checking authentication', () => this.checkAuthentication(),
        result => ({ username: result.authStatus?.username, hasToken: !!result.authStatus?.hasToken }));
      if (!auth.success) return auth.error!;
      const authStatus = auth.authStatus!;

      // Step 5: Prepare metadata for element
      const metadata = await step(5, 'metadata', '📝 Preparing metadata',
        () => this.prepareElementMetadata(safeName, elementType, authStatus, localPath),
        result => ({ author: result.author, elementName: safeName }));

      // Step 6: Set up GitHub repository access
      const repo = await step(6, 'repoSetup', '🔧 Setting up GitHub repository', () => this.setupGitHubRepository(authStatus),
        result => ({ success: result.success }));
      if (!repo.success) return repo.error!;

      // Step 7: Submit element to portfolio and handle collection submission
      const result = await step(7, 'submission', '📤 Submitting to portfolio',
        () => this.submitElementAndHandleResponse(safeName, elementType, metadata, content, authStatus, localPath));

      // Step 8: Final reporting
      timings['total'] = Date.now() - startTime;
      logger.info('✨ SUBMISSION WORKFLOW COMPLETE', {
        success: result.success,
        timings,
        totalTime: `${timings['total']}ms`
      });
      return result;
    } catch (error) {
      this.assertMemoryOperation();
      if (this.memoryOperation) throw error;
      return this.formatExecuteFailure(error, params);
    }
  }

  /** SECURITY ENHANCEMENT (Task #14): error response with token refresh guidance when the failure looks token-related. */
  private async formatExecuteFailure(error: unknown, params: SubmitToPortfolioParams): Promise<SubmitToPortfolioResult> {
    ErrorHandler.logError('submitToPortfolio', error, {
      elementName: params.name,
      elementType: params.type
    });
    const errorMessage = (error instanceof Error ? error.message : String(error)).toLowerCase();
    const isTokenError = ['token', 'auth', '401', '403'].some(marker => errorMessage.includes(marker));
    const formattedError = ErrorHandler.formatForResponse(error);
    if (!isTokenError) return formattedError;
    try {
      // Get current token to determine type for guidance
      const currentToken = await this.tokenManager.getGitHubTokenAsync();
      this.assertMemoryOperation();
      if (currentToken && formattedError.message) {
        formattedError.message += this.formatTokenRefreshGuidance('portfolio submission', this.tokenManager.getTokenType(currentToken));
      }
    } catch {
      // If we can't get token info, provide generic guidance
      formattedError.message += '\n\n🔄 **Authentication Issue**: Try running `setup_github_auth` to refresh your authentication.';
    }
    return formattedError;
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
    localPath?: string;  // Path to the local element file
  }): Promise<{ submitted: boolean; declined: boolean; error?: string; issueUrl?: string; isDuplicate?: boolean }> {
    try {
      // Create a simple prompt message for the user
      // Note: In MCP context, we can't do interactive prompts, so we'll need to
      // either make this automatic or require a parameter
      
      // For now, let's check if the user has set an environment variable
      // to auto-submit to collection (opt-in behavior)
      const autoSubmit = this.isAutoSubmitEnabled();
      
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
        token: params.token,
        localPath: params.localPath  // Pass through the file path
      });
      this.assertMemoryOperation();

      if (issueUrl) {
        // Check if this was an existing issue (duplicate) or newly created
        // The checkExistingIssue method returns early with existing URL if duplicate found
        const isDuplicate = issueUrl.includes('/issues/') && !issueUrl.includes('new');
        
        if (isDuplicate) {
          logger.info('Collection issue already exists, returning existing issue', { issueUrl });
          return { 
            submitted: true, 
            declined: false, 
            issueUrl,
            isDuplicate: true 
          };
        } else {
          logger.info('Successfully created collection submission issue', { issueUrl });
          return { 
            submitted: true, 
            declined: false, 
            issueUrl,
            isDuplicate: false 
          };
        }
      } else {
        return { submitted: false, declined: false, error: 'Failed to create issue' };
      }

    } catch (error) {
      this.assertMemoryOperation();
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
  private async createCollectionIssue(params: CollectionIssueParams): Promise<string | null> {
    try {
      // DUPLICATE DETECTION: Check if issue already exists
      const existingIssueUrl = await this.checkExistingIssue(params.elementName, params.username, params.token);
      this.assertMemoryOperation();
      if (existingIssueUrl) {
        logger.info('Collection issue already exists, skipping creation', {
          elementName: params.elementName,
          issueUrl: existingIssueUrl
        });
        return existingIssueUrl;
      }

      const meta = params.metadata as ExtendedMeta;
      const elementContent = await this.readElementForIssue(params, meta);
      if (elementContent === null) return null;

      const title = `[${params.elementType}] Add ${params.elementName} by @${params.username}`;
      const body = this.formatCollectionIssueBody(params, collectionIssueDetails(meta), elementContent);
      // Determine labels based on element type
      const labels = [
        'element-submission',  // CRITICAL: Triggers automation workflow
        'collection-repo',     // Indicates this is for the collection
        'contribution',        // All submissions get this
        'pending-review',      // Needs review
        params.elementType.toLowerCase() // Element type label (e.g., 'personas')
      ];

      // PERFORMANCE OPTIMIZATION (Task #6): Use GitHub rate limiter for API calls
      this.assertSubmissionType(params.elementType);
      const issueUrl = await this.rateLimiter.queueRequest(
        'create-collection-issue',
        () => this.postCollectionIssue(params.token, { title, body, labels }),
        'high' // High priority for collection submission
      );
      this.assertMemoryOperation();
      return issueUrl;
    } catch (error: any) {
      this.assertMemoryOperation();
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

  /**
   * The full element file for the issue body, re-validated because it is posted publicly.
   * Returns null when the file must not be posted (too large, critical security issues); falls
   * back to the metadata when the file cannot be read or no path was given.
   */
  private async readElementForIssue(params: CollectionIssueParams, meta: ExtendedMeta): Promise<string | null> {
    if (!params.localPath) {
      logger.warn('No file path provided for collection submission, using metadata only', { elementName: params.elementName });
      return this.formatMetadataAsYaml(params.metadata, meta);
    }
    try {
      // SECURITY: Validate file size before reading to prevent memory exhaustion
      const stats = await this.fileOperations.stat(params.localPath);
      this.assertMemoryOperation();
      if (stats.size > FILE_SIZE_LIMITS.MAX_FILE_SIZE) {
        // DO NOT truncate user content - reject if too large
        logger.error('Element file exceeds size limit for collection submission', {
          elementName: params.elementName, fileSize: stats.size, maxSize: FILE_SIZE_LIMITS.MAX_FILE_SIZE
        });
        SecurityMonitor.logSecurityEvent({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'MEDIUM',
          source: 'SubmitToPortfolioTool.createCollectionIssue',
          details: `File size ${stats.size} exceeds limit for collection submission`,
          metadata: { elementName: params.elementName, fileSize: stats.size, limit: FILE_SIZE_LIMITS.MAX_FILE_SIZE }
        });
        return null;
      }
      const elementContent = await this.fileOperations.readFile(params.localPath, { source: 'SubmitToPortfolioTool.createCollectionIssue' });
      // SECURITY: already validated in validateFileAndContent(); re-validated because this is public
      const validationResult = ContentValidator.validateAndSanitize(elementContent);
      if (!validationResult.isValid && validationResult.severity === 'critical') {
        logger.error('Element content failed security validation for collection submission', {
          elementName: params.elementName, issues: validationResult.detectedPatterns
        });
        SecurityMonitor.logSecurityEvent({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'HIGH',
          source: 'SubmitToPortfolioTool.createCollectionIssue',
          details: `Critical security issues detected in collection submission`,
          metadata: { elementName: params.elementName, detectedPatterns: validationResult.detectedPatterns }
        });
        return null;
      }
      // Use the sanitized content (but NOT truncated)
      const content = validationResult.sanitizedContent || elementContent;
      logger.debug('Read and validated element file content for collection submission', {
        elementName: params.elementName,
        contentLength: content.length,
        securityIssues: validationResult.detectedPatterns?.length || 0,
        buildVersion: `v${PACKAGE_VERSION}`,
      });
      return content;
    } catch (error) {
      this.assertMemoryOperation();
      logger.warn('Failed to read element file content, falling back to metadata only', {
        elementName: params.elementName,
        error: error instanceof Error ? error.message : String(error)
      });
      return this.formatMetadataAsYaml(params.metadata, meta);
    }
  }

  private formatCollectionIssueBody(params: CollectionIssueParams, details: string[], elementContent: string): string {
    return `## New ${params.elementType} Submission

**Name**: ${params.elementName}
**Author**: @${params.username}
**Type**: ${params.elementType}

### Description
${params.metadata.description || 'No description provided'}

### Element Details
${details.length > 0 ? details.join('\n') : '*No additional metadata available*'}

### Portfolio Link
${params.portfolioUrl}

### Element Content
\`\`\`yaml
${elementContent}
\`\`\`

### Review Checklist
- [ ] Content is appropriate and follows community guidelines
- [ ] No security vulnerabilities or malicious patterns
- [ ] Metadata is complete and accurate
- [ ] Element works as described
- [ ] No duplicate of existing collection content

---
*This submission was created automatically via the DollhouseMCP submit_collection_content tool (v${PACKAGE_VERSION}).*`;
  }

  /** One POST to the collection repository under the request timeout; returns the issue URL. */
  private async postCollectionIssue(token: string, issue: { title: string; body: string; labels: string[] }): Promise<string> {
    this.assertMemoryOperation();
    const url = 'https://api.github.com/repos/DollhouseMCP/collection/issues';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), getValidatedTimeout());
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'DollhouseMCP/1.0'
        },
        body: JSON.stringify(issue),
        signal: controller.signal
      });
      this.assertMemoryOperation();
      clearTimeout(timeoutId);
      const rateLimit = this.logRateLimitStatus(response);
      if (!response.ok) {
        const errorText = await response.text();
        this.assertMemoryOperation();
        logger.error('GitHub API error creating issue', {
          status: response.status, statusText: response.statusText, error: errorText, ...rateLimit
        });
        const detail = COLLECTION_ISSUE_STATUS_DETAIL[response.status];
        if (detail) logger.error(detail);
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      this.assertMemoryOperation();
      return data.html_url;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** PERFORMANCE OPTIMIZATION (Task #15): rate limit headers for diagnostics. */
  private logRateLimitStatus(response: Response): { rateLimitRemaining: string | null; rateLimitReset: string | null } {
    const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
    const rateLimitReset = response.headers.get('X-RateLimit-Reset');
    const resetTime = rateLimitReset ? new Date(Number.parseInt(rateLimitReset) * 1000) : undefined;
    logger.debug('GitHub API rate limit status', {
      operation: 'create-collection-issue',
      remaining: rateLimitRemaining,
      limit: response.headers.get('X-RateLimit-Limit'),
      resetTime,
      responseStatus: response.status
    });
    if (rateLimitRemaining && Number.parseInt(rateLimitRemaining) < 100) {
      logger.warn('Approaching GitHub API rate limit', {
        operation: 'create-collection-issue',
        remaining: rateLimitRemaining,
        resetTime,
        recommendation: 'Consider reducing API usage frequency or authenticating for higher limits'
      });
    }
    return { rateLimitRemaining, rateLimitReset };
  }

  private async findLocalContent(name: string, type: ElementType): Promise<string | null> {
    this.assertMemoryOperation();
    if (this.memoryOperation && type === ElementType.MEMORY &&
        this.memoryOperation.operation.manager.isGuardedHeadUpdateEnabled()) {
      // Generic type discovery must not refuse a non-memory name merely because
      // MEMORY is among the types inspected. A genuine matching DB owner refuses.
      const entry = await this.portfolioIndexManager.findByName(name, { elementType: type, fuzzyMatch: true });
      this.assertMemoryOperation();
      if (entry) this.assertSubmissionType(type);
      return null;
    }
    this.assertSubmissionType(type);
    try {
      return await this.locateLocalFile(name, type);
    } catch (error) {
      this.assertMemoryOperation();
      // Only a missing type directory means "not in this type"; any other failure is a read
      // failure and propagates, never "not found".
      if (this.memoryOperation || !isAbsentKindError(error)) throw error;
      logger.debug('No local content directory for type', { name, type, code: (error as NodeJS.ErrnoException).code });
      return null;
    }
  }

  /** The index (metadata names) first, then the filename discovery fallbacks. */
  private async locateLocalFile(name: string, type: ElementType): Promise<string | null> {
    // METADATA INDEX FIX: metadata names are found through the portfolio index. The submission
    // requires a real local file: a DB UUID is a locator, never a path.
    const indexEntry = this.memoryOperation && type === ElementType.MEMORY ? null
      : await this.portfolioIndexManager.findByName(name, { elementType: type, fuzzyMatch: true });
    this.assertMemoryOperation();
    if (indexEntry) {
      logger.debug('Found content via metadata index', {
        searchName: name, metadataName: indexEntry.metadata.name, filename: indexEntry.filename,
        filePath: indexEntry.filePath, type
      });
      return indexEntry.filePath;
    }
    logger.debug('Index lookup failed, falling back to file discovery', { name, type });
    const portfolioDir = this.portfolioManager.getElementDir(type);
    let file = await this.findPortfolioFile(portfolioDir, name);
    this.assertMemoryOperation();
    // Issue #815: memory files live in dated subdirectories (YYYY-MM-DD/).
    if (!file && type === ElementType.MEMORY) file = await this.findDatedMemoryFile(portfolioDir, name);
    // Normalized name (e.g. "J.A.R.V.I.S." -> "j-a-r-v-i-s"), then common display-name variations.
    const normalizedName = SubmitToPortfolioTool.normalizedFileName(name);
    if (!file && normalizedName !== name.toLowerCase()) {
      logger.debug('Trying normalized name search', { original: name, normalized: normalizedName, type });
      file = await this.findPortfolioFile(portfolioDir, normalizedName);
    }
    file ??= await this.findByNameVariations(portfolioDir, name, type);
    if (file) {
      logger.debug('Found local content file via fallback', { name, type, file });
      return file;
    }
    logger.debug('No content found', { name, type });
    return null;
  }

  private static normalizedFileName(name: string): string {
    return name.toLowerCase()
      .replaceAll(/[^a-z0-9]/g, '-')
      .replaceAll(/-+/g, '-')
      .replaceAll(/(^-)|(-$)/g, '');
  }

  private async findPortfolioFile(portfolioDir: string, name: string): Promise<string | null> {
    return FileDiscoveryUtil.findFile(portfolioDir, name, {
      extensions: ['.md', '.json', '.yaml', '.yml'], partialMatch: true, cacheResults: true
    });
  }

  /** Try "J.A.R.V.I.S." style variations one after another until one matches. */
  private async findByNameVariations(portfolioDir: string, name: string, type: ElementType): Promise<string | null> {
    const variations = [
      name.replaceAll('.', ''),          // Remove dots
      name.replaceAll(/\s+/g, '-'),      // Replace spaces with dashes
      name.replaceAll(/[\s.]/g, ''),     // Remove spaces and dots
      name.replaceAll(/[\s.]/g, '-'),    // Replace spaces and dots with dashes
    ].filter(variation => variation !== name && variation.length > 0);
    const tryFrom = async (index: number): Promise<string | null> => {
      if (index >= variations.length) return null;
      const file = await this.findPortfolioFile(portfolioDir, variations[index]);
      if (!file) return tryFrom(index + 1);
      logger.debug('Found content using name variation', { original: name, variation: variations[index], file, type });
      return file;
    };
    return tryFrom(0);
  }

  /** Memories live in dated subdirectories; a missing directory is absence, any other failure propagates. */
  private async findDatedMemoryFile(portfolioDir: string, name: string): Promise<string | null> {
    const { readdir: readdirFs } = await import('node:fs/promises');
    this.assertMemoryOperation();
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await readdirFs(portfolioDir, { withFileTypes: true });
    } catch (error) {
      this.assertMemoryOperation();
      if (!isAbsentKindError(error)) throw error;
      logger.debug('Memory directory not present', { name, code: (error as NodeJS.ErrnoException).code });
      return null;
    }
    this.assertMemoryOperation();
    const subdirs = entries.filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name));
    const normalizedSearch = SubmitToPortfolioTool.normalizedFileName(name);
    const searchFrom = async (index: number): Promise<string | null> => {
      if (index >= subdirs.length) return null;
      const subdirPath = path.join(portfolioDir, subdirs[index].name);
      // FileOperationsService listing respects sandboxing.
      const subdirFiles = await this.fileOperations.listDirectory(subdirPath);
      this.assertMemoryOperation();
      const match = subdirFiles.find(file => SubmitToPortfolioTool.isMemoryFileFor(file, normalizedSearch, name));
      if (!match) return searchFrom(index + 1);
      const file = path.join(subdirPath, match);
      logger.debug('Found memory in dated subdirectory', { name, subdir: subdirs[index].name, file });
      return file;
    };
    return searchFrom(0);
  }

  private static isMemoryFileFor(file: string, normalizedSearch: string, name: string): boolean {
    // Skip backup files (same filtering as PortfolioManager.listElements).
    if (file.includes('.backup-') || file.includes('.backup.')) return false;
    const extension = path.extname(file);
    if (!['.yaml', '.yml', '.md'].includes(extension)) return false;
    const base = file.slice(0, -extension.length).toLowerCase();
    return base === normalizedSearch || base === name.toLowerCase();
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
    if (this.memoryOperation) {
      // The ordinary optimizer converts failures to strings. Bound discovery must
      // retain the genuine selected-read/refusal cause and complete type census.
      const discovered = await Promise.all(Object.values(ElementType).map(async type => {
        const filePath = await this.findLocalContent(name, type);
        this.assertMemoryOperation();
        return filePath ? { type, path: filePath } : null;
      }));
      this.assertMemoryOperation();
      const matches = discovered.filter((match): match is ElementDetectionMatch => match !== null);
      return { found: matches.length > 0, matches };
    }
    // PERFORMANCE OPTIMIZATION (Task #9): early termination over one search per element type.
    // The optimizer reduces failures to strings, so each search keeps its real cause here and a
    // failed type read propagates instead of reading as "not found".
    const elementTypes = Object.values(ElementType);
    const failures: unknown[] = [];
    const searchFunctions = elementTypes.map(type => async () => {
      try {
        const filePath = await this.findLocalContent(name, type);
        return filePath ? { type, path: filePath } : null;
      } catch (error) {
        failures.push(error);
        throw error;
      }
    });
    const isExactMatch = (match: ElementDetectionMatch): boolean =>
      path.basename(match.path, path.extname(match.path)).toLowerCase() === name.toLowerCase();
    const searchResults = await EarlyTerminationSearch.executeWithEarlyTermination(searchFunctions, isExactMatch, {
      operationName: 'element-type-detection',
      timeoutAfterExactMatch: 1000, // Wait 1 second for other searches after exact match
      maxParallelSearches: 8 // Limit concurrent searches to avoid overwhelming the system
    });
    this.assertMemoryOperation();
    if (failures.length > 0) throw failures[0];
    logger.debug('Element type detection completed with early termination optimization', {
      name,
      totalSearches: searchResults.totalSearches,
      completedSearches: searchResults.completedSearches,
      matches: searchResults.matches.length,
      exactMatchFound: !!searchResults.exactMatch,
      exactMatchType: searchResults.exactMatch?.type,
      earlyTerminationTriggered: searchResults.earlyTerminationTriggered,
      performanceGain: searchResults.performanceGain,
      matchedTypes: searchResults.matches.map(match => match.type)
    });
    if (searchResults.earlyTerminationTriggered) {
      logger.info('Early termination optimization applied successfully', {
        name,
        exactMatchType: searchResults.exactMatch?.type,
        performanceGain: searchResults.performanceGain,
        searchesCompleted: searchResults.completedSearches,
        searchesTotal: searchResults.totalSearches
      });
    }
    return { found: searchResults.matches.length > 0, matches: searchResults.matches };
  }

  /**
   * UX IMPROVEMENT: Generate name suggestions for similar content
   * PERFORMANCE OPTIMIZATION (Task #8): Enhanced batch operation handling with clear partial failure reporting
   * Helps users find content when exact matches fail
   */
  private async generateNameSuggestions(searchName: string): Promise<Array<{name: string, type: string}>> {
    const searchLower = searchName.toLowerCase();
    const elementTypes = Object.values(ElementType)
      .filter(type => !(type === ElementType.MEMORY && this.memoryOperation?.operation.manager.isGuardedHeadUpdateEnabled()));
    // A failed type scan propagates (suggestions from survivors would hide it).
    const scans = await Promise.all(elementTypes.map(type => this.suggestionsForType(type, searchLower)));
    const suggestions = scans.flatMap(scan => scan.suggestions);
    // Sort by similarity (higher is better) and return top suggestions
    suggestions.sort((a, b) =>
      this.calculateSimilarity(searchLower, b.name.toLowerCase()) - this.calculateSimilarity(searchLower, a.name.toLowerCase()));
    logger.debug('Name suggestions generated successfully', {
      searchName,
      totalTypes: elementTypes.length,
      totalSuggestions: suggestions.length,
      topSuggestions: suggestions.slice(0, 3).map(s => s.name)
    });
    return suggestions;
  }

  /** Similar names in one type directory; a missing directory has none, any other failure propagates. */
  private async suggestionsForType(type: ElementType, searchLower: string):
    Promise<{ type: ElementType; suggestions: Array<{ name: string; type: string }> }> {
    const files = await FileDiscoveryUtil.findFile(this.portfolioManager.getElementDir(type), '*', {
      extensions: ['.md', '.json', '.yaml', '.yml'],
      partialMatch: false,
      cacheResults: true
    });
    this.assertMemoryOperation();
    let candidates: string[] = [];
    if (Array.isArray(files)) candidates = files;
    else if (files) candidates = [files];
    const suggestions = candidates
      .map(filePath => path.basename(filePath, path.extname(filePath)))
      .filter(basename => this.calculateSimilarity(searchLower, basename.toLowerCase()) > SEARCH_CONFIG.MIN_SIMILARITY_SCORE)
      .map(name => ({ name, type }));
    return { type, suggestions };
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
    for (const character of shorter) {
      if (longer.includes(character)) common++;
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
    const exhausted = (lastError: unknown): null => {
      logger.error(`All ${maxRetries} save attempts failed`, {
        elementName,
        elementType,
        lastError: (lastError as Error | undefined)?.message
      });
      return null;
    };
    const attempt = async (number: number, lastError: unknown): Promise<string | null> => {
      if (number > maxRetries) return exhausted(lastError);
      try {
        logger.debug(`Attempting to save element (attempt ${number}/${maxRetries})`, { elementName, elementType, attempt: number });
        this.assertSubmissionType(elementType);
        const fileUrl = await this.portfolioRepoManager.saveElement(adapter, true);
        this.assertMemoryOperation();
        if (fileUrl) {
          if (number > 1) logger.info(`Element saved successfully after ${number} attempts`, { elementName, elementType, fileUrl });
          return fileUrl;
        }
        // If saveElement returns null, treat as a failure but don't wait before the next attempt
        return attempt(number + 1, new Error(`saveElement returned null on attempt ${number}`));
      } catch (error: any) {
        this.assertMemoryOperation();
        const isRetryable = this.isRetryableError(error);
        logger.warn(`Save attempt ${number} failed`, {
          elementName, elementType, attempt: number, error: error.message, isRetryable, willRetry: isRetryable && number < maxRetries
        });
        if (!isRetryable) {
          logger.error('Non-retryable error encountered, aborting retries', { elementName, error: error.message });
          return exhausted(error);
        }
        if (number < maxRetries) {
          const delay = calculateRetryDelay(number);
          logger.debug(`Waiting ${delay}ms before retry`, { attempt: number, delay });
          await new Promise(resolve => setTimeout(resolve, delay));
          this.assertMemoryOperation();
        }
        return attempt(number + 1, error);
      }
    };
    return attempt(1, null);
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
