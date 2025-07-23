/**
 * Security-related constants and limits
 */

// Security and performance limits
export const SECURITY_LIMITS = {
  MAX_PERSONA_SIZE_BYTES: 1024 * 1024 * 2,  // 2MB max persona file size
  MAX_FILENAME_LENGTH: 255,                  // Max filename length
  MAX_PATH_DEPTH: 10,                       // Max directory depth for paths
  MAX_CONTENT_LENGTH: 500000,               // Max persona content length (500KB)
  MAX_YAML_LENGTH: 64 * 1024,               // Max YAML frontmatter length (64KB)
  MAX_METADATA_FIELD_LENGTH: 1024,          // Max individual metadata field length (1KB)
  MAX_FILE_SIZE: 1024 * 1024 * 2,          // Max file size (2MB)
  RATE_LIMIT_REQUESTS: 100,                 // Max requests per window
  RATE_LIMIT_WINDOW_MS: 60 * 1000,         // 1 minute window
  CACHE_TTL_MS: 5 * 60 * 1000,             // 5 minute cache TTL
  MAX_SEARCH_RESULTS: 50                    // Max search results to return
};

// Input validation patterns
export const VALIDATION_PATTERNS = {
  SAFE_FILENAME: /^[a-zA-Z0-9][a-zA-Z0-9\-_.]{0,250}[a-zA-Z0-9]$/,
  SAFE_PATH: /^[a-zA-Z0-9:/\-_.~]{1,500}$/,
  SAFE_USERNAME: /^[a-zA-Z0-9][a-zA-Z0-9\-_.]{0,30}[a-zA-Z0-9]$/,
  SAFE_CATEGORY: /^[a-zA-Z][a-zA-Z0-9\-_]{0,20}$/,
  SAFE_EMAIL: /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{1,63}$/  // RFC 5321 compliant limits
};