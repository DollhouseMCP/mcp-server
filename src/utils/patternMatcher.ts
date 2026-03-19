/**
 * Pattern Matching Utilities
 *
 * Provides glob-like pattern matching for autonomy configuration,
 * tool filtering, and other pattern-based matching needs.
 *
 * Supports:
 * - * matches any sequence of characters
 * - ? matches any single character
 *
 * @example
 * ```typescript
 * matchesPattern('deploy_prod', 'deploy_*'); // true
 * matchesPattern('deploy_prod', 'deploy_???'); // false (only 3 chars after _)
 * patternsConflict('deploy_*', 'deploy_prod'); // true
 * ```
 */

import { logger } from './logger.js';

/** Maximum allowed glob pattern length to prevent ReDoS (Issue #388) */
export const MAX_GLOB_PATTERN_LENGTH = 500;

/** Maximum allowed text length for pattern matching (Issue #388) */
export const MAX_PATTERN_MATCH_TEXT_LENGTH = 10_000;

/** LRU cache for compiled glob→regex conversions (Issue #625 Phase 4 review) */
const REGEX_CACHE_MAX = 256;
const regexCache = new Map<string, RegExp>();

/**
 * Convert a glob pattern to a RegExp (cached).
 *
 * Compiled regexes are cached in an LRU map (max 256 entries) to avoid
 * recompilation on repeated pattern matching calls.
 *
 * @param pattern - Glob pattern with * and ? wildcards
 * @returns RegExp that matches the pattern (never-matching if pattern exceeds length limit)
 */
export function globToRegex(pattern: string): RegExp {
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
    logger.warn('Glob pattern exceeds maximum length, returning never-matching regex', {
      patternLength: pattern.length,
      maxLength: MAX_GLOB_PATTERN_LENGTH,
    });
    return /(?!)/;
  }

  const cached = regexCache.get(pattern);
  if (cached) return cached;

  const patternLower = pattern.toLowerCase();

  // Convert glob pattern to regex
  const regexPattern = patternLower
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
    .replace(/\*/g, '.*') // * becomes .*
    .replace(/\?/g, '.'); // ? becomes .

  const compiled = new RegExp(`^${regexPattern}$`, 'i');

  // LRU eviction: drop oldest entry when at capacity
  if (regexCache.size >= REGEX_CACHE_MAX) {
    const oldestKey = regexCache.keys().next().value;
    if (oldestKey) regexCache.delete(oldestKey);
  }
  regexCache.set(pattern, compiled);

  return compiled;
}

/**
 * Check if text matches a glob-like pattern
 *
 * @param text - The text to match against
 * @param pattern - Glob pattern with * and ? wildcards
 * @returns true if text matches the pattern
 */
export function matchesPattern(text: string, pattern: string): boolean {
  if (text.length > MAX_PATTERN_MATCH_TEXT_LENGTH) {
    logger.warn('Text exceeds maximum length for pattern matching, returning false', {
      textLength: text.length,
      maxLength: MAX_PATTERN_MATCH_TEXT_LENGTH,
    });
    return false;
  }

  const regex = globToRegex(pattern);
  return regex.test(text);
}

/**
 * Check if two patterns could potentially conflict
 *
 * Two patterns conflict if:
 * 1. They are identical (exact match)
 * 2. One pattern could match strings that the other pattern would also match
 *
 * This is used to detect configuration conflicts like:
 * - requiresApproval: ['deploy_*'] with autoApprove: ['deploy_prod']
 *   → 'deploy_prod' matches 'deploy_*' → conflict
 *
 * @param patternA - First pattern
 * @param patternB - Second pattern
 * @returns Object with conflict status and details
 */
export function detectPatternConflict(
  patternA: string,
  patternB: string
): { conflicts: boolean; reason?: string } {
  // Exact match is always a conflict
  if (patternA.toLowerCase() === patternB.toLowerCase()) {
    return { conflicts: true, reason: 'exact match' };
  }

  // Check if patternB matches patternA (B is more specific than A)
  // e.g., patternA = 'deploy_*', patternB = 'deploy_prod'
  if (matchesPattern(patternB, patternA)) {
    return {
      conflicts: true,
      reason: `'${patternB}' matches pattern '${patternA}'`
    };
  }

  // Check if patternA matches patternB (A is more specific than B)
  // e.g., patternA = 'deploy_prod', patternB = 'deploy_*'
  if (matchesPattern(patternA, patternB)) {
    return {
      conflicts: true,
      reason: `'${patternA}' matches pattern '${patternB}'`
    };
  }

  return { conflicts: false };
}

/**
 * Find all conflicts between two sets of patterns
 *
 * @param patternsA - First set of patterns (e.g., requiresApproval)
 * @param patternsB - Second set of patterns (e.g., autoApprove)
 * @returns Array of conflict descriptions
 */
export function findPatternConflicts(
  patternsA: string[],
  patternsB: string[]
): string[] {
  const conflicts: string[] = [];

  for (const patternA of patternsA) {
    for (const patternB of patternsB) {
      const result = detectPatternConflict(patternA, patternB);
      if (result.conflicts) {
        conflicts.push(
          `Conflict between '${patternA}' and '${patternB}': ${result.reason}`
        );
      }
    }
  }

  return conflicts;
}
