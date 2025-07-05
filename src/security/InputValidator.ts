/**
 * Input validation and sanitization functions
 */

import { SECURITY_LIMITS, VALIDATION_PATTERNS } from './constants.js';
import { VALID_CATEGORIES } from '../config/constants.js';

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
export function validatePath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Path must be a non-empty string');
  }
  
  // Remove leading/trailing slashes and normalize
  const normalized = inputPath.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  
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
    .substring(0, maxLength)
    .trim();
}