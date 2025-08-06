/**
 * Shared utilities for search functionality
 */

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
  // Security: Limit input length to prevent DoS attacks
  if (term.length > maxLength) {
    throw new Error(`Search term exceeds maximum length of ${maxLength} characters`);
  }
  
  return term.toLowerCase()
    .replace(/[-_\s]+/g, ' ')  // Convert dashes, underscores to spaces
    .replace(/\.md$/, '')       // Remove .md extension
    .trim();
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
  
  if (query.length > maxLength) {
    throw new Error(`Search query exceeds maximum length of ${maxLength} characters`);
  }
  
  // Check for potential injection patterns (basic validation)
  const dangerousPatterns = [
    /[\x00-\x1F\x7F]/,  // Control characters
    /[<>]/,             // Potential HTML/XML injection
  ];
  
  for (const pattern of dangerousPatterns) {
    if (pattern.test(query)) {
      throw new Error('Search query contains invalid characters');
    }
  }
  
  return true;
}