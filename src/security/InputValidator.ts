/**
 * Input validation and sanitization functions
 */

import * as path from 'path';
import { SECURITY_LIMITS, VALIDATION_PATTERNS } from './constants.js';
import { VALID_CATEGORIES } from '../config/constants.js';

/**
 * Enhanced input validation for MCP tools
 */
export class MCPInputValidator {
  /**
   * Validate a persona identifier (name or filename)
   */
  static validatePersonaIdentifier(identifier: string): string {
    if (!identifier || typeof identifier !== 'string') {
      throw new Error('Persona identifier must be a non-empty string');
    }

    if (identifier.length > 100) {
      throw new Error('Persona identifier too long (max 100 characters)');
    }

    // Allow persona names and filenames
    const sanitized = sanitizeInput(identifier, 100);
    if (!sanitized) {
      throw new Error('Persona identifier contains only invalid characters');
    }

    return sanitized;
  }

  /**
   * Validate search query for marketplace
   */
  static validateSearchQuery(query: string): string {
    if (!query || typeof query !== 'string') {
      throw new Error('Search query must be a non-empty string');
    }

    if (query.length < 2) {
      throw new Error('Search query too short (minimum 2 characters)');
    }

    if (query.length > 200) {
      throw new Error('Search query too long (max 200 characters)');
    }

    // Sanitize but preserve spaces for search
    const sanitized = query
      .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
      .replace(/[<>'"&]/g, '') // Remove HTML-dangerous characters
      .replace(/[;&|`$()]/g, '') // Remove shell metacharacters
      .replace(/[\u202E\uFEFF]/g, '') // Remove RTL override and zero-width chars
      .trim();

    if (!sanitized) {
      throw new Error('Search query contains only invalid characters');
    }

    return sanitized;
  }

  /**
   * Validate marketplace path
   */
  static validateMarketplacePath(path: string): string {
    if (!path || typeof path !== 'string') {
      throw new Error('Marketplace path must be a non-empty string');
    }

    if (path.length > 500) {
      throw new Error('Marketplace path too long (max 500 characters)');
    }

    // GitHub API paths should be safe filename patterns
    if (!/^[a-zA-Z0-9\/\-_.]{1,500}$/.test(path)) {
      throw new Error('Invalid marketplace path format');
    }

    // Prevent path traversal in GitHub paths
    if (path.includes('..') || path.includes('./')) {
      throw new Error('Path traversal not allowed in marketplace path');
    }

    return path;
  }

  /**
   * Validate URL for import operations
   */
  static validateImportUrl(url: string): string {
    if (!url || typeof url !== 'string') {
      throw new Error('URL must be a non-empty string');
    }

    if (url.length > 2000) {
      throw new Error('URL too long (max 2000 characters)');
    }

    try {
      const parsed = new URL(url);
      
      // Protocol validation
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only HTTP(S) URLs are allowed');
      }
      
      // Basic SSRF protection - check for private IPs
      const hostname = parsed.hostname.toLowerCase();
      if (this.isPrivateIP(hostname)) {
        throw new Error('Private network URLs are not allowed');
      }

      return url;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Private network')) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Invalid URL format: ${errorMessage}`);
    }
  }

  /**
   * Validate expiry days for sharing
   */
  static validateExpiryDays(days: number): number {
    if (typeof days !== 'number') {
      throw new Error('Expiry days must be a valid number');
    }
    
    if (isNaN(days) || !isFinite(days)) {
      throw new Error('Expiry days must be a valid number');
    }

    if (days < 1 || days > 365) {
      throw new Error('Expiry days must be between 1 and 365');
    }

    return Math.floor(days);
  }

  /**
   * Validate boolean confirmation parameters
   */
  static validateConfirmation(confirm: boolean, operationName: string): boolean {
    if (typeof confirm !== 'boolean') {
      throw new Error(`${operationName} confirmation must be a boolean value`);
    }

    if (!confirm) {
      throw new Error(`${operationName} operation requires explicit confirmation (true)`);
    }

    return confirm;
  }

  /**
   * Validate field name for edit operations
   */
  static validateEditField(field: string): string {
    if (!field || typeof field !== 'string') {
      throw new Error('Field name must be a non-empty string');
    }

    const validFields = [
      'name', 'description', 'category', 'instructions', 
      'triggers', 'version', 'author', 'tags'
    ];

    const normalizedField = field.toLowerCase().trim();
    if (!validFields.includes(normalizedField)) {
      throw new Error(`Invalid field name. Must be one of: ${validFields.join(', ')}`);
    }

    return normalizedField;
  }

  /**
   * Check if hostname is a private IP address
   */
  private static isPrivateIP(hostname: string): boolean {
    // Check for localhost variations
    if (['localhost', '127.0.0.1', '::1'].includes(hostname)) {
      return true;
    }

    // Check for private IPv4 ranges
    const ipv4Regex = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
    const ipv4Match = hostname.match(ipv4Regex);
    
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

    return false;
  }
}

/**
 * Validate and sanitize a filename
 */
export function validateFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Filename must be a non-empty string');
  }
  
  if (filename.length > SECURITY_LIMITS.MAX_FILENAME_LENGTH) {
    throw new Error(`Filename too long (max ${SECURITY_LIMITS.MAX_FILENAME_LENGTH} characters)`);
  }
  
  // Remove any path separators and dangerous characters
  const sanitized = filename.replace(/[\/\\:*?"<>|]/g, '').replace(/^\.+/, '');
  
  if (!VALIDATION_PATTERNS.SAFE_FILENAME.test(sanitized)) {
    throw new Error('Invalid filename format. Use alphanumeric characters, hyphens, underscores, and dots only.');
  }
  
  return sanitized;
}

/**
 * Validate and sanitize a path
 */
export function validatePath(inputPath: string, baseDir?: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Path must be a non-empty string');
  }
  
  // If baseDir is provided and inputPath is absolute, reject it
  if (baseDir && path.isAbsolute(inputPath)) {
    throw new Error('Absolute paths not allowed when base directory is specified');
  }
  
  // Remove leading/trailing slashes and normalize
  // Length limits added to prevent ReDoS attacks
  const normalized = inputPath.replace(/^\/{1,100}|\/{1,100}$/g, '').replace(/\/{1,100}/g, '/');
  
  if (!VALIDATION_PATTERNS.SAFE_PATH.test(normalized)) {
    throw new Error('Invalid path format. Use alphanumeric characters, hyphens, underscores, dots, and forward slashes only.');
  }
  
  // Check for path traversal attempts
  if (normalized.includes('..') || normalized.includes('./') || normalized.includes('/.')) {
    throw new Error('Path traversal not allowed');
  }
  
  // Validate path depth
  const depth = normalized.split('/').length;
  if (depth > SECURITY_LIMITS.MAX_PATH_DEPTH) {
    throw new Error(`Path too deep (max ${SECURITY_LIMITS.MAX_PATH_DEPTH} levels)`);
  }
  
  // If baseDir provided, ensure path is within it
  if (baseDir) {
    const resolvedPath = path.resolve(baseDir, normalized);
    const resolvedBase = path.resolve(baseDir);
    
    if (!resolvedPath.startsWith(resolvedBase)) {
      throw new Error('Path traversal attempt detected');
    }
  }
  
  return normalized;
}

/**
 * Validate and sanitize a username
 */
export function validateUsername(username: string): string {
  if (!username || typeof username !== 'string') {
    throw new Error('Username must be a non-empty string');
  }
  
  if (!VALIDATION_PATTERNS.SAFE_USERNAME.test(username)) {
    throw new Error('Invalid username format. Use alphanumeric characters, hyphens, underscores, and dots only.');
  }
  
  return username.toLowerCase();
}

/**
 * Validate a category
 */
export function validateCategory(category: string): string {
  if (!category || typeof category !== 'string') {
    throw new Error('Category must be a non-empty string');
  }
  
  if (!VALIDATION_PATTERNS.SAFE_CATEGORY.test(category)) {
    throw new Error('Invalid category format. Use alphabetic characters, hyphens, and underscores only.');
  }
  
  const normalized = category.toLowerCase();
  
  if (!VALID_CATEGORIES.includes(normalized)) {
    throw new Error(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }
  
  return normalized;
}

/**
 * Validate content size
 */
export function validateContentSize(content: string, maxSize: number = SECURITY_LIMITS.MAX_CONTENT_LENGTH): void {
  if (!content || typeof content !== 'string') {
    throw new Error('Content must be a non-empty string');
  }
  
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  if (sizeBytes > maxSize) {
    throw new Error(`Content too large (${sizeBytes} bytes, max ${maxSize} bytes)`);
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
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .replace(/[<>'"&]/g, '') // Remove HTML-dangerous characters
    .replace(/[;&|`$()]/g, '') // Remove shell metacharacters
    .replace(/[\u202E\uFEFF]/g, '') // Remove RTL override and zero-width chars
    .substring(0, maxLength)
    .trim();
}