/**
 * Cross-Platform Test Helpers
 *
 * Utilities for testing cross-platform compatibility and catching
 * platform-specific issues before they hit CI/CD on macOS and Windows.
 *
 * Usage:
 * ```typescript
 * import { CrossPlatformTestHelper } from '../helpers/cross-platform-test-helpers.js';
 *
 * // Create platform-specific temp paths
 * const macosPath = CrossPlatformTestHelper.mockPlatformPath('macos', 'test-file.md');
 *
 * // Verify path compatibility
 * CrossPlatformTestHelper.assertPathCompatible(actualPath, /test-file\.md$/);
 *
 * // Scan test files for anti-patterns
 * const issues = await CrossPlatformTestHelper.scanTestFile('tests/unit/SomeTest.test.ts');
 * ```
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface CrossPlatformIssue {
  type: 'hardcoded-tmp' | 'path-separator' | 'exact-path-match' | 'missing-normalization';
  file: string;
  line: number;
  column?: number;
  message: string;
  suggestion: string;
  snippet?: string;
  priority: 'high' | 'medium' | 'low';
}

interface ScanConfig {
  // Files that are allowed to have hardcoded paths (they're testing path handling)
  allowedFiles: string[];

  // Variable names that are obviously test data
  testDataVariables: string[];

  // Patterns that indicate intentional examples
  examplePatterns: RegExp[];

  // File operations that should be checked for path issues
  fileOperations: string[];

  // Patterns to ignore in toBe() checks (not path-related)
  nonPathPatterns: RegExp[];
}

export type Platform = 'linux' | 'macos' | 'windows';

export class CrossPlatformTestHelper {
  /**
   * Configuration for scan behavior
   */
  private static readonly DEFAULT_CONFIG: ScanConfig = {
    allowedFiles: [
      'path-compatibility.test.ts',
      'cross-platform-test-helpers.ts',
    ],

    testDataVariables: [
      'linuxTemp', 'macosTemp', 'windowsTemp',
      'linuxPath', 'macosPath', 'windowsPath',
      'BAD_PATH', 'GOOD_PATH', 'EXAMPLE_PATH',
      'tmpPath', 'varPath', 'privateVarPath', 'privateTmpPath',
      // Mock data object fields
      'localEntry', 'githubEntry', 'converted', 'localFilePath',
      // Vulnerable code examples for security testing
      'vulnerableCode', 'badCode', 'maliciousCode', 'insecureCode', 'exploitCode',
      // Mock constants and configuration
      'EXECUTION_ENV', 'scriptPath', 'CONFIG', 'SETTINGS',
    ],

    examplePatterns: [
      /const \w*(Temp|Path|Example)\w* =/,
      /BAD_PATH:|GOOD_PATH:|EXAMPLE_PATH:/,
      /snippet:/,
      /if \([^)]*\.startsWith\(['"]\/(tmp|var)\//,
      /expect\([^)]*\)\.to(Contain|Match)\(['"]\//,
      // Vulnerable code string literals for security testing
      /const \w*(vulnerable|bad|malicious|insecure|exploit)Code\w* = [`'"]/i,
      // Mock data object literals
      /const \w*(local|github|mock|test)(Entry|Data|Object)\w* =/i,
      // Mock constants being tested
      /expect\(EXECUTION_ENV\./,
      /expect\(CONFIG\./,
      // Obvious fake/example paths
      /['"]\/path\/to\//,
      /['"]\/example\//,
      // Mock data transformations
      /expect\(converted\./,
      /\.localFilePath\)\.toBe\(/,
    ],

    fileOperations: [
      'atomicWriteFile',
      'writeFile',
      'mkdir',
      'unlink',
      'readFile',
      'rm',
      'rmdir',
    ],

    nonPathPatterns: [
      /\.toBe\((true|false)\)/,
      /\.toBe\(\d+\)/,
      /\.toBe\(['"]\d+\.\d+\.\d+['"]\)/, // Version strings
      /\.toBe\(['"]https?:\/\//,        // URLs
      /\.toBe\(['"][^'"\/\\]{1,30}['"]\)/, // Short strings without path separators
    ],
  };

  /**
   * Create a mock path that simulates a different platform's file system structure
   *
   * @param platform - Target platform to simulate
   * @param relativePath - Relative path to create (e.g., 'test-personas/test.md')
   * @returns Platform-specific absolute path
   *
   * @example
   * // Linux: /tmp/test-personas/test.md
   * // macOS: /var/folders/6c/xxx/T/test-personas/test.md
   * // Windows: C:\Users\RUNNER~1\AppData\Local\Temp\test-personas\test.md
   */
  static mockPlatformPath(platform: Platform, relativePath: string): string {
    switch (platform) {
      case 'linux': {
        return path.posix.join('/tmp', relativePath);
      }

      case 'macos': {
        // Simulate macOS temp directory structure
        const macosTemp = '/var/folders/6c/pzd640_546q6_yfn24r65c_40000gn/T';
        return path.posix.join(macosTemp, relativePath);
      }

      case 'windows': {
        // Simulate Windows temp directory structure
        // Use forward slashes then convert to backslashes for consistency
        const windowsTemp = 'C:/Users/RUNNER~1/AppData/Local/Temp';
        const windowsPath = windowsTemp + '/' + relativePath;
        // Convert all forward slashes to backslashes for Windows
        return windowsPath.replace(/\//g, '\\');
      }

      default:
        throw new Error(`Unknown platform: ${platform}`);
    }
  }

  /**
   * Get the platform-specific temp directory
   *
   * @param platform - Target platform
   * @returns Platform-specific temp directory
   */
  static getPlatformTempDir(platform: Platform): string {
    switch (platform) {
      case 'linux':
        return '/tmp';

      case 'macos':
        return '/var/folders/6c/pzd640_546q6_yfn24r65c_40000gn/T';

      case 'windows':
        return 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp';

      default:
        throw new Error(`Unknown platform: ${platform}`);
    }
  }

  /**
   * Verify a path comparison works across platforms
   * Uses basename matching for cross-platform compatibility
   *
   * @param actualPath - Actual path from code
   * @param expectedPattern - Expected pattern (string or regex)
   * @throws Error if paths don't match
   */
  static assertPathCompatible(actualPath: string, expectedPattern: string | RegExp): void {
    const normalizedPath = path.normalize(actualPath);

    if (typeof expectedPattern === 'string') {
      // Compare basenames for simple string patterns
      const actualBasename = path.basename(normalizedPath);
      const expectedBasename = path.basename(expectedPattern);

      if (actualBasename !== expectedBasename) {
        throw new Error(
          `Path basename mismatch:\n` +
          `  Actual:   ${actualBasename}\n` +
          `  Expected: ${expectedBasename}\n` +
          `  Full path: ${normalizedPath}`
        );
      }
    } else {
      // Use regex for more complex patterns
      if (!expectedPattern.test(normalizedPath)) {
        throw new Error(
          `Path does not match pattern:\n` +
          `  Path:    ${normalizedPath}\n` +
          `  Pattern: ${expectedPattern}`
        );
      }
    }
  }

  /**
   * Create a temporary directory that simulates different platforms
   *
   * @param platform - Platform to simulate
   * @param prefix - Directory name prefix
   * @returns Path to created directory
   */
  static async createCrossPlatformTempDir(platform: Platform, prefix: string = 'test'): Promise<string> {
    // Always use actual os.tmpdir() for real operations
    const baseTmpDir = os.tmpdir();
    const uniqueDir = path.join(baseTmpDir, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    await fs.mkdir(uniqueDir, { recursive: true });

    return uniqueDir;
  }

  /**
   * Check if a file should be skipped from scanning
   */
  private static shouldSkipFile(filePath: string): boolean {
    const fileName = path.basename(filePath);
    return this.DEFAULT_CONFIG.allowedFiles.some(pattern => fileName.includes(pattern));
  }

  /**
   * Check if a line is test data or an intentional example
   *
   * @param line - Current line to check
   * @param contextLines - Previous lines for context (optional)
   * @returns True if the line is test data or an example
   */
  private static isTestData(line: string, contextLines?: string[]): boolean {
    // Check if line contains test data variable names
    if (this.DEFAULT_CONFIG.testDataVariables.some(varName => line.includes(varName))) {
      return true;
    }

    // Check if line matches example patterns
    if (this.DEFAULT_CONFIG.examplePatterns.some(pattern => pattern.test(line))) {
      return true;
    }

    // Check context: if previous lines define vulnerable code or mock data
    if (contextLines && contextLines.length > 0) {
      // Look back up to 10 lines for context
      const recentContext = contextLines.slice(-10).join('\n');

      // Check if we're inside a vulnerable code block (for security testing)
      if (/const \w*(vulnerable|bad|malicious|insecure|exploit)Code\w* = [`'"]/.test(recentContext)) {
        return true;
      }

      // Check if we're inside a mock data object literal
      if (/const \w*(local|github|mock|test)(Entry|Data|Object)\w* = \{/.test(recentContext)) {
        // Verify we haven't closed the object yet
        const openBraces = (recentContext.match(/\{/g) || []).length;
        const closeBraces = (recentContext.match(/\}/g) || []).length;
        if (openBraces > closeBraces) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if a toBe() comparison is not path-related
   */
  private static isNonPathComparison(line: string): boolean {
    return this.DEFAULT_CONFIG.nonPathPatterns.some(pattern => pattern.test(line));
  }

  /**
   * Check if a line is a file operation mock that should be checked
   */
  private static isFileOperationMock(line: string): boolean {
    return this.DEFAULT_CONFIG.fileOperations.some(op => line.includes(op));
  }

  /**
   * Scan a test file for cross-platform anti-patterns
   *
   * @param filePath - Path to test file
   * @returns Array of issues found
   */
  static async scanTestFile(filePath: string): Promise<CrossPlatformIssue[]> {
    const issues: CrossPlatformIssue[] = [];

    // Skip files that are allowed to have hardcoded paths
    if (this.shouldSkipFile(filePath)) {
      return issues;
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        const lineNumber = index + 1;

        // Build context from previous lines (up to 10 lines back)
        const contextStart = Math.max(0, index - 10);
        const contextLines = lines.slice(contextStart, index);

        // Skip test data and example lines (with context awareness)
        if (this.isTestData(line, contextLines)) {
          return;
        }

        // Skip comments
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*') || trimmedLine.startsWith('/*')) {
          return;
        }

        // Check for hardcoded /tmp/ paths in test setup/mocks
        const tmpMatch = line.match(/['"`]\/tmp\//g);
        if (tmpMatch) {
          // Only flag if it's in test setup (not test data)
          // Must be either:
          // 1. A mock configuration (mockReturnValue, jest.fn)
          // 2. A variable assignment (const x = '/tmp/...')
          const isMockSetup = /mock(ReturnValue|Implementation)|jest\.fn/.test(line);
          const isVariableAssignment = /const \w+ = ['"`]\/tmp\//.test(line);

          if ((isMockSetup || isVariableAssignment) && !this.isTestData(line, contextLines)) {
            issues.push({
              type: 'hardcoded-tmp',
              file: filePath,
              line: lineNumber,
              message: 'Hardcoded /tmp/ path in test setup',
              suggestion: 'Use os.tmpdir() instead: const tmpDir = os.tmpdir(); path.join(tmpDir, ...)',
              snippet: line.trim(),
              priority: 'high'
            });
          }
        }

        // Check for exact path matching in file operation mocks
        if (this.isFileOperationMock(line)) {
          const exactPathMatch = line.match(/toHaveBeenCalledWith\s*\(\s*['"`]([^'"`]*[\/\\][^'"`]*)['"`]/);
          if (exactPathMatch && !line.includes('expect.any') && !line.includes('expect.stringMatching')) {
            issues.push({
              type: 'exact-path-match',
              file: filePath,
              line: lineNumber,
              message: `Path assertion without normalization in ${this.DEFAULT_CONFIG.fileOperations.find(op => line.includes(op))} mock`,
              suggestion: 'Use expect.any(String), expect.stringMatching(/pattern/), or path.basename() comparison',
              snippet: line.trim(),
              priority: 'high'
            });
          }
        }

        // Check for path concatenation with '/' (only if not in comments or strings)
        if (!line.trim().startsWith('//') && !line.trim().startsWith('*')) {
          const pathConcatMatch = line.match(/['"`][^'"`]*\/['"`]\s*\+|['"`]\s*\+\s*['"`][^'"`]*\//);
          if (pathConcatMatch && !line.includes('path.join') && !line.includes('https://') && !this.isTestData(line, contextLines)) {
            issues.push({
              type: 'path-separator',
              file: filePath,
              line: lineNumber,
              message: 'Path concatenation using string operators detected',
              suggestion: 'Use path.join() for cross-platform path construction',
              snippet: line.trim(),
              priority: 'medium'
            });
          }
        }

        // Check for missing path normalization in comparisons
        // But skip non-path comparisons (booleans, numbers, versions, etc.)
        if (line.includes('expect(') && line.includes('toBe(')) {
          // Skip if it's a non-path comparison
          if (this.isNonPathComparison(line)) {
            return;
          }

          // Only flag if it looks like an actual file system path comparison
          // Must have path separators AND not be in test data AND not be a URL
          if ((line.includes('/') || line.includes('\\\\')) && !this.isTestData(line, contextLines) && !line.includes('https://') && !line.includes('http://')) {
            // Additional filter: must look like it's comparing actual paths (not just strings with /)
            // Check if the variable being compared looks like a path variable
            const pathLikeVariables = /expect\((path|dir|file|folder|location|resolved|normalized)[A-Za-z]*\)/i;
            const pathLikeString = /toBe\(['"](\/|\\\\)[^'"]+['"]\)/; // Absolute path in toBe

            if (pathLikeVariables.test(line) || pathLikeString.test(line)) {
              if (!line.includes('path.normalize') && !line.includes('realpathSync') && !line.includes('path.basename')) {
                issues.push({
                  type: 'missing-normalization',
                  file: filePath,
                  line: lineNumber,
                  message: 'Path comparison without normalization',
                  suggestion: 'Use path.normalize() or path.basename() for reliable path comparisons',
                  snippet: line.trim(),
                  priority: 'low'
                });
              }
            }
          }
        }
      });
    } catch (error) {
      // If file doesn't exist or can't be read, return empty array
      if (process.env.VERBOSE === 'true') {
        console.warn(`Could not scan file ${filePath}:`, error);
      }
    }

    return issues;
  }

  /**
   * Scan all test files in a directory for cross-platform issues
   *
   * @param directory - Directory to scan
   * @returns Map of file paths to issues
   */
  static async scanTestDirectory(directory: string): Promise<Map<string, CrossPlatformIssue[]>> {
    const results = new Map<string, CrossPlatformIssue[]>();

    async function scanDir(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
          const issues = await CrossPlatformTestHelper.scanTestFile(fullPath);
          if (issues.length > 0) {
            results.set(fullPath, issues);
          }
        }
      }
    }

    await scanDir(directory);
    return results;
  }

  /**
   * Format issues for console output
   *
   * @param issuesMap - Map of files to issues
   * @param verbose - Whether to show full details
   * @returns Formatted string for console
   */
  static formatIssues(issuesMap: Map<string, CrossPlatformIssue[]>, verbose: boolean = false): string {
    if (issuesMap.size === 0) {
      return '✓ No cross-platform issues found';
    }

    const lines: string[] = [];

    // Count issues by priority
    let highPriority = 0;
    let mediumPriority = 0;
    let lowPriority = 0;

    for (const issues of issuesMap.values()) {
      for (const issue of issues) {
        if (issue.priority === 'high') highPriority++;
        else if (issue.priority === 'medium') mediumPriority++;
        else lowPriority++;
      }
    }

    // Only show high priority issues in concise mode
    const totalIssues = highPriority + mediumPriority + lowPriority;

    if (!verbose) {
      // Concise output - only show high priority issues
      lines.push('\n⚠️  Cross-Platform Issues Found:\n');

      if (highPriority > 0) {
        lines.push(`High Priority (${highPriority}):`);

        for (const [file, issues] of issuesMap) {
          const highPriorityIssues = issues.filter(i => i.priority === 'high');
          if (highPriorityIssues.length > 0) {
            const relativeFile = file.replace(process.cwd(), '');
            highPriorityIssues.forEach(issue => {
              lines.push(`  ${relativeFile}:${issue.line}`);
              lines.push(`    ${issue.message}: ${issue.snippet}`);
            });
          }
        }
      }

      if (mediumPriority > 0 || lowPriority > 0) {
        lines.push(`\nAdditional issues: ${mediumPriority} medium, ${lowPriority} low priority`);
      }

      lines.push('\nRun with VERBOSE=true for full details.');
    } else {
      // Verbose output - show everything
      lines.push(`\n❌ Found ${totalIssues} cross-platform issue(s) in ${issuesMap.size} file(s):\n`);

      for (const [file, issues] of issuesMap) {
        const relativeFile = file.replace(process.cwd(), '');
        lines.push(`\n${relativeFile}:`);

        issues.forEach(issue => {
          lines.push(`  Line ${issue.line} [${issue.priority}]: ${issue.message}`);
          if (issue.snippet) {
            lines.push(`    Code: ${issue.snippet}`);
          }
          lines.push(`    Fix:  ${issue.suggestion}`);
        });
      }
    }

    return lines.join('\n');
  }

  /**
   * Mock fs.realpathSync to simulate macOS symlink resolution
   * Simulates /var → /private/var on macOS
   *
   * @param originalPath - Original path
   * @returns Resolved path with macOS-style symlink resolution
   */
  static mockMacOSRealpathSync(originalPath: string): string {
    // Simulate macOS symlink resolution
    if (originalPath.startsWith('/var/')) {
      return originalPath.replace('/var/', '/private/var/');
    }
    if (originalPath.startsWith('/tmp/')) {
      return originalPath.replace('/tmp/', '/private/tmp/');
    }
    return originalPath;
  }

  /**
   * Normalize paths for cross-platform comparison
   * Handles different separators and symlink resolution
   *
   * @param pathToNormalize - Path to normalize
   * @returns Normalized path
   */
  static normalizePath(pathToNormalize: string): string {
    // Normalize separators
    let normalized = path.normalize(pathToNormalize);

    // Convert to forward slashes for consistent comparison
    normalized = normalized.replace(/\\/g, '/');

    return normalized;
  }

  /**
   * Compare two paths for equality across platforms
   * Uses basename comparison as a fallback for temp directory differences
   *
   * @param path1 - First path
   * @param path2 - Second path
   * @returns True if paths are equivalent
   */
  static pathsEqual(path1: string, path2: string): boolean {
    const norm1 = this.normalizePath(path1);
    const norm2 = this.normalizePath(path2);

    // First try exact match
    if (norm1 === norm2) {
      return true;
    }

    // Fallback to basename match (handles different temp directory structures)
    return path.basename(norm1) === path.basename(norm2);
  }

  /**
   * Create a Jest matcher for cross-platform path matching
   *
   * @param expectedPattern - Pattern to match (string, regex, or basename)
   * @returns Jest matcher object
   */
  static pathMatcher(expectedPattern: string | RegExp): {
    asymmetricMatch: (actual: string) => boolean;
    toString: () => string;
  } {
    return {
      asymmetricMatch: (actual: string): boolean => {
        if (typeof expectedPattern === 'string') {
          return this.pathsEqual(actual, expectedPattern);
        } else {
          return expectedPattern.test(this.normalizePath(actual));
        }
      },
      toString: (): string => {
        return `CrossPlatformPath(${expectedPattern})`;
      }
    };
  }

  /**
   * Validate that environment variables are platform-agnostic
   *
   * @param envVars - Object of environment variables to check
   * @returns Issues found
   */
  static validateEnvironmentVariables(envVars: Record<string, string | undefined>): CrossPlatformIssue[] {
    const issues: CrossPlatformIssue[] = [];

    for (const [key, value] of Object.entries(envVars)) {
      if (!value) continue;

      // Check for hardcoded repository patterns
      if (key === 'GITHUB_REPOSITORY' && value.includes('/')) {
        issues.push({
          type: 'exact-path-match',
          file: 'environment',
          line: 0,
          message: `Environment variable ${key} has hardcoded value: ${value}`,
          suggestion: 'Use PORTFOLIO_REPOSITORY_NAME or make it configurable'
        });
      }

      // Check for paths in environment variables
      if (value.includes('/tmp/') || value.includes('\\tmp\\')) {
        issues.push({
          type: 'hardcoded-tmp',
          file: 'environment',
          line: 0,
          message: `Environment variable ${key} contains hardcoded temp path`,
          suggestion: 'Use os.tmpdir() to construct temp paths'
        });
      }
    }

    return issues;
  }
}

/**
 * Jest custom matchers for cross-platform path testing
 */
export const crossPlatformMatchers = {
  /**
   * Match a path across platforms using basename comparison
   */
  toMatchCrossPlatformPath(received: string, expected: string | RegExp) {
    const helper = CrossPlatformTestHelper;

    let pass = false;
    let message = '';

    if (typeof expected === 'string') {
      pass = helper.pathsEqual(received, expected);
      message = pass
        ? `Expected ${received} not to match ${expected} (basename comparison)`
        : `Expected ${received} to match ${expected} (basename comparison)`;
    } else {
      pass = expected.test(helper.normalizePath(received));
      message = pass
        ? `Expected ${received} not to match pattern ${expected}`
        : `Expected ${received} to match pattern ${expected}`;
    }

    return { pass, message: () => message };
  }
};
