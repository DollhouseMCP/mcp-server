/**
 * Security-related constants and limits
 */

// Security and performance limits
export const SECURITY_LIMITS = {
  MAX_PERSONA_SIZE_BYTES: 1024 * 1024 * 2,  // 2MB max persona file size
  MAX_FILENAME_LENGTH: 255,                  // Max filename length
  MAX_PATH_DEPTH: 10,                       // Max directory depth for paths
  MAX_CONTENT_LENGTH: 500000,               // Max element content length (500KB, ~1-5ms regex scan)
  MAX_YAML_LENGTH: 64 * 1024,               // Max YAML frontmatter length (64KB)
  MAX_METADATA_FIELD_LENGTH: 1024,          // Max individual metadata field length (1KB)
  MAX_FILE_SIZE: 1024 * 1024 * 2,          // Max file size (2MB)
  RATE_LIMIT_REQUESTS: 100,                 // Max requests per window
  RATE_LIMIT_WINDOW_MS: 60 * 1000,         // 1 minute window
  CACHE_TTL_MS: 5 * 60 * 1000,             // 5 minute cache TTL
  MAX_SEARCH_RESULTS: 50,                   // Max search results to return
  MAX_BATCH_OPERATIONS: 50,                 // Max operations per batch request (Issue #221/#543)

  // Field-level validation limits — used across element managers and validators.
  // Centralized here so a single change applies everywhere and grep finds all usages.
  MAX_NAME_LENGTH: 100,                     // Element name field
  MAX_ENUM_FIELD_LENGTH: 20,                // Short enum-like fields (strategy, role, activation)
  MAX_TAG_LENGTH: 50,                       // Individual tag / category values
  MAX_COMMAND_ARG_LENGTH: 1000,             // CLI command argument validation

  // Regex validation — content length caps per pattern complexity tier.
  // These are the defaults used by RegexValidator when no explicit maxLength is passed.
  // Low/medium are safe at MAX_CONTENT_LENGTH because they're O(n) linear time.
  // High-complexity patterns (nested quantifiers, ReDoS risk) are hard-capped at 1KB.
  MAX_REGEX_INPUT_LENGTH: 10000,            // SafeRegex default for user-supplied patterns

  // YAML bomb detection threshold (SECURITY FIX #1298)
  // Maximum allowed alias-to-anchor amplification ratio
  // Set to 5:1 - balances security (early DoS detection) with usability (legitimate YAML patterns)
  // Rationale: Most legitimate YAML uses ≤3× amplification; 5× provides safety margin
  // while blocking exponential expansion attacks that typically start at 10×+
  YAML_BOMB_AMPLIFICATION_THRESHOLD: 5
};

/** Shared severity type used across security validators (#1782-7) */
export type SecuritySeverityLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Escalate severity level — higher severity takes precedence.
 * Extracted from UnicodeValidator and InputNormalizer to eliminate duplication (#1782-7).
 */
export function escalateSeverity(
  current: SecuritySeverityLevel | undefined,
  newSeverity: SecuritySeverityLevel
): SecuritySeverityLevel {
  const levels = { low: 1, medium: 2, high: 3, critical: 4 };
  const currentLevel = current ? levels[current] : 0;
  return levels[newSeverity] > currentLevel ? newSeverity : (current || 'low');
}

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

  // For descriptions: allow broad punctuation for readability
  // Includes common symbols found in real-world portfolio descriptions:
  // #(C#/hashtags) +(C++) %(percentages) =(key=value) @(email/handles)
  // &(and) ~(approximate) *(emphasis) |(separators) {}(templates)
  // <>(angle brackets) $(currency) ^(caret) `(backtick)
  // →↔←↑↓(arrows) ✓✗(checkmarks) and other Unicode symbols
  SAFE_DESCRIPTION: /^[\p{L}\p{N}\p{P}\p{S}\s@#$%^&*+=~`|\\]+$/u,

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
    allowed: 'letters, numbers, symbols, spaces, and common punctuation',
    charTest: /^[\p{L}\p{N}\p{P}\p{S}\s@#$%^&*+=~`|\\]$/u,
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
