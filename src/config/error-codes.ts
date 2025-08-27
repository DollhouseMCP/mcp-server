/**
 * Error codes for collection submission process
 * Implements detailed error tracking as specified in Issue #785
 */

export enum CollectionErrorCode {
  // Authentication & Authorization (COLL_AUTH_xxx)
  COLL_AUTH_001 = "COLL_AUTH_001", // Token validation failed
  COLL_AUTH_002 = "COLL_AUTH_002", // Token missing 'public_repo' scope
  COLL_AUTH_003 = "COLL_AUTH_003", // OAuth helper not running
  COLL_AUTH_004 = "COLL_AUTH_004", // Token expired during operation
  
  // GitHub API Operations (COLL_API_xxx)
  COLL_API_001 = "COLL_API_001", // Rate limit exceeded
  COLL_API_002 = "COLL_API_002", // Repository not found
  COLL_API_003 = "COLL_API_003", // Issue creation failed
  COLL_API_004 = "COLL_API_004", // Network timeout
  
  // Configuration (COLL_CFG_xxx)
  COLL_CFG_001 = "COLL_CFG_001", // Auto-submit disabled
  COLL_CFG_002 = "COLL_CFG_002", // Collection repo not configured
  
  // Content Validation (COLL_VAL_xxx)
  COLL_VAL_001 = "COLL_VAL_001", // Invalid element format
  COLL_VAL_002 = "COLL_VAL_002"  // Content exceeds size limit
}

export const CollectionErrorMessages: Record<CollectionErrorCode, string> = {
  [CollectionErrorCode.COLL_AUTH_001]: "Token validation failed",
  [CollectionErrorCode.COLL_AUTH_002]: "Token missing 'public_repo' scope",
  [CollectionErrorCode.COLL_AUTH_003]: "OAuth helper not running",
  [CollectionErrorCode.COLL_AUTH_004]: "Token expired during operation",
  
  [CollectionErrorCode.COLL_API_001]: "Rate limit exceeded",
  [CollectionErrorCode.COLL_API_002]: "Repository not found",
  [CollectionErrorCode.COLL_API_003]: "Issue creation failed",
  [CollectionErrorCode.COLL_API_004]: "Network timeout",
  
  [CollectionErrorCode.COLL_CFG_001]: "Auto-submit disabled",
  [CollectionErrorCode.COLL_CFG_002]: "Collection repo not configured",
  
  [CollectionErrorCode.COLL_VAL_001]: "Invalid element format",
  [CollectionErrorCode.COLL_VAL_002]: "Content exceeds size limit"
};

export const CollectionErrorSolutions: Record<CollectionErrorCode, string> = {
  [CollectionErrorCode.COLL_AUTH_001]: "Run 'setup_github_auth' to re-authenticate",
  [CollectionErrorCode.COLL_AUTH_002]: "Re-authenticate with 'setup_github_auth' to get proper scopes",
  [CollectionErrorCode.COLL_AUTH_003]: "Run 'setup_github_auth' to restart authentication",
  [CollectionErrorCode.COLL_AUTH_004]: "Token expired. Run 'setup_github_auth' to refresh",
  
  [CollectionErrorCode.COLL_API_001]: "Wait for rate limit to reset or use a different token",
  [CollectionErrorCode.COLL_API_002]: "Verify repository exists and you have access",
  [CollectionErrorCode.COLL_API_003]: "Check GitHub status and try again",
  [CollectionErrorCode.COLL_API_004]: "Check network connection and retry",
  
  [CollectionErrorCode.COLL_CFG_001]: "Run 'configure_collection_submission autoSubmit: true'",
  [CollectionErrorCode.COLL_CFG_002]: "Check collection repository configuration",
  
  [CollectionErrorCode.COLL_VAL_001]: "Verify element has proper metadata and content",
  [CollectionErrorCode.COLL_VAL_002]: "Reduce content size to under 500KB"
};

/**
 * Format a collection error for user display
 * @param code The error code
 * @param step Current step number
 * @param totalSteps Total number of steps
 * @param details Additional error details
 */
export function formatCollectionError(
  code: CollectionErrorCode,
  step: number,
  totalSteps: number,
  details?: string
): string {
  const message = CollectionErrorMessages[code];
  const solution = CollectionErrorSolutions[code];
  
  let output = `Collection Submission Failed at Step ${step}/${totalSteps}:\n`;
  output += `Error ${code}: ${message}\n`;
  
  if (details) {
    output += `Details: ${details}\n`;
  }
  
  output += `Solution: ${solution}`;
  
  return output;
}