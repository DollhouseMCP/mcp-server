/**
 * Input validation and sanitization functions
 */

import * as path from 'path';
import { SECURITY_LIMITS, VALIDATION_PATTERNS } from './constants.js';
import { VALID_CATEGORIES } from '../config/constants.js';
import { RegexValidator } from './regexValidator.js';
import { ErrorHandler, ErrorCategory } from '../utils/ErrorHandler.js';
import { ValidationErrorCodes } from '../utils/errorCodes.js';

// Pre-compiled regex patterns for better performance
// These patterns are used repeatedly and benefit from pre-compilation
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/g;
const HTML_DANGEROUS_REGEX = /[<>'"&]/g;
const SHELL_METACHAR_REGEX = /[;&|`$()!\\~*?{}]/g;
const RTL_ZEROWIDTH_REGEX = /[\u202E\uFEFF]/g;
const COLLECTION_PATH_CHAR_REGEX = /[a-zA-Z0-9\/\-_.]/;
const VALID_COLLECTION_PATH_REGEX = /^[a-zA-Z0-9\/\-_.]*$/;
const IPV4_REGEX = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
const DECIMAL_IP_REGEX = /^\d{8,10}$/;
const HEX_IP_REGEX = /^0x[0-9a-f]{1,8}$/i;
const OCTAL_IP_REGEX = /^0[0-7]{8,11}$/;
const FILENAME_DANGEROUS_REGEX = /[\/\\:*?"<>|]/g;
const FILENAME_LEADING_DOTS_REGEX = /^\.+/;
const PATH_NORMALIZE_REGEX = /(^\/{1,100})|(\/{1,100}$)/g;
const PATH_MULTIPLE_SLASHES_REGEX = /\/{1,100}/g;
const URL_PLUS_DECODE_REGEX = /\+/g;

/**
 * Enhanced input validation for MCP tools
 */
export class MCPInputValidator {
  /**
   * Validate a persona identifier (name or filename)
   */
  static validatePersonaIdentifier(identifier: string): string {
    if (!identifier || typeof identifier !== 'string') {
      throw ErrorHandler.createError('Persona identifier must be a non-empty string', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_PERSONA_ID);
    }

    if (identifier.length > 100) {
      throw ErrorHandler.createError('Persona identifier too long (max 100 characters)', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_LENGTH);
    }

    // Allow persona names and filenames
    const sanitized = sanitizeInput(identifier, 100);
    if (!sanitized) {
      throw ErrorHandler.createError('Persona identifier contains only invalid characters', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_PERSONA_ID);
    }

    return sanitized;
  }

  /**
   * Validate search query for collection
   */
  static validateSearchQuery(query: string): string {
    if (!query || typeof query !== 'string') {
      throw ErrorHandler.createError('Search query must be a non-empty string', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_SEARCH_QUERY);
    }

    if (query.length < 2) {
      throw ErrorHandler.createError('Search query too short (minimum 2 characters)', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_LENGTH);
    }

    if (query.length > 200) {
      throw ErrorHandler.createError('Search query too long (max 200 characters)', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_LENGTH);
    }

    // Sanitize but preserve spaces for search
    const sanitized = query
      .replace(CONTROL_CHARS_REGEX, '') // Remove control characters
      .replace(HTML_DANGEROUS_REGEX, '') // Remove HTML-dangerous characters
      .replace(SHELL_METACHAR_REGEX, '') // Remove shell metacharacters (expanded)
      .replace(RTL_ZEROWIDTH_REGEX, '') // Remove RTL override and zero-width chars
      .trim();

    if (!sanitized) {
      throw ErrorHandler.createError('Search query contains only invalid characters', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_SEARCH_QUERY);
    }

    return sanitized;
  }

  /**
   * Validate collection path
   */
  static validateCollectionPath(path: string): string {
    if (!path || typeof path !== 'string') {
      throw ErrorHandler.createError('Collection path must be a non-empty string', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_COLLECTION_PATH);
    }

    if (path.length > 500) {
      throw ErrorHandler.createError('Collection path too long (max 500 characters)', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_LENGTH);
    }

    // GitHub API paths should be safe filename patterns
    // Use single regex test for better performance (avoids O(n) character-by-character check)
    if (!VALID_COLLECTION_PATH_REGEX.test(path)) {
      // Only do character-by-character check if validation fails, to provide detailed error message
      for (let i = 0; i < path.length; i++) {
        const char = path[i];
        if (!COLLECTION_PATH_CHAR_REGEX.test(char)) {
          throw ErrorHandler.createError(`Invalid character '${char}' in collection path at position ${i + 1}`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_CHARACTER);
        }
      }
      // Fallback error if we somehow don't find the invalid character
      throw ErrorHandler.createError('Invalid characters in collection path', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_COLLECTION_PATH);
    }

    // Prevent path traversal in GitHub paths (comprehensive check)
    const pathLower = path.toLowerCase();
    const encodedPath = decodeURIComponent(path.replace(URL_PLUS_DECODE_REGEX, ' ')); // Decode URL encoding
    
    // Check for various path traversal patterns
    const traversalPatterns = [
      '..',          // Basic traversal
      './',          // Current directory
      '/../',        // Directory traversal with slashes
      '\\',          // Backslash (Windows-style)
      '%2e%2e',      // URL-encoded ..
      '%2e%2e%2f',   // URL-encoded ../
      '%2e%2e%5c',   // URL-encoded ..\
      '%252e%252e',  // Double URL-encoded ..
      '..%2f',       // Mixed encoding
      '..%5c',       // Mixed encoding with backslash
      '..../',       // Dotdot bypass attempt
      '..;/',        // Semicolon bypass attempt
    ];
    
    for (const pattern of traversalPatterns) {
      if (pathLower.includes(pattern) || encodedPath.toLowerCase().includes(pattern)) {
        throw ErrorHandler.createError('Path traversal not allowed in collection path', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.PATH_TRAVERSAL);
      }
    }

    return path;
  }

  /**
   * Validate URL for import operations
   */
  static validateImportUrl(url: string): string {
    if (!url || typeof url !== 'string') {
      throw ErrorHandler.createError('URL must be a non-empty string', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_URL);
    }

    if (url.length > 2000) {
      throw ErrorHandler.createError('URL too long (max 2000 characters)', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_LENGTH);
    }

    // Reject protocol-relative URLs that could bypass validation
    if (url.startsWith('//')) {
      throw ErrorHandler.createError('Protocol-relative URLs are not allowed', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_URL);
    }

    try {
      // Decode URL to prevent encoding-based bypasses
      let decodedUrl = url;
      try {
        decodedUrl = decodeURIComponent(url);
      } catch {
        // If decoding fails, use original URL
      }
      
      const parsed = new URL(decodedUrl);
      
      // Protocol validation
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw ErrorHandler.createError('Only HTTP(S) URLs are allowed', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_URL);
      }
      
      // Enhanced SSRF protection with IDN normalization
      let hostname = parsed.hostname.toLowerCase();
      
      // Handle IDN (International Domain Names) by converting to ASCII
      try {
        const idnNormalized = new URL(`http://${hostname}`).hostname;
        hostname = idnNormalized;
      } catch (idnError) {
        // If IDN conversion fails, reject the URL for security
        throw ErrorHandler.createError('Invalid hostname: IDN conversion failed - potentially malicious domain name', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_URL);
      }
      
      // Check for private IPs (now with IDN-normalized hostname)
      if (this.isPrivateIP(hostname)) {
        throw ErrorHandler.createError('Private network URLs are not allowed', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_URL);
      }
      
      // Additional SSRF checks for encoded IPs
      if (this.isEncodedPrivateIP(hostname)) {
        throw ErrorHandler.createError('Encoded private network URLs are not allowed', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_URL);
      }

      return url;
    } catch (error) {
      if (error instanceof Error && (error.message.includes('Private network') || error.message.includes('Encoded private'))) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw ErrorHandler.createError(`Invalid URL format: ${errorMessage}`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_URL);
    }
  }

  /**
   * Validate expiry days for sharing
   */
  static validateExpiryDays(days: number): number {
    if (typeof days !== 'number') {
      throw ErrorHandler.createError('Expiry days must be a valid number', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_NUMBER);
    }
    
    if (isNaN(days) || !isFinite(days)) {
      throw ErrorHandler.createError('Expiry days must be a valid number', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_NUMBER);
    }

    if (days < 1 || days > 365) {
      throw ErrorHandler.createError('Expiry days must be between 1 and 365', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_RANGE);
    }

    return Math.floor(days);
  }

  /**
   * Validate boolean confirmation parameters
   */
  static validateConfirmation(confirm: boolean, operationName: string): boolean {
    if (typeof confirm !== 'boolean') {
      throw ErrorHandler.createError(`${operationName} confirmation must be a boolean value`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_TYPE);
    }

    if (!confirm) {
      throw ErrorHandler.createError(`${operationName} operation requires explicit confirmation (true)`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.CONFIRMATION_REQUIRED);
    }

    return confirm;
  }

  /**
   * Validate field name for edit operations
   */
  static validateEditField(field: string): string {
    if (!field || typeof field !== 'string') {
      throw ErrorHandler.createError('Field name must be a non-empty string', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.REQUIRED_FIELD);
    }

    const validFields = [
      'name', 'description', 'category', 'instructions', 
      'triggers', 'version', 'author', 'tags'
    ];

    const normalizedField = field.toLowerCase().trim();
    if (!validFields.includes(normalizedField)) {
      throw ErrorHandler.createError(`Invalid field name. Must be one of: ${validFields.join(', ')}`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_INPUT);
    }

    return normalizedField;
  }

  /**
   * Check if hostname is a private IP address (IPv4 and IPv6)
   */
  private static isPrivateIP(hostname: string): boolean {
    // Check for localhost variations
    if (['localhost', '127.0.0.1', '::1'].includes(hostname)) {
      return true;
    }

    // Check for private IPv4 ranges
    const ipv4Match = hostname.match(IPV4_REGEX);
    
    if (ipv4Match) {
      const [, a, b, c, d] = ipv4Match.map(Number);
      
      // 10.0.0.0/8
      if (a === 10) return true;
      
      // 172.16.0.0/12
      if (a === 172 && b >= 16 && b <= 31) return true;
      
      // 192.168.0.0/16
      if (a === 192 && b === 168) return true;
      
      // 169.254.0.0/16 (link-local)
      if (a === 169 && b === 254) return true;
    }

    // Check for private IPv6 ranges
    const ipv6Lower = hostname.toLowerCase();
    
    // fc00::/7 - Unique Local Addresses (ULA)
    if (ipv6Lower.startsWith('fc') || ipv6Lower.startsWith('fd')) {
      return true;
    }
    
    // fe80::/10 - Link-Local Addresses
    // IPv6 link-local addresses are fe80::/10, meaning the valid range is fe80 through febf
    const fe80Range = parseInt(ipv6Lower.substring(0, 4), 16);
    if (fe80Range >= 0xfe80 && fe80Range <= 0xfebf) {
      return true;
    }
    
    // Additional IPv6 localhost formats
    if (['::1', '0:0:0:0:0:0:0:1'].includes(ipv6Lower)) {
      return true;
    }

    return false;
  }

  /**
   * Check for encoded private IP addresses that could bypass basic detection
   */
  private static isEncodedPrivateIP(hostname: string): boolean {
    // Check for decimal encoded IPs (e.g., 2130706433 = 127.0.0.1)
    if (DECIMAL_IP_REGEX.test(hostname)) {
      const num = parseInt(hostname, 10);
      if (num >= 0 && num <= 4294967295) { // Valid IPv4 range
        // Convert to IP format and check if private
        const ip = [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
        return this.isPrivateIP(ip);
      }
    }
    
    // Check for hex encoded IPs (e.g., 0x7f000001 = 127.0.0.1)
    if (HEX_IP_REGEX.test(hostname)) {
      const num = parseInt(hostname, 16);
      if (num >= 0 && num <= 4294967295) {
        const ip = [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
        return this.isPrivateIP(ip);
      }
    }
    
    // Check for octal encoded IPs (e.g., 017700000001 = 127.0.0.1)
    if (OCTAL_IP_REGEX.test(hostname)) {
      const num = parseInt(hostname, 8);
      if (num >= 0 && num <= 4294967295) {
        const ip = [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
        return this.isPrivateIP(ip);
      }
    }
    
    return false;
  }
}

/**
 * Validate and sanitize a filename
 */
export function validateFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') {
    throw ErrorHandler.createError('Filename must be a non-empty string', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_FILENAME);
  }
  
  if (filename.length > SECURITY_LIMITS.MAX_FILENAME_LENGTH) {
    throw ErrorHandler.createError(`Filename too long (max ${SECURITY_LIMITS.MAX_FILENAME_LENGTH} characters)`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_LENGTH);
  }
  
  // Remove any path separators and dangerous characters
  const sanitized = filename.replace(FILENAME_DANGEROUS_REGEX, '').replace(FILENAME_LEADING_DOTS_REGEX, '');
  
  if (!RegexValidator.validate(sanitized, VALIDATION_PATTERNS.SAFE_FILENAME, { maxLength: SECURITY_LIMITS.MAX_FILENAME_LENGTH })) {
    throw ErrorHandler.createError('Invalid filename format. Use alphanumeric characters, hyphens, underscores, and dots only.', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_FILENAME);
  }
  
  return sanitized;
}

/**
 * Validate and sanitize a path
 */
export function validatePath(inputPath: string, baseDir?: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw ErrorHandler.createError('Path must be a non-empty string', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_PATH);
  }
  
  // If baseDir is provided and inputPath is absolute, reject it
  // Check both Unix-style and Windows-style absolute paths for cross-platform security
  const isUnixAbsolute = path.isAbsolute(inputPath);
  const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(inputPath);
  
  if (baseDir && (isUnixAbsolute || isWindowsAbsolute)) {
    throw ErrorHandler.createError('Absolute paths not allowed when base directory is specified', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_PATH);
  }
  
  // Remove leading/trailing slashes and normalize
  // Length limits added to prevent ReDoS attacks
  // WINDOWS FIX: Convert backslashes to forward slashes for cross-platform compatibility
  let normalized = inputPath.replace(/\\/g, '/');
  
  // FIX: Preserve leading slash for absolute paths
  const isAbsolute = normalized.startsWith('/') || isWindowsAbsolute;
  
  // Remove trailing slashes and normalize multiple slashes
  normalized = normalized.replace(/\/{1,100}$/g, '').replace(/\/{2,100}/g, '/');
  
  // Preserve the leading slash if it was an absolute path
  if (isAbsolute && !normalized.startsWith('/') && !isWindowsAbsolute) {
    normalized = '/' + normalized;
  }
  
  if (!VALIDATION_PATTERNS.SAFE_PATH.test(normalized)) {
    throw ErrorHandler.createError('Invalid path format. Use alphanumeric characters, hyphens, underscores, dots, and forward slashes only.', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_PATH);
  }
  
  // Check for path traversal attempts
  if (normalized.includes('..') || normalized.includes('./') || normalized.includes('/.')) {
    throw ErrorHandler.createError('Path traversal not allowed', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.PATH_TRAVERSAL);
  }
  
  // Validate path depth
  const depth = normalized.split('/').length;
  if (depth > SECURITY_LIMITS.MAX_PATH_DEPTH) {
    throw ErrorHandler.createError(`Path too deep (max ${SECURITY_LIMITS.MAX_PATH_DEPTH} levels)`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_PATH);
  }
  
  // If baseDir provided, ensure path is within it
  if (baseDir) {
    const resolvedPath = path.resolve(baseDir, normalized);
    const resolvedBase = path.resolve(baseDir);
    
    if (!resolvedPath.startsWith(resolvedBase)) {
      throw ErrorHandler.createError('Path traversal attempt detected', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.PATH_TRAVERSAL);
    }
  }
  
  return normalized;
}

/**
 * Validate and sanitize a username
 */
export function validateUsername(username: string): string {
  if (!username || typeof username !== 'string') {
    throw ErrorHandler.createError('Username must be a non-empty string', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.REQUIRED_FIELD);
  }
  
  if (!VALIDATION_PATTERNS.SAFE_USERNAME.test(username)) {
    throw ErrorHandler.createError('Invalid username format. Use alphanumeric characters, hyphens, underscores, and dots only.', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_FORMAT);
  }
  
  return username.toLowerCase();
}

/**
 * Validate a category
 */
export function validateCategory(category: string): string {
  if (!category || typeof category !== 'string') {
    throw ErrorHandler.createError('Category must be a non-empty string', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_CATEGORY);
  }
  
  if (!RegexValidator.validate(category, VALIDATION_PATTERNS.SAFE_CATEGORY, { maxLength: 50 })) {
    throw ErrorHandler.createError('Invalid category format. Use alphabetic characters, hyphens, and underscores only.', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_CATEGORY);
  }
  
  const normalized = category.toLowerCase();
  
  if (!VALID_CATEGORIES.includes(normalized)) {
    throw ErrorHandler.createError(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.INVALID_CATEGORY);
  }
  
  return normalized;
}

/**
 * Validate content size
 */
export function validateContentSize(content: string, maxSize: number = SECURITY_LIMITS.MAX_CONTENT_LENGTH): void {
  if (!content || typeof content !== 'string') {
    throw ErrorHandler.createError('Content must be a non-empty string', ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.REQUIRED_FIELD);
  }
  
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  if (sizeBytes > maxSize) {
    throw ErrorHandler.createError(`Content too large (${sizeBytes} bytes, max ${maxSize} bytes)`, ErrorCategory.VALIDATION_ERROR, ValidationErrorCodes.CONTENT_TOO_LARGE);
  }
}

/**
 * Comprehensive input validation before pattern matching
 * Validates all content types with appropriate limits
 */
export interface ContentValidationOptions {
  maxContentLength?: number;
  maxYamlLength?: number;
  maxMetadataFieldLength?: number;
  maxFileSize?: number;
}

export function validateInputLengths(
  content: string,
  contentType: 'full' | 'yaml' | 'metadata' | 'field',
  options: ContentValidationOptions = {}
): void {
  const limits = {
    maxContentLength: options.maxContentLength ?? SECURITY_LIMITS.MAX_CONTENT_LENGTH,
    maxYamlLength: options.maxYamlLength ?? SECURITY_LIMITS.MAX_YAML_LENGTH,
    maxMetadataFieldLength: options.maxMetadataFieldLength ?? SECURITY_LIMITS.MAX_METADATA_FIELD_LENGTH,
    maxFileSize: options.maxFileSize ?? SECURITY_LIMITS.MAX_FILE_SIZE
  };

  // Validate based on content type
  switch (contentType) {
    case 'full':
      if (content.length > limits.maxContentLength) {
        throw ErrorHandler.createError(
          `Content exceeds maximum length of ${limits.maxContentLength} characters (${content.length} provided)`,
          ErrorCategory.VALIDATION_ERROR,
          ValidationErrorCodes.CONTENT_TOO_LARGE
        );
      }
      break;
    
    case 'yaml':
      if (content.length > limits.maxYamlLength) {
        throw ErrorHandler.createError(
          `YAML content exceeds maximum length of ${limits.maxYamlLength} characters (${content.length} provided)`,
          ErrorCategory.VALIDATION_ERROR,
          ValidationErrorCodes.CONTENT_TOO_LARGE
        );
      }
      break;
    
    case 'metadata':
      // For metadata, check overall size
      if (content.length > limits.maxYamlLength) {
        throw ErrorHandler.createError(
          `Metadata exceeds maximum length of ${limits.maxYamlLength} characters (${content.length} provided)`,
          ErrorCategory.VALIDATION_ERROR,
          ValidationErrorCodes.CONTENT_TOO_LARGE
        );
      }
      break;
    
    case 'field':
      if (content.length > limits.maxMetadataFieldLength) {
        throw ErrorHandler.createError(
          `Field exceeds maximum length of ${limits.maxMetadataFieldLength} characters (${content.length} provided)`,
          ErrorCategory.VALIDATION_ERROR,
          ValidationErrorCodes.CONTENT_TOO_LARGE
        );
      }
      break;
  }
}

/**
 * General input sanitization
 */
export function sanitizeInput(input: string, maxLength: number = 1000): string {
  if (!input || typeof input !== 'string') {
    return '';
  }
  
  // Remove potentially dangerous characters and limit length
  return input
    .replace(CONTROL_CHARS_REGEX, '') // Remove control characters
    .replace(HTML_DANGEROUS_REGEX, '') // Remove HTML-dangerous characters
    .replace(SHELL_METACHAR_REGEX, '') // Remove shell metacharacters (expanded)
    .replace(RTL_ZEROWIDTH_REGEX, '') // Remove RTL override and zero-width chars
    .substring(0, maxLength)
    .trim();
}