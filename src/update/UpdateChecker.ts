/**
 * UpdateChecker - Secure GitHub release update checking with comprehensive sanitization
 * 
 * Security measures implemented:
 * 1. XSS Protection: DOMPurify with strict no-tags/no-attributes policy
 * 2. Command Injection Prevention: Multiple regex patterns for various escape sequences
 * 3. URL Validation: Whitelist approach allowing only http/https schemes
 * 4. Information Disclosure Prevention: Sanitized logging of sensitive data
 * 5. Length Limits: Configurable limits to prevent DoS attacks
 * 6. OWASP Patterns: Protection against PHP, ASP, hex, unicode, and octal escapes
 * 
 * Performance optimizations:
 * - Cached DOMPurify instance to avoid recreation overhead
 * - Single-pass regex processing for injection patterns
 * - Exponential backoff for network retries
 */

import { RELEASES_API_URL } from '../config/constants.js';
import { VersionManager } from './VersionManager.js';
import { RateLimiter, RateLimiterFactory } from './RateLimiter.js';
import { SignatureVerifier } from './SignatureVerifier.js';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  isUpdateAvailable: boolean;
  releaseDate: string;
  releaseNotes: string;
  releaseUrl: string;
  tagName?: string;
  signatureVerified?: boolean;
  signerInfo?: string;
}

// Type declarations for better type safety
type DOMPurifyInstance = ReturnType<typeof DOMPurify>;

export class UpdateChecker {
  private versionManager: VersionManager;
  private rateLimiter: RateLimiter;
  private signatureVerifier: SignatureVerifier;
  
  // Static cache for DOMPurify to improve performance
  // We use 'any' for JSDOM window to avoid complex type conflicts
  // but maintain type safety for DOMPurify instance
  private static purifyWindow: any = null;
  private static purify: DOMPurifyInstance | null = null;
  
  // Security configuration with sensible defaults
  private readonly releaseNotesMaxLength: number;
  private readonly urlMaxLength: number;
  private readonly securityLogger?: (event: string, details: any) => void;
  private readonly requireSignedReleases: boolean;
  
  constructor(
    versionManager: VersionManager,
    options?: {
      releaseNotesMaxLength?: number;
      urlMaxLength?: number;
      securityLogger?: (event: string, details: any) => void;
      rateLimiter?: RateLimiter;
      signatureVerifier?: SignatureVerifier;
      requireSignedReleases?: boolean;
    }
  ) {
    if (!versionManager) {
      throw new Error('VersionManager is required');
    }
    this.versionManager = versionManager;
    
    // Apply options with defaults and validation
    this.releaseNotesMaxLength = options?.releaseNotesMaxLength ?? 5000;
    this.urlMaxLength = options?.urlMaxLength ?? 2048;
    this.securityLogger = options?.securityLogger;
    
    // Use provided rate limiter or create default
    this.rateLimiter = options?.rateLimiter || RateLimiterFactory.createUpdateCheckLimiter();
    
    // Determine if we're in production environment
    const isProduction = process.env.NODE_ENV === 'production' || 
                        process.env.CI === 'true' ||
                        !process.env.ALLOW_UNSIGNED_RELEASES;
    
    // Use provided signature verifier or create default
    this.signatureVerifier = options?.signatureVerifier || new SignatureVerifier({
      // In production, we should require signed releases
      allowUnsignedInDev: !isProduction
    });
    
    // Whether to require signed releases (default: true in production)
    this.requireSignedReleases = options?.requireSignedReleases ?? isProduction;
    
    // Validate configuration for security
    if (this.releaseNotesMaxLength < 100) {
      throw new Error('releaseNotesMaxLength must be at least 100 characters for security');
    }
    if (this.urlMaxLength < 50) {
      throw new Error('urlMaxLength must be at least 50 characters');
    }
    
    // Initialize cached DOMPurify instance for performance
    // This avoids creating a new JSDOM window for each sanitization
    if (!UpdateChecker.purifyWindow) {
      const dom = new JSDOM('');
      UpdateChecker.purifyWindow = dom.window;
      // DOMPurify expects a Window-like object from JSDOM
      UpdateChecker.purify = DOMPurify(UpdateChecker.purifyWindow);
    }
  }
  
  /**
   * Execute a network operation with retry logic and exponential backoff
   * @param operation - The async operation to execute
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   * @param baseDelay - Base delay in milliseconds for exponential backoff (default: 1000ms)
   * @returns Promise resolving to the operation result
   * @throws The last error if all retries fail
   */
  private async retryNetworkOperation<T>(
    operation: () => Promise<T>, 
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on the last attempt
        if (attempt === maxRetries) {
          break;
        }
        
        // Don't retry certain errors (like 404, 401)
        if (error instanceof Error && error.message.includes('404')) {
          break;
        }
        
        // Calculate delay with exponential backoff
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError!;
  }
  
  /**
   * Check for updates from GitHub releases with security and error handling
   * @returns UpdateCheckResult if update info is available, null if no releases found
   * @throws Error for network or API failures or rate limit exceeded
   */
  async checkForUpdates(): Promise<UpdateCheckResult | null> {
    // Check rate limit before making API request
    const rateLimitStatus = this.rateLimiter.checkLimit();
    if (!rateLimitStatus.allowed) {
      const waitTime = Math.ceil(rateLimitStatus.retryAfterMs! / 1000);
      const waitMinutes = Math.floor(waitTime / 60);
      const waitSeconds = waitTime % 60;
      
      const timeStr = waitMinutes > 0 
        ? `${waitMinutes} minute${waitMinutes > 1 ? 's' : ''} ${waitSeconds} second${waitSeconds !== 1 ? 's' : ''}`
        : `${waitSeconds} second${waitSeconds !== 1 ? 's' : ''}`;
      
      throw new Error(
        `Rate limit exceeded. Please wait ${timeStr} before checking for updates again. ` +
        `(${rateLimitStatus.remainingTokens} requests remaining, resets at ${rateLimitStatus.resetTime.toLocaleTimeString()})`
      );
    }
    
    // Consume a rate limit token
    this.rateLimiter.consumeToken();
    
    const currentVersion = await this.versionManager.getCurrentVersion();
    
    // Check GitHub releases API for latest version with retry logic
    const response = await this.retryNetworkOperation(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      try {
        const response = await fetch(RELEASES_API_URL, {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'DollhouseMCP/1.0'
          },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        return null; // No releases found
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }
    
    const releaseData = await response.json();
    const tagName = releaseData.tag_name;
    const latestVersion = tagName?.replace(/^v/, '') || releaseData.name;
    // Use consistent date formatting method
    const publishedAt = releaseData.published_at;
    
    // Compare versions
    const isUpdateAvailable = this.versionManager.compareVersions(currentVersion, latestVersion) < 0;
    
    const releaseNotes = releaseData.body || 'See release notes on GitHub';
    
    // Verify release signature if we have a tag
    let signatureVerified = false;
    let signerInfo: string | undefined;
    
    if (tagName) {
      try {
        const verificationResult = await this.signatureVerifier.verifyTagSignature(tagName);
        signatureVerified = verificationResult.verified;
        
        if (verificationResult.signerEmail) {
          signerInfo = verificationResult.signerEmail;
          if (verificationResult.signerKey) {
            signerInfo += ` (${verificationResult.signerKey})`;
          }
        }
        
        // Log signature verification
        if (this.securityLogger) {
          this.securityLogger('signature_verification', {
            tagName,
            verified: signatureVerified,
            signerKey: verificationResult.signerKey,
            error: verificationResult.error
          });
        }
        
        // If signature verification is required and failed, throw error
        if (this.requireSignedReleases && !signatureVerified) {
          throw new Error(
            `Release signature verification failed: ${verificationResult.error || 'Unknown error'}. ` +
            'Only signed releases are accepted in production mode.'
          );
        }
      } catch (error) {
        // If we can't verify the signature and it's required, fail
        if (this.requireSignedReleases) {
          throw error;
        }
        // Otherwise, log and continue
        if (this.securityLogger) {
          this.securityLogger('signature_verification_error', {
            tagName,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    
    return {
      currentVersion,
      latestVersion,
      isUpdateAvailable,
      releaseDate: publishedAt,  // Will be formatted by formatDate() when displayed
      releaseNotes,
      releaseUrl: releaseData.html_url,
      tagName,
      signatureVerified,
      signerInfo
    };
  }
  
  /**
   * Get current rate limit status
   * @returns Current rate limit status including remaining requests and reset time
   */
  getRateLimitStatus(): { 
    allowed: boolean; 
    remainingRequests: number; 
    resetTime: Date;
    waitTimeSeconds?: number;
  } {
    const status = this.rateLimiter.getStatus();
    return {
      allowed: status.allowed,
      remainingRequests: status.remainingTokens,
      resetTime: status.resetTime,
      waitTimeSeconds: status.retryAfterMs ? Math.ceil(status.retryAfterMs / 1000) : undefined
    };
  }
  
  /**
   * Format update check results for display with comprehensive sanitization
   * @param result - The update check result to format
   * @param error - Optional error from update check
   * @param personaIndicator - Optional persona indicator prefix
   * @returns Formatted string safe for display
   */
  formatUpdateCheckResult(result: UpdateCheckResult | null, error?: Error, personaIndicator: string = ''): string {
    if (error) {
      const isAbortError = error.name === 'AbortError';
      const errorMessage = error.message || String(error);
      const isRateLimitError = errorMessage.includes('Rate limit exceeded');
      
      if (isRateLimitError) {
        return personaIndicator + 
          '⏳ **Rate Limit Exceeded**\n\n' +
          error.message + '\n\n' +
          '**Why this happens:**\n' +
          '• Update checks are limited to prevent API abuse\n' +
          '• GitHub API has rate limits for all applications\n\n' +
          '**What you can do:**\n' +
          '• Wait for the specified time before checking again\n' +
          '• Use `get_server_status` to see current version without API calls\n' +
          '• Visit https://github.com/DollhouseMCP/mcp-server/releases directly';
      }
      
      return personaIndicator + 
        '❌ **Update Check Failed**\n\n' +
        'Error: ' + errorMessage + '\n\n' +
        (isAbortError 
          ? 'The request timed out. Please check your internet connection and try again.'
          : 'Tips:\n' +
            '• Check your internet connection\n' +
            '• Ensure GitHub.com is accessible\n' +
            '• Try running `update_server true` for manual update\n' +
            '• Visit https://github.com/DollhouseMCP/mcp-server/releases');
    }
    
    if (!result) {
      const currentVersion = 'unknown';
      return personaIndicator + 
        '📦 **Update Check Complete**\n\n' +
        '🔄 **Current Version:** ' + currentVersion + '\n' +
        '📡 **Remote Status:** No releases found on GitHub\n' +
        'ℹ️ **Note:** This may be a development version or releases haven\'t been published yet.\n\n' +
        '**Manual Update:**\n' +
        'Use `update_server true` to pull latest changes from main branch.';
    }
    
    const statusParts = [
      personaIndicator + '📦 **Update Check Complete**\n\n',
      '🔄 **Current Version:** ' + result.currentVersion + '\n',
      '📡 **Latest Version:** ' + result.latestVersion + '\n',
      '📅 **Released:** ' + this.formatDate(result.releaseDate) + '\n'
    ];
    
    // Add signature verification status
    if (result.signatureVerified !== undefined) {
      if (result.signatureVerified) {
        statusParts.push('✅ **Signature:** Verified');
        if (result.signerInfo) {
          statusParts.push(` by ${result.signerInfo}`);
        }
        statusParts.push('\n');
      } else {
        statusParts.push('⚠️ **Signature:** Not verified\n');
      }
    }
    
    statusParts.push('\n');
    
    if (result.isUpdateAvailable) {
      statusParts.push(
        '✨ **Update Available!**\n\n',
        '**What\'s New:**\n' + this.sanitizeReleaseNotes(result.releaseNotes) + '\n\n',
        '**To Update:**\n',
        '• Use: `update_server true`\n',
        '• Or visit: ' + this.sanitizeUrl(result.releaseUrl) + '\n\n',
        '⚠️ **Note:** Update will restart the server and reload all personas.'
      );
    } else {
      statusParts.push(
        '✅ **You\'re Up to Date!**\n\n',
        'Your DollhouseMCP installation is current.\n',
        'Check back later for new features and improvements.'
      );
    }
    
    return statusParts.join('');
  }
  
  /**
   * Sanitize URLs to prevent dangerous schemes and information disclosure
   * 
   * Security measures:
   * - Length validation to prevent DoS
   * - Whitelist approach: only http/https allowed
   * - Sanitized logging to prevent sensitive data exposure
   * 
   * @param url - The URL to sanitize
   * @returns Empty string if invalid/dangerous, original URL if safe
   */
  private sanitizeUrl(url: string): string {
    if (!url) return '';
    
    // Check URL length
    if (url.length > this.urlMaxLength) {
      this.logSecurityEvent('url_too_long', { 
        length: url.length, 
        maxLength: this.urlMaxLength,
        urlPrefix: url.substring(0, 50) + '...'  // Only log first 50 chars
      });
      return '';  // URL too long
    }
    
    // Only allow http and https schemes
    const allowedSchemes = ['http:', 'https:'];
    try {
      const parsed = new URL(url);
      if (!allowedSchemes.includes(parsed.protocol)) {
        this.logSecurityEvent('dangerous_url_scheme', { 
          scheme: parsed.protocol,
          host: parsed.hostname  // Log only hostname, not full URL
        });
        return '';  // Return empty string for dangerous schemes
      }
      return url;
    } catch {
      this.logSecurityEvent('invalid_url', { 
        urlLength: url.length  // Log length only, not content
      });
      return '';  // Invalid URL
    }
  }
  
  /**
   * Sanitize release notes to prevent XSS, command injection, and DoS
   * 
   * Security layers:
   * 1. Length limiting (configurable, default 5000 chars)
   * 2. HTML/JS sanitization via DOMPurify (no tags/attributes allowed)
   * 3. Command injection pattern removal (backticks, command substitution)
   * 4. OWASP pattern removal (PHP, ASP, hex/unicode/octal escapes)
   * 
   * @param notes - The release notes to sanitize
   * @returns Sanitized release notes safe for display
   */
  private sanitizeReleaseNotes(notes: string): string {
    if (!notes) return 'See release notes on GitHub';
    
    // First, normalize Unicode to prevent bypass attacks
    const unicodeResult = UnicodeValidator.normalize(notes);
    let sanitized = unicodeResult.normalizedContent;
    
    if (unicodeResult.detectedIssues && unicodeResult.detectedIssues.length > 0) {
      this.logSecurityEvent('unicode_issues_in_release_notes', {
        issues: unicodeResult.detectedIssues,
        severity: unicodeResult.severity
      });
    }
    
    // Apply length limit
    if (sanitized.length > this.releaseNotesMaxLength) {
      this.logSecurityEvent('release_notes_truncated', { 
        originalLength: sanitized.length, 
        maxLength: this.releaseNotesMaxLength 
      });
      sanitized = sanitized.substring(0, this.releaseNotesMaxLength) + '...';
    }
    
    // Use cached DOMPurify instance with automatic recovery
    if (!UpdateChecker.purify || !UpdateChecker.purifyWindow) {
      // Reinitialize if somehow corrupted - provides resilience
      const dom = new JSDOM('');
      UpdateChecker.purifyWindow = dom.window;
      UpdateChecker.purify = DOMPurify(UpdateChecker.purifyWindow);
    }
    
    const beforeSanitize = sanitized;
    // DOMPurify configuration for maximum security
    // ALLOWED_TAGS: [] strips all HTML tags
    // ALLOWED_ATTR: [] strips all attributes
    // Additional options for extra security
    sanitized = UpdateChecker.purify.sanitize(sanitized, { 
      ALLOWED_TAGS: [],      // Strip all HTML tags
      ALLOWED_ATTR: [],      // Strip all attributes
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'link'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover']
    });
    
    if (beforeSanitize !== sanitized) {
      this.logSecurityEvent('html_content_removed', { 
        removedLength: beforeSanitize.length - sanitized.length 
      });
    }
    
    // Additional sanitization for command injection patterns
    // Single-pass processing for performance while maintaining security
    // These patterns cover various injection vectors beyond HTML/JS
    // Length limits added to prevent ReDoS attacks
    const patterns = [
      /`[^`]{0,1000}`/g,           // Backtick expressions (limited to 1000 chars)
      /\$\([^)]{0,1000}\)/g,       // Command substitution (limited to 1000 chars)
      /\$\{[^}]{0,1000}\}/g,       // Variable expansion (limited to 1000 chars)
      /<\?[^>]{0,1000}\?>/g,       // PHP tags (OWASP) (limited to 1000 chars)
      /&lt;%[^>]{0,1000}%&gt;/g,   // ASP tags (HTML-encoded by DOMPurify) (limited to 1000 chars)
      /<%[^>]{0,1000}%>/g,         // ASP tags (raw) (limited to 1000 chars)
      /\\x[0-9a-fA-F]{2}/g,        // Hex escapes (OWASP) - already limited by {2}
      /\\u[0-9a-fA-F]{4}/g,        // Unicode escapes - already limited by {4}
      /\\[0-7]{1,3}/g              // Octal escapes - already limited by {1,3}
    ];
    
    const beforePatterns = sanitized;
    for (const pattern of patterns) {
      sanitized = sanitized.replace(pattern, '');
    }
    
    if (beforePatterns !== sanitized) {
      this.logSecurityEvent('injection_patterns_removed', { 
        removedLength: beforePatterns.length - sanitized.length 
      });
    }
    
    return sanitized;
  }
  
  /**
   * Format date to human-readable format with consistent timezone handling
   * @param dateStr - ISO date string to format
   * @returns Human-readable date string (e.g., "July 5, 2025")
   */
  private formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        return dateStr;  // Return original if invalid
      }
      
      // Use UTC methods to ensure consistent timezone handling
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC'  // Ensure consistent timezone
      });
    } catch {
      return dateStr;  // Return original on error
    }
  }
  
  /**
   * Log security events for monitoring and alerting
   * Only logs if securityLogger callback was provided in constructor
   * @param event - The security event type
   * @param details - Event details (sanitized to prevent info disclosure)
   */
  private logSecurityEvent(event: string, details: any): void {
    if (this.securityLogger) {
      this.securityLogger(event, details);
    }
  }
  
  /**
   * Reset static DOMPurify cache (useful for long-running processes)
   * This prevents memory accumulation in services that run for extended periods
   * @static
   */
  public static resetCache(): void {
    UpdateChecker.purifyWindow = null;
    UpdateChecker.purify = null;
  }
}