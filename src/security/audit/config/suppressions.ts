/**
 * Security Audit Suppression Configuration
 * 
 * This file contains suppression rules for false positives in the security audit.
 * Each suppression should be well-documented with a clear reason.
 */

import * as path from 'path';

export interface Suppression {
  rule: string;
  file?: string;
  reason: string;
}

/**
 * Suppression cache for performance optimization
 */
class SuppressionCache {
  private cache = new Map<string, boolean>();
  private regexCache = new Map<string, RegExp>();
  
  clear(): void {
    this.cache.clear();
    this.regexCache.clear();
  }
  
  getCacheKey(ruleId: string, filePath: string): string {
    return `${ruleId}::${filePath}`;
  }
  
  get(ruleId: string, filePath: string): boolean | undefined {
    return this.cache.get(this.getCacheKey(ruleId, filePath));
  }
  
  set(ruleId: string, filePath: string, value: boolean): void {
    this.cache.set(this.getCacheKey(ruleId, filePath), value);
  }
  
  getRegex(pattern: string): RegExp | undefined {
    return this.regexCache.get(pattern);
  }
  
  setRegex(pattern: string, regex: RegExp): void {
    this.regexCache.set(pattern, regex);
  }
}

const cache = new SuppressionCache();

export const suppressions: Suppression[] = [
  // ========================================
  // SQL Injection False Positives
  // ========================================
  {
    rule: 'CWE-89-001',
    file: 'src/update/UpdateManager.ts',
    reason: 'False positive - "Update Failed" is a UI message, not SQL. The codebase does not use SQL.'
  },
  
  // ========================================
  // Test File Suppressions
  // ========================================
  {
    rule: '*',
    file: '__tests__/**/*',
    reason: 'Test files may contain intentional security patterns for testing'
  },
  {
    rule: '*',
    file: '**/*.test.ts',
    reason: 'Test files may contain intentional security patterns for testing'
  },
  {
    rule: '*',
    file: '**/*.spec.ts',
    reason: 'Test files may contain intentional security patterns for testing'
  },
  {
    rule: 'OWASP-A01-001',
    file: '__tests__/**/*',
    reason: 'Test files use fake tokens and secrets for testing security features'
  },
  {
    rule: 'CWE-89-001',
    file: '__tests__/**/*',
    reason: 'Test files contain SQL injection patterns for security testing'
  },
  {
    rule: 'OWASP-A03-002',
    file: '__tests__/**/*',
    reason: 'Test files contain command injection patterns for security testing'
  },
  {
    rule: 'OWASP-A03-003',
    file: '__tests__/**/*',
    reason: 'Test files contain path traversal patterns for security testing'
  },
  
  // ========================================
  // YAML Parsing False Positives
  // ========================================
  {
    rule: 'DMCP-SEC-005',
    file: 'src/security/yamlValidator.ts',
    reason: 'YamlValidator is the security validation layer itself - it needs direct yaml.load access'
  },
  {
    rule: 'DMCP-SEC-005',
    file: 'src/security/secureYamlParser.ts',
    reason: 'SecureYamlParser is the security wrapper that validates YAML before parsing'
  },
  {
    rule: 'DMCP-SEC-005',
    file: 'src/elements/skills/SkillManager.ts',
    reason: 'Uses yaml.load with FAILSAFE_SCHEMA and size validation - equivalent security to SecureYamlParser for raw YAML import'
  },
  
  // ========================================
  // Security Rule Definition Files
  // ========================================
  {
    rule: 'OWASP-A03-004',
    file: 'src/security/audit/rules/SecurityRules.ts',
    reason: 'This is a regex pattern definition for detecting innerHTML usage, not actual usage'
  },
  
  // ========================================
  // Persona Loading False Positives
  // ========================================
  {
    rule: 'DMCP-SEC-001',
    file: 'src/persona/PersonaLoader.ts',
    reason: 'PersonaLoader validates personas through SecureYamlParser and ContentValidator'
  },
  
  // ========================================
  // Unicode Normalization False Positives
  // ========================================
  {
    rule: 'DMCP-SEC-004',
    file: 'src/types/*.ts',
    reason: 'Type definition files do not process user input'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/types/elements/*.ts',
    reason: 'Element interface files are type definitions that do not process user input'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/errors/*.ts',
    reason: 'Error classes do not process user input'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/config/*.ts',
    reason: 'Configuration files do not process user input directly'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/constants/*.ts',
    reason: 'Constant definition files do not process user input'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/utils/version.ts',
    reason: 'Version utility only handles internal version strings, not user input'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/cache/*.ts',
    reason: 'Cache layer receives already-normalized input'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/security/**/*.ts',
    reason: 'Security modules handle validation and normalization themselves'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/index.ts',
    reason: 'Main entry point delegates to ServerSetup which normalizes all inputs'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/server/ServerSetup.ts',
    reason: 'This is where Unicode normalization is implemented for all tool inputs'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/collection/*.ts',
    reason: 'Marketplace modules receive normalized input from tool handlers'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/collection/**/*.ts',
    reason: 'Marketplace modules receive normalized input from tool handlers'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/persona/*.ts',
    reason: 'Persona modules receive normalized input from tool handlers'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/persona/**/*.ts',
    reason: 'Persona modules receive normalized input from tool handlers'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/update/*.ts',
    reason: 'Update modules receive normalized input from tool handlers'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/tools/*.ts',
    reason: 'Tool files receive normalized input from ServerSetup'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/server/types.ts',
    reason: 'Type definition file does not process user input'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/server/tools/*.ts',
    reason: 'Server tools receive normalized input from ServerSetup'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'scripts/**/*',
    reason: 'Build and utility scripts do not process user input'
  },
  
  // ========================================
  // Audit Logging False Positives
  // ========================================
  {
    rule: 'DMCP-SEC-006',
    file: 'src/types/*.ts',
    reason: 'Type definition files do not perform security operations'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/types/elements/*.ts',
    reason: 'Element interface files are type definitions that do not perform security operations'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/constants/*.ts',
    reason: 'Constant files do not perform security operations'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/config/*.ts',
    reason: 'Configuration files do not perform security operations'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/errors/*.ts',
    reason: 'Error classes are not security operations requiring audit'
  },
  {
    rule: 'DMCP-SEC-006',
    file: '**/*.json',
    reason: 'JSON files cannot contain executable code'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/security/**/*.ts',
    reason: 'Security modules are infrastructure, not operations requiring audit'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/collection/*.ts',
    reason: 'Marketplace operations are not security-sensitive requiring audit'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/collection/**/*.ts',
    reason: 'Marketplace operations are not security-sensitive requiring audit'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/persona/*.ts',
    reason: 'Persona operations are validated at entry point, not security operations'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/persona/**/*.ts',
    reason: 'Persona operations are validated at entry point, not security operations'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/server/tools/**/*.ts',
    reason: 'Tool implementations delegate to services that handle security'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/index.ts',
    reason: 'Main entry point delegates security operations to specialized modules'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/utils/*.ts',
    reason: 'Utility functions are not security operations requiring audit'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/update/**/*.ts',
    reason: 'Update system has its own logging and is not a direct security operation'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/server/types.ts',
    reason: 'Type definition file does not perform operations'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'scripts/**/*',
    reason: 'Build scripts do not perform runtime security operations'
  },
  
  // ========================================
  // Coverage Report Files
  // ========================================
  {
    rule: '*',
    file: 'test/coverage/**/*',
    reason: 'Coverage report files are auto-generated and not part of the application code'
  },
  {
    rule: '*',
    file: '**/lcov-report/**/*',
    reason: 'LCOV coverage report files are auto-generated and not part of the application code'
  },
  
  // ========================================
  // Documentation and Non-Code Files
  // ========================================
  {
    rule: '*',
    file: '**/*.md',
    reason: 'Markdown documentation files'
  },
  {
    rule: '*',
    file: 'LICENSE',
    reason: 'License file'
  },
  {
    rule: '*',
    file: '.gitignore',
    reason: 'Git configuration file'
  },
  {
    rule: '*',
    file: 'package-lock.json',
    reason: 'NPM lock file - auto-generated, no user input processing'
  },
  {
    rule: '*',
    file: '**/*.yml',
    reason: 'YAML configuration files are data, not code'
  },
  {
    rule: '*',
    file: '**/*.yaml',
    reason: 'YAML configuration files are data, not code'
  }
];

/**
 * Validate suppression configuration at startup
 */
export function validateSuppressions(): string[] {
  const errors: string[] = [];
  const seenPatterns = new Set<string>();
  
  for (const suppression of suppressions) {
    // Check for empty reasons
    if (!suppression.reason || suppression.reason.trim().length < 10) {
      errors.push(`Suppression for ${suppression.rule} has insufficient reason`);
    }
    
    // Check for valid rule patterns
    const rulePattern = /^(DMCP-SEC-\d{3}|OWASP-[A-Z]\d{2}-\d{3}|CWE-\d+-\d{3}|\*)$/;
    if (!suppression.rule.match(rulePattern)) {
      errors.push(`Invalid rule pattern: ${suppression.rule}`);
    }
    
    // Check for duplicate suppressions
    const key = `${suppression.rule}:${suppression.file || '*'}`;
    if (seenPatterns.has(key)) {
      errors.push(`Duplicate suppression: ${key}`);
    }
    seenPatterns.add(key);
    
    // Validate glob patterns
    if (suppression.file?.includes('**') && !suppression.file.includes('**/')) {
      errors.push(`Invalid glob pattern in ${suppression.file} - ** must be followed by /`);
    }
  }
  
  return errors;
}

/**
 * Convert glob pattern to regex pattern safely
 * Using a proper glob-to-regex conversion that handles all edge cases
 */
function globToRegex(glob: string): RegExp {
  // Check cache first
  const cached = cache.getRegex(glob);
  if (cached) return cached;
  
  // Special case: if glob starts with *, it should match anything at the beginning
  let processedGlob = glob;
  let prefix = '';
  if (glob.startsWith('*') && !glob.startsWith('**')) {
    prefix = '(?:.*/)?';  // Optional path prefix
    processedGlob = glob.substring(1);
  }
  
  // Escape all regex special characters except * and /
  // Fixed: Properly escape backslashes and other special regex characters
  let pattern = processedGlob.replace(/[\\^$.()+?{}[\]|]/g, '\\$&');
  
  // Handle glob patterns in correct order
  // Replace ** before * to avoid conflicts
  pattern = pattern
    .replace(/\*\*/g, '<<GLOBSTAR>>')     // Temporary placeholder for **
    .replace(/\*/g, '<<STAR>>')            // Temporary placeholder for *
    .replace(/<<GLOBSTAR>>\//g, '(?:.*/)?') // **/ matches any number of directories including none
    .replace(/<<GLOBSTAR>>/g, '.*')       // ** matches anything
    .replace(/<<STAR>>/g, '[^/]*')        // * matches anything except directory separator
    .replace(/\//g, '\\/');                // Escape forward slashes
  
  // Combine prefix and pattern
  const fullPattern = prefix + pattern;
  
  // Add anchors to ensure full path match
  const regex = new RegExp(`^${fullPattern}$`);
  
  // Cache the compiled regex
  cache.setRegex(glob, regex);
  
  return regex;
}

/**
 * Normalize file path for consistent matching
 * Handles both absolute and relative paths across different platforms
 */
function normalizePath(filePath: string): string {
  // Convert backslashes to forward slashes for Windows paths
  let normalized = filePath.replace(/\\/g, '/');
  
  // Remove duplicate slashes
  normalized = normalized.replace(/\/+/g, '/');
  
  // Remove trailing slash if present
  if (normalized.endsWith('/') && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  
  return normalized;
}

/**
 * Extract relative path from absolute path
 * Handles various CI/CD and local development path formats
 */
function getRelativePath(absolutePath: string): string {
  const normalized = normalizePath(absolutePath);
  
  // If already a relative path, return as-is
  if (!normalized.startsWith('/') && !normalized.match(/^[A-Z]:/i)) {
    return normalized;
  }
  
  // Define common project source directories
  const projectDirs = ['src/', '__tests__/', 'scripts/', 'docs/', 'test/', 'tests/', 'lib/'];
  
  // Find the position of common project directories in the path
  let bestMatch = { index: -1, dir: '', relativePath: '' };
  
  for (const dir of projectDirs) {
    // Look for /dir pattern (with leading slash to avoid false matches)
    const searchPattern = `/${dir}`;
    const index = normalized.lastIndexOf(searchPattern);
    
    if (index >= 0) {
      // Extract everything after the parent of this directory
      // For example: /home/user/project/src/file.ts -> src/file.ts
      const dirStartIndex = index + 1; // Skip the leading slash
      const relativePath = normalized.substring(dirStartIndex);
      
      // Verify this looks like a valid project file
      if (relativePath.startsWith(dir) && relativePath.includes('.')) {
        // Keep the match that appears latest in the path (most specific)
        if (index > bestMatch.index) {
          bestMatch = { index, dir, relativePath };
        }
      }
    }
  }
  
  // If we found a match, return it
  if (bestMatch.index >= 0) {
    return bestMatch.relativePath;
  }
  
  // Fallback: Try to find common file patterns that indicate project files
  const filePatterns = [
    /\/(src|__tests__|scripts|test|tests|lib)\/.*\.[jt]sx?$/,
    /\/(src|__tests__|scripts|test|tests|lib)\/.*\.json$/,
    /\/(src|__tests__|scripts|test|tests|lib)\/.*\.ya?ml$/,
    /\/package\.json$/,
    /\/package-lock\.json$/,
    /\/tsconfig.*\.json$/,
    /\/\..*rc\.json$/  // .eslintrc.json, etc.
  ];
  
  for (const pattern of filePatterns) {
    const match = normalized.match(pattern);
    if (match) {
      // Find where the match starts and extract from there
      const matchIndex = normalized.indexOf(match[0]);
      if (matchIndex >= 0) {
        return normalized.substring(matchIndex + 1); // Skip leading /
      }
    }
  }
  
  // Last resort: if path contains common extensions, try to extract a reasonable relative path
  if (normalized.match(/\.(ts|js|tsx|jsx|json|yaml|yml)$/)) {
    // Find the last segment that looks like a project directory
    const segments = normalized.split('/');
    for (let i = segments.length - 2; i >= 0; i--) {
      if (projectDirs.some(dir => dir.startsWith(segments[i]))) {
        return segments.slice(i).join('/');
      }
    }
    
    // For root-level files like package-lock.json, just return the filename
    const filename = segments[segments.length - 1];
    if (filename && filename.includes('.')) {
      return filename;
    }
  }
  
  // Return the normalized path if we can't extract relative
  return normalized;
}

/**
 * Check if a finding should be suppressed
 * Optimized with caching and early returns
 */
export function shouldSuppress(ruleId: string, filePath?: string): boolean {
  if (!filePath) return false;
  
  // Normalize paths for consistent matching
  const normalizedPath = normalizePath(filePath);
  const relativePath = getRelativePath(normalizedPath);
  
  // Check cache first
  const cacheKey = `${ruleId}::${relativePath}`;
  const cached = cache.get(ruleId, relativePath);
  if (cached !== undefined) return cached;
  
  // Process suppressions with early returns
  for (const suppression of suppressions) {
    // Skip if rule doesn't match
    if (suppression.rule !== '*' && suppression.rule !== ruleId) {
      continue;
    }
    
    // Handle global suppressions (no file specified)
    if (!suppression.file) {
      cache.set(ruleId, relativePath, true);
      return true;
    }
    
    // Check exact file match (most common case)
    if (suppression.file === relativePath || suppression.file === normalizedPath) {
      cache.set(ruleId, relativePath, true);
      return true;
    }
    
    // Check pattern match only if file contains wildcards
    if (suppression.file.includes('*')) {
      try {
        const regex = globToRegex(suppression.file);
        if (regex.test(relativePath) || regex.test(normalizedPath)) {
          cache.set(ruleId, relativePath, true);
          return true;
        }
      } catch (error) {
        console.error(`Invalid suppression pattern "${suppression.file}":`, error);
      }
    }
  }
  
  // Not suppressed
  cache.set(ruleId, relativePath, false);
  return false;
}

/**
 * Clear suppression cache (useful for testing)
 */
export function clearSuppressionCache(): void {
  cache.clear();
}

/**
 * Get suppression statistics for reporting
 */
export function getSuppressionStats(): { 
  total: number; 
  byRule: Record<string, number>;
  byCategory: Record<string, number>;
} {
  const stats = {
    total: suppressions.length,
    byRule: {} as Record<string, number>,
    byCategory: {} as Record<string, number>
  };
  
  for (const suppression of suppressions) {
    // Count by rule
    stats.byRule[suppression.rule] = (stats.byRule[suppression.rule] || 0) + 1;
    
    // Count by category (extract from rule prefix)
    const category = suppression.rule.split('-')[0];
    stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
  }
  
  return stats;
}

// Validate suppressions on module load
const validationErrors = validateSuppressions();
if (validationErrors.length > 0) {
  console.warn('Suppression configuration warnings:', validationErrors);
}