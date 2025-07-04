/**
 * Security-related constants and limits
 */

// Security and performance limits
export const SECURITY_LIMITS = {
  MAX_PERSONA_SIZE_BYTES: 1024 * 1024 * 2,  // 2MB max persona file size
  MAX_FILENAME_LENGTH: 255,                  // Max filename length
  MAX_PATH_DEPTH: 10,                       // Max directory depth for paths
  MAX_CONTENT_LENGTH: 500000,               // Max persona content length (500KB)
  RATE_LIMIT_REQUESTS: 100,                 // Max requests per window
  RATE_LIMIT_WINDOW_MS: 60 * 1000,         // 1 minute window
  CACHE_TTL_MS: 5 * 60 * 1000,             // 5 minute cache TTL
  MAX_SEARCH_RESULTS: 50                    // Max search results to return
};

// Input validation patterns
export const VALIDATION_PATTERNS = {
  SAFE_FILENAME: /^[a-zA-Z0-9][a-zA-Z0-9\-_.]{0,250}[a-zA-Z0-9]$/,
  SAFE_PATH: /^[a-zA-Z0-9\/\-_.]{1,500}$/,
  SAFE_USERNAME: /^[a-zA-Z0-9][a-zA-Z0-9\-_.]{0,30}[a-zA-Z0-9]$/,
  SAFE_CATEGORY: /^[a-zA-Z][a-zA-Z0-9\-_]{0,20}$/,
  SAFE_EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
};