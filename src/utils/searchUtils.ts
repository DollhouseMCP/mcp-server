/**
 * Shared utilities for search functionality
 */

import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

/**
 * Normalize search terms for better matching
 * Handles spaces, dashes, underscores, and file extensions
 * 
 * @param term - The search term to normalize
 * @param maxLength - Maximum allowed length for the search term (default: 1000)
 * @returns Normalized search term
 * @throws Error if term exceeds maxLength
 */
export function normalizeSearchTerm(term: string, maxLength: number = 1000): string {
  // SECURITY FIX: Normalize Unicode to prevent homograph attacks
  const normalized = UnicodeValidator.normalize(term);
  const cleanTerm = normalized.normalizedContent;
  
  // Security: Limit input length to prevent DoS attacks
  if (cleanTerm.length > maxLength) {
    throw new Error(`Search term exceeds maximum length of ${maxLength} characters`);
  }
  
  return cleanTerm.toLowerCase()
    .replace(/[-_\s]+/g, ' ')  // Convert dashes, underscores to spaces
    .replace(/\.md$/, '')       // Remove .md extension
    .trim();
}

/**
 * Preserve original structure for partial matching
 * Less aggressive normalization that keeps original separators for partial searches
 * 
 * @param term - The search term to normalize
 * @param maxLength - Maximum allowed length for the search term (default: 1000)
 * @returns Normalized search term with preserved structure
 * @throws Error if term exceeds maxLength
 */
export function normalizeForPartialMatch(term: string, maxLength: number = 1000): string {
  // SECURITY FIX: Normalize Unicode to prevent homograph attacks
  const normalized = UnicodeValidator.normalize(term);
  const cleanTerm = normalized.normalizedContent;
  
  // Security: Limit input length to prevent DoS attacks
  if (cleanTerm.length > maxLength) {
    throw new Error(`Search term exceeds maximum length of ${maxLength} characters`);
  }
  
  return cleanTerm.toLowerCase()
    .replace(/\.md$/, '')       // Remove .md extension only
    .trim();
}

/**
 * Check if a search term matches a target string with multiple strategies
 * Uses both normalized matching and partial matching for better results
 * 
 * @param searchTerm - The term being searched for
 * @param targetString - The string to search in
 * @returns true if there's a match
 */
export function isSearchMatch(searchTerm: string, targetString: string): boolean {
  // Strategy 1: Exact normalized matching
  const normalizedSearch = normalizeSearchTerm(searchTerm);
  const normalizedTarget = normalizeSearchTerm(targetString);
  if (normalizedTarget.includes(normalizedSearch)) {
    return true;
  }
  
  // Strategy 2: Partial matching with preserved structure
  const partialSearch = normalizeForPartialMatch(searchTerm);
  const partialTarget = normalizeForPartialMatch(targetString);
  if (partialTarget.includes(partialSearch)) {
    return true;
  }
  
  // Strategy 3: Word-boundary matching
  const searchWords = normalizedSearch.split(/\s+/);
  const targetWords = normalizedTarget.split(/\s+/);
  return searchWords.some(searchWord => 
    targetWords.some(targetWord => targetWord.includes(searchWord))
  );
}

/**
 * Validate search query length and content
 * 
 * @param query - The search query to validate
 * @param maxLength - Maximum allowed length (default: 1000)
 * @returns true if valid
 * @throws Error with descriptive message if invalid
 */
export function validateSearchQuery(query: string, maxLength: number = 1000): boolean {
  if (!query || query.trim().length === 0) {
    throw new Error('Search query cannot be empty');
  }
  
  // SECURITY FIX: Normalize Unicode before validation
  const normalized = UnicodeValidator.normalize(query);
  const cleanQuery = normalized.normalizedContent;
  
  if (cleanQuery.length > maxLength) {
    throw new Error(`Search query exceeds maximum length of ${maxLength} characters`);
  }
  
  // Check for potential injection patterns (basic validation)
  const dangerousPatterns = [
    /[\x00-\x1F\x7F]/,  // Control characters
    /[<>]/,             // Potential HTML/XML injection
  ];
  
  for (const pattern of dangerousPatterns) {
    if (pattern.test(cleanQuery)) {
      throw new Error('Search query contains invalid characters');
    }
  }
  
  return true;
}

/**
 * Debug function to show how search terms are normalized
 * Helps troubleshoot search matching issues
 * 
 * @param originalTerm - The original search term
 * @returns Object with different normalization results
 */
export function debugNormalization(originalTerm: string) {
  return {
    original: originalTerm,
    normalized: normalizeSearchTerm(originalTerm),
    partialMatch: normalizeForPartialMatch(originalTerm)
  };
}