#!/usr/bin/env node

/**
 * QA Test Data Cleanup Manager for DollhouseMCP
 * 
 * Implements comprehensive test data cleanup mechanisms to prevent
 * accumulation of test artifacts in both local and CI environments.
 * 
 * Addresses Issue #665 - Test Data Cleanup Mechanisms
 * 
 * CRITICAL: With QA tests now running on every PR (Issue #663/PR #677),
 * this cleanup system is essential to prevent unbounded data growth.
 */

import { existsSync, readdirSync, unlinkSync, statSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { isCI, ensureDirectoryExists } from './qa-utils.js';

// Test data identification markers
const TEST_MARKERS = {
  PERSONA: 'QA_TEST_PERSONA_',
  ELEMENT: 'QA_TEST_ELEMENT_',
  FILE: 'qa_test_',
  RESULT: 'qa-test-result-',
  USER: 'qa-test-user'
};

// Cleanup configuration
const CLEANUP_CONFIG = {
  // Maximum age of test artifacts before forced cleanup (in milliseconds)
  MAX_AGE_MS: 60 * 60 * 1000, // 1 hour
  
  // Dry run mode - log what would be deleted without actually deleting
  DRY_RUN: process.env.DRY_RUN === 'true',
  
  // Safety mode - extra validation before deletion
  SAFETY_MODE: process.env.CLEANUP_SAFETY_MODE !== 'false',
  
  // Paths to clean
  PATHS: {
    QA_DOCS: 'docs/QA',
    PORTFOLIO_DIR: join(homedir(), '.dollhouse', 'portfolio'),
    TEMP_DIR: '/tmp'
  }
};

/**
 * Core test data cleanup system that tracks and removes test artifacts
 */
export class TestDataCleanup {
  /**
   * Initialize cleanup manager with unique test run identifier
   * @param {string} testRunId - Unique identifier for this test run
   */
  constructor(testRunId = null) {
    this.testRunId = testRunId || this.generateTestRunId();
    this.artifacts = [];
    this.isCI = isCI();
    this.startTime = new Date();
    this.dryRun = CLEANUP_CONFIG.DRY_RUN;
    this.safetyMode = CLEANUP_CONFIG.SAFETY_MODE;
    this.maxAge = CLEANUP_CONFIG.MAX_AGE_MS; // Instance variable to avoid race conditions
    
    this.log(`🧹 TestDataCleanup initialized for run: ${this.testRunId}`);
    this.log(`   Environment: ${this.isCI ? 'CI' : 'Local'}`);
    this.log(`   Dry Run: ${this.dryRun ? 'Enabled' : 'Disabled'}`);
    this.log(`   Safety Mode: ${this.safetyMode ? 'Enabled' : 'Disabled'}`);
  }

  /**
   * Generate unique test run identifier
   * @returns {string} Unique test run ID
   */
  generateTestRunId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    return `QA_${timestamp}_${random}`;
  }

  /**
   * Log messages with appropriate formatting
   * @param {string} message - Message to log
   * @param {string} level - Log level (info, warn, error)
   */
  log(message, level = 'info') {
    const prefix = this.isCI ? '🤖 CI' : '🧹';
    const timestamp = new Date().toISOString().slice(11, 19);
    
    switch (level) {
      case 'warn':
        console.warn(`${prefix} [${timestamp}] ⚠️  ${message}`);
        break;
      case 'error':
        console.error(`${prefix} [${timestamp}] ❌ ${message}`);
        break;
      default:
        console.log(`${prefix} [${timestamp}] ${message}`);
    }
  }

  /**
   * Track a test artifact for later cleanup
   * @param {string} type - Type of artifact (persona, file, result)
   * @param {string} identifier - Unique identifier for the artifact
   * @param {string} path - File system path (optional)
   * @param {Object} metadata - Additional metadata (optional)
   */
  trackArtifact(type, identifier, path = null, metadata = {}) {
    // Validate artifact type
    const validTypes = ['persona', 'element', 'file', 'result', 'temp'];
    if (!validTypes.includes(type)) {
      this.log(`Invalid artifact type: ${type}`, 'warn');
      return;
    }

    // Safety check - ensure identifier has test prefix
    if (this.safetyMode && !this.isTestArtifact(identifier, type)) {
      this.log(`Safety check failed for artifact: ${identifier} (type: ${type})`, 'warn');
      return;
    }

    const artifact = {
      type,
      identifier,
      path,
      metadata,
      tracked_at: new Date().toISOString(),
      test_run_id: this.testRunId
    };

    this.artifacts.push(artifact);
    this.log(`📍 Tracked ${type} artifact: ${identifier}${path ? ` (${path})` : ''}`);
  }

  /**
   * Check if an identifier represents a test artifact
   * @param {string} identifier - Identifier to check
   * @param {string} type - Type of artifact
   * @returns {boolean} True if this is a test artifact
   */
  isTestArtifact(identifier, type) {
    const lowerIdentifier = identifier.toLowerCase();
    
    switch (type) {
      case 'persona':
      case 'element':
        return lowerIdentifier.includes('qa_test') || 
               lowerIdentifier.includes('test-persona') ||
               lowerIdentifier.startsWith(TEST_MARKERS.PERSONA.toLowerCase()) ||
               lowerIdentifier.startsWith(TEST_MARKERS.ELEMENT.toLowerCase());
      
      case 'file':
        return lowerIdentifier.includes('qa_test') || 
               lowerIdentifier.includes('test-') ||
               lowerIdentifier.startsWith(TEST_MARKERS.FILE);
      
      case 'result':
        return lowerIdentifier.includes('qa-test-result') ||
               lowerIdentifier.startsWith(TEST_MARKERS.RESULT);
      
      case 'temp':
        return lowerIdentifier.includes('test') || 
               lowerIdentifier.includes('qa');
      
      default:
        return lowerIdentifier.includes('qa_test') || lowerIdentifier.includes('test');
    }
  }

  /**
   * Clean up all tracked artifacts
   * @returns {Promise<Object>} Cleanup results summary
   */
  async cleanupAll() {
    this.log(`🧹 Starting cleanup of ${this.artifacts.length} tracked artifacts...`);
    
    const results = {
      total: this.artifacts.length,
      cleaned: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };

    // Clean tracked artifacts
    for (const artifact of this.artifacts) {
      try {
        const cleaned = await this.cleanupArtifact(artifact);
        if (cleaned) {
          results.cleaned++;
        } else {
          results.skipped++;
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          artifact: artifact.identifier,
          error: error.message
        });
        this.log(`Failed to clean artifact ${artifact.identifier}: ${error.message}`, 'error');
      }
    }

    // Perform additional cleanup operations
    await this.cleanupPersonas();
    await this.cleanupFiles();
    await this.cleanupTestResults();

    this.log(`✅ Cleanup complete: ${results.cleaned} cleaned, ${results.failed} failed, ${results.skipped} skipped`);
    
    if (results.errors.length > 0) {
      this.log(`⚠️  Cleanup errors: ${results.errors.length}`, 'warn');
    }

    return results;
  }

  /**
   * Clean up a specific artifact
   * @param {Object} artifact - Artifact to clean up
   * @returns {Promise<boolean>} True if cleaned successfully
   */
  async cleanupArtifact(artifact) {
    try {
      switch (artifact.type) {
        case 'persona':
        case 'element':
          return await this.cleanupPersonaArtifact(artifact);
        
        case 'file':
          return await this.cleanupFileArtifact(artifact);
        
        case 'result':
          return await this.cleanupResultArtifact(artifact);
        
        case 'temp':
          return await this.cleanupTempArtifact(artifact);
        
        default:
          this.log(`Unknown artifact type: ${artifact.type}`, 'warn');
          return false;
      }
    } catch (error) {
      this.log(`Error cleaning artifact ${artifact.identifier}: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Clean up persona/element artifacts
   * @param {Object} artifact - Persona artifact to clean
   * @returns {Promise<boolean>} True if cleaned successfully
   */
  async cleanupPersonaArtifact(artifact) {
    const portfolioPath = CLEANUP_CONFIG.PATHS.PORTFOLIO_DIR;
    
    if (!existsSync(portfolioPath)) {
      this.log(`Portfolio directory not found: ${portfolioPath}`, 'warn');
      return false;
    }

    const personaFiles = this.findPersonaFiles(portfolioPath, artifact.identifier);
    
    if (personaFiles.length === 0) {
      this.log(`No persona files found for: ${artifact.identifier}`);
      return false;
    }

    let cleaned = false;
    for (const file of personaFiles) {
      // Validate path is within safe directories
      if (!this.isPathWithinSafeDirectories(file)) {
        this.log(`Path validation failed - skipping persona file: ${file}`, 'warn');
        continue;
      }
      
      if (this.dryRun) {
        this.log(`[DRY RUN] Would delete persona file: ${file}`);
        cleaned = true;
      } else {
        try {
          unlinkSync(file);
          this.log(`🗑️  Deleted persona file: ${file}`);
          cleaned = true;
        } catch (error) {
          this.log(`Failed to delete persona file ${file}: ${error.message}`, 'error');
        }
      }
    }

    return cleaned;
  }

  /**
   * Check if a path is within safe directories for deletion
   * @param {string} filePath - Path to validate
   * @returns {boolean} True if path is within safe directories
   */
  isPathWithinSafeDirectories(filePath) {
    const safePaths = [
      resolve(process.cwd(), 'docs/QA'),
      resolve(process.cwd(), 'test'),
      resolve(process.env.TEST_PERSONAS_DIR || join(homedir(), '.dollhouse/portfolio/personas'))
    ];
    const resolvedPath = resolve(filePath);
    return safePaths.some(safe => resolvedPath.startsWith(safe));
  }

  /**
   * Clean up file artifacts
   * @param {Object} artifact - File artifact to clean
   * @returns {Promise<boolean>} True if cleaned successfully
   */
  async cleanupFileArtifact(artifact) {
    if (!artifact.path || !existsSync(artifact.path)) {
      this.log(`File not found: ${artifact.path || 'no path specified'}`);
      return false;
    }

    // Validate path is within safe directories
    if (!this.isPathWithinSafeDirectories(artifact.path)) {
      this.log(`Path validation failed - not within safe directories: ${artifact.path}`, 'error');
      return false;
    }

    if (this.dryRun) {
      this.log(`[DRY RUN] Would delete file: ${artifact.path}`);
      return true;
    }

    try {
      const stats = statSync(artifact.path);
      if (stats.isDirectory()) {
        rmSync(artifact.path, { recursive: true, force: true });
        this.log(`🗑️  Deleted directory: ${artifact.path}`);
      } else {
        unlinkSync(artifact.path);
        this.log(`🗑️  Deleted file: ${artifact.path}`);
      }
      return true;
    } catch (error) {
      this.log(`Failed to delete file ${artifact.path}: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Clean up test result artifacts
   * @param {Object} artifact - Result artifact to clean
   * @returns {Promise<boolean>} True if cleaned successfully
   */
  async cleanupResultArtifact(artifact) {
    if (artifact.path) {
      return await this.cleanupFileArtifact(artifact);
    }

    // Look for result files in QA directory
    const qaDir = CLEANUP_CONFIG.PATHS.QA_DOCS;
    if (!existsSync(qaDir)) {
      return false;
    }

    const resultFiles = readdirSync(qaDir)
      .filter(file => file.includes(artifact.identifier))
      .map(file => join(qaDir, file));

    let cleaned = false;
    for (const file of resultFiles) {
      // Validate path is within safe directories
      if (!this.isPathWithinSafeDirectories(file)) {
        this.log(`Path validation failed - skipping result file: ${file}`, 'warn');
        continue;
      }
      
      if (this.dryRun) {
        this.log(`[DRY RUN] Would delete result file: ${file}`);
        cleaned = true;
      } else {
        try {
          unlinkSync(file);
          this.log(`🗑️  Deleted result file: ${file}`);
          cleaned = true;
        } catch (error) {
          this.log(`Failed to delete result file ${file}: ${error.message}`, 'error');
        }
      }
    }

    return cleaned;
  }

  /**
   * Clean up temporary artifacts
   * @param {Object} artifact - Temp artifact to clean
   * @returns {Promise<boolean>} True if cleaned successfully
   */
  async cleanupTempArtifact(artifact) {
    return await this.cleanupFileArtifact(artifact);
  }

  /**
   * Clean up all test personas from portfolio
   * @returns {Promise<number>} Number of personas cleaned
   */
  async cleanupPersonas() {
    const portfolioPath = CLEANUP_CONFIG.PATHS.PORTFOLIO_DIR;
    
    if (!existsSync(portfolioPath)) {
      this.log('Portfolio directory not found, skipping persona cleanup');
      return 0;
    }

    this.log('🎭 Cleaning test personas from portfolio...');
    
    const personaFiles = this.findAllTestPersonas(portfolioPath);
    let cleaned = 0;

    for (const file of personaFiles) {
      // Validate path is within safe directories
      if (!this.isPathWithinSafeDirectories(file)) {
        this.log(`Path validation failed - skipping persona: ${file}`, 'warn');
        continue;
      }
      
      if (this.dryRun) {
        this.log(`[DRY RUN] Would delete test persona: ${file}`);
        cleaned++;
      } else {
        try {
          unlinkSync(file);
          this.log(`🗑️  Deleted test persona: ${file}`);
          cleaned++;
        } catch (error) {
          this.log(`Failed to delete persona ${file}: ${error.message}`, 'error');
        }
      }
    }

    this.log(`🎭 Cleaned ${cleaned} test personas`);
    return cleaned;
  }

  /**
   * Clean up test files from docs/QA and other locations
   * @returns {Promise<number>} Number of files cleaned
   */
  async cleanupFiles() {
    this.log('📁 Cleaning test files...');
    
    let totalCleaned = 0;
    
    // Clean QA directory
    totalCleaned += await this.cleanupDirectory(CLEANUP_CONFIG.PATHS.QA_DOCS);
    
    // Clean temp directories if in CI
    if (this.isCI) {
      const tempPaths = [
        '/tmp/test-personas',
        '/tmp/qa-test',
        join(process.cwd(), 'test/temp')
      ];
      
      for (const tempPath of tempPaths) {
        totalCleaned += await this.cleanupDirectory(tempPath);
      }
    }

    this.log(`📁 Cleaned ${totalCleaned} test files`);
    return totalCleaned;
  }

  /**
   * Clean up old test results
   * @returns {Promise<number>} Number of result files cleaned
   */
  async cleanupTestResults() {
    const qaDir = CLEANUP_CONFIG.PATHS.QA_DOCS;
    
    if (!existsSync(qaDir)) {
      this.log('QA directory not found, skipping test results cleanup');
      return 0;
    }

    this.log('📊 Cleaning old test results...');
    
    const now = Date.now();
    const maxAge = this.maxAge;
    let cleaned = 0;

    try {
      const files = readdirSync(qaDir);
      
      for (const file of files) {
        // Only clean files that look like test results
        if (!this.isTestResultFile(file)) {
          continue;
        }

        const filePath = join(qaDir, file);
        const stats = statSync(filePath);
        const age = now - stats.mtime.getTime();

        // Only clean old files to avoid interfering with current tests
        if (age > maxAge) {
          // Validate path is within safe directories
          if (!this.isPathWithinSafeDirectories(filePath)) {
            this.log(`Path validation failed - skipping old result: ${filePath}`, 'warn');
            continue;
          }
          
          if (this.dryRun) {
            this.log(`[DRY RUN] Would delete old test result: ${file} (age: ${Math.round(age / 1000 / 60)} minutes)`);
            cleaned++;
          } else {
            try {
              unlinkSync(filePath);
              this.log(`🗑️  Deleted old test result: ${file} (age: ${Math.round(age / 1000 / 60)} minutes)`);
              cleaned++;
            } catch (error) {
              this.log(`Failed to delete result file ${file}: ${error.message}`, 'error');
            }
          }
        }
      }
    } catch (error) {
      this.log(`Error cleaning test results: ${error.message}`, 'error');
    }

    this.log(`📊 Cleaned ${cleaned} old test results`);
    return cleaned;
  }

  /**
   * Clean up a specific directory of test files
   * @param {string} dirPath - Directory path to clean
   * @returns {Promise<number>} Number of files cleaned
   */
  async cleanupDirectory(dirPath) {
    if (!existsSync(dirPath)) {
      return 0;
    }

    let cleaned = 0;
    
    try {
      const files = readdirSync(dirPath);
      
      for (const file of files) {
        if (this.isTestFile(file)) {
          const filePath = join(dirPath, file);
          
          // Validate path is within safe directories
          if (!this.isPathWithinSafeDirectories(filePath)) {
            this.log(`Path validation failed - skipping: ${filePath}`, 'warn');
            continue;
          }
          
          if (this.dryRun) {
            this.log(`[DRY RUN] Would delete test file: ${filePath}`);
            cleaned++;
          } else {
            try {
              const stats = statSync(filePath);
              if (stats.isDirectory()) {
                rmSync(filePath, { recursive: true, force: true });
              } else {
                unlinkSync(filePath);
              }
              this.log(`🗑️  Deleted test file: ${filePath}`);
              cleaned++;
            } catch (error) {
              this.log(`Failed to delete file ${filePath}: ${error.message}`, 'error');
            }
          }
        }
      }
    } catch (error) {
      this.log(`Error cleaning directory ${dirPath}: ${error.message}`, 'error');
    }

    return cleaned;
  }

  /**
   * Find persona files matching a specific identifier
   * @param {string} portfolioPath - Portfolio directory path
   * @param {string} identifier - Persona identifier to find
   * @returns {string[]} Array of matching file paths
   */
  findPersonaFiles(portfolioPath, identifier) {
    const files = [];
    
    try {
      const personasDir = join(portfolioPath, 'personas');
      if (existsSync(personasDir)) {
        const personaFiles = readdirSync(personasDir);
        for (const file of personaFiles) {
          if (file.toLowerCase().includes(identifier.toLowerCase()) && 
              this.isTestArtifact(file, 'persona')) {
            files.push(join(personasDir, file));
          }
        }
      }
    } catch (error) {
      this.log(`Error finding persona files: ${error.message}`, 'error');
    }

    return files;
  }

  /**
   * Find all test personas in portfolio
   * @param {string} portfolioPath - Portfolio directory path
   * @returns {string[]} Array of test persona file paths
   */
  findAllTestPersonas(portfolioPath) {
    const files = [];
    
    try {
      const personasDir = join(portfolioPath, 'personas');
      if (existsSync(personasDir)) {
        const personaFiles = readdirSync(personasDir);
        for (const file of personaFiles) {
          if (this.isTestArtifact(file, 'persona')) {
            files.push(join(personasDir, file));
          }
        }
      }
    } catch (error) {
      this.log(`Error finding test personas: ${error.message}`, 'error');
    }

    return files;
  }

  /**
   * Check if a file is a test file that should be cleaned
   * @param {string} filename - File name to check
   * @returns {boolean} True if this is a test file
   */
  isTestFile(filename) {
    const lower = filename.toLowerCase();
    return lower.includes('qa_test') || 
           lower.includes('test-') ||
           lower.startsWith('qa-') ||
           lower.includes('temp');
  }

  /**
   * Check if a file is a test result file
   * @param {string} filename - File name to check
   * @returns {boolean} True if this is a test result file
   */
  isTestResultFile(filename) {
    const lower = filename.toLowerCase();
    return lower.includes('qa-test-result') ||
           lower.includes('test-results') ||
           lower.startsWith('qa-') ||
           (lower.includes('test') && (lower.endsWith('.json') || lower.endsWith('.md')));
  }

  /**
   * Get cleanup statistics and summary
   * @returns {Object} Cleanup statistics
   */
  getCleanupStats() {
    const duration = Date.now() - this.startTime.getTime();
    
    return {
      test_run_id: this.testRunId,
      start_time: this.startTime.toISOString(),
      duration_ms: duration,
      tracked_artifacts: this.artifacts.length,
      environment: this.isCI ? 'CI' : 'Local',
      dry_run: this.dryRun,
      safety_mode: this.safetyMode
    };
  }

  /**
   * Force cleanup of all test data (use with caution)
   * This method bypasses safety checks and age limits
   * @returns {Promise<Object>} Cleanup results
   */
  async forceCleanup() {
    this.log('⚠️  FORCE CLEANUP: Bypassing safety checks and age limits', 'warn');
    
    const originalSafetyMode = this.safetyMode;
    const originalMaxAge = this.maxAge;
    
    try {
      // Temporarily disable safety mode and age checks using instance variables
      this.safetyMode = false;
      this.maxAge = 0;
      
      const results = await this.cleanupAll();
      
      this.log('⚠️  Force cleanup completed', 'warn');
      return results;
    } finally {
      // Restore original settings
      this.safetyMode = originalSafetyMode;
      this.maxAge = originalMaxAge;
    }
  }
}

// Export constants for use by other modules
export { TEST_MARKERS, CLEANUP_CONFIG };

// Command line interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const cleanup = new TestDataCleanup();
  
  const force = process.argv.includes('--force');
  const stats = process.argv.includes('--stats');
  
  if (stats) {
    console.log(JSON.stringify(cleanup.getCleanupStats(), null, 2));
  } else {
    const results = force ? await cleanup.forceCleanup() : await cleanup.cleanupAll();
    console.log('\n📊 Final Cleanup Results:');
    console.log(JSON.stringify(results, null, 2));
    
    process.exit(results.failed > 0 ? 1 : 0);
  }
}