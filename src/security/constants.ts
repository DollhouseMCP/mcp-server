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
  MAX_SEARCH_RESULTS: 50,                   // Max search results to return
  MAX_BATCH_OPERATIONS: 50,                 // Max operations per batch request (Issue #221/#543)

  // YAML bomb detection threshold (SECURITY FIX #1298)
  // Maximum allowed alias-to-anchor amplification ratio
  // Set to 5:1 - balances security (early DoS detection) with usability (legitimate YAML patterns)
  // Rationale: Most legitimate YAML uses ≤3× amplification; 5× provides safety margin
  // while blocking exponential expansion attacks that typically start at 10×+
  YAML_BOMB_AMPLIFICATION_THRESHOLD: 5
};

// Input validation patterns
export const VALIDATION_PATTERNS = {
  SAFE_FILENAME: /^[a-zA-Z0-9][a-zA-Z0-9\-_.]{0,250}[a-zA-Z0-9]$/,
  SAFE_PATH: /^[a-zA-Z0-9:/\-_.~]{1,500}$/,
  SAFE_USERNAME: /^[a-zA-Z0-9][a-zA-Z0-9\-_.]{0,30}[a-zA-Z0-9]$/,
  SAFE_CATEGORY: /^[a-zA-Z][a-zA-Z0-9\-_]{0,20}$/,
  SAFE_EMAIL: /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{1,63}$/,  // RFC 5321 compliant limits

  // Field-appropriate patterns for sanitize-then-validate approach
  // These patterns validate AFTER sanitization, so they allow legitimate characters

  // For names: allow letters (including accented Latin), numbers, spaces, and basic punctuation
  // Uses Unicode property escapes for proper international support
  SAFE_NAME: /^[\p{L}\p{N}\s\-_.]+$/u,

  // For descriptions: allow more punctuation for readability
  // Includes em-dash (—), en-dash (–), and forward slash (/) which appear in real-world portfolio elements
  SAFE_DESCRIPTION: /^[\p{L}\p{N}\s\-_.,!?'":;()\[\]\u2013\u2014/]+$/u,

  // For content: most permissive - ContentValidator handles security threats
  // This allows essentially anything since content validation is separate
  SAFE_CONTENT: /^[\s\S]*$/,

  // For filenames in create operations: strict ASCII only (different from SAFE_FILENAME which has length limits)
  SAFE_FILENAME_CREATE: /^[a-zA-Z0-9\-_.]+$/
};

/**
 * Human-readable descriptions for each validation pattern.
 * Used by ValidationService to produce actionable error messages.
 *
 * - `allowed`: short description of the character set
 * - `charTest`: single-character regex to identify which chars are invalid
 * - `structural` (optional): extra constraint not captured by charTest
 */
export const PATTERN_DESCRIPTIONS: Record<string, {
  allowed: string;
  charTest: RegExp;
  structural?: string;
}> = {
  SAFE_NAME: {
    allowed: 'letters, numbers, spaces, hyphens, underscores, dots',
    charTest: /^[\p{L}\p{N}\s\-_.]$/u,
  },
  SAFE_DESCRIPTION: {
    allowed: 'letters, numbers, spaces, hyphens, underscores, dots, common punctuation, em-dash, en-dash, and forward slash',
    charTest: /^[\p{L}\p{N}\s\-_.,!?'":;()\[\]\u2013\u2014/]$/u,
  },
  SAFE_CONTENT: {
    allowed: 'any characters',
    charTest: /^[\s\S]$/,
  },
  SAFE_FILENAME_CREATE: {
    allowed: 'letters, numbers, hyphens, underscores, dots',
    charTest: /^[a-zA-Z0-9\-_.]$/,
  },
  SAFE_FILENAME: {
    allowed: 'letters, numbers, hyphens, underscores, dots',
    charTest: /^[a-zA-Z0-9\-_.]$/,
    structural: 'must start and end with alphanumeric (max 252 chars)',
  },
  SAFE_PATH: {
    allowed: 'letters, numbers, colons, slashes, hyphens, underscores, dots, tildes',
    charTest: /^[a-zA-Z0-9:/\-_.~]$/,
  },
  SAFE_USERNAME: {
    allowed: 'letters, numbers, hyphens, underscores, dots',
    charTest: /^[a-zA-Z0-9\-_.]$/,
    structural: 'must start and end with alphanumeric (3-32 chars)',
  },
  SAFE_CATEGORY: {
    allowed: 'letters, numbers, hyphens, underscores',
    charTest: /^[a-zA-Z0-9\-_]$/,
    structural: 'must start with a letter (max 21 chars)',
  },
  SAFE_EMAIL: {
    allowed: 'letters, numbers, dots, hyphens, underscores, @',
    charTest: /^[^\s@]$/,
  },
};
