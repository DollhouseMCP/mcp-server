/**
 * Size and limit constants for DollhouseMCP
 */

// Export/Import limits
export const MAX_PERSONA_SIZE = 100 * 1024; // 100KB per persona
export const MAX_BUNDLE_SIZE = 1024 * 1024; // 1MB for bundles
export const MAX_PERSONAS_PER_BUNDLE = 50; // Maximum personas in a single bundle

// GitHub API limits
export const GITHUB_API_RATE_LIMIT = 60; // Requests per hour for unauthenticated
export const GITHUB_API_RATE_LIMIT_AUTH = 5000; // Requests per hour for authenticated

// URL limits
export const MAX_URL_LENGTH = 2048; // Maximum URL length for safety