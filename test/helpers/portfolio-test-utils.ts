/**
 * Portfolio Test Utilities - Safe temp directory creation and cleanup for tests
 * 
 * This module provides safe utilities for creating temporary portfolio directories
 * in tests, ensuring that test data never contaminates production portfolios.
 * 
 * Key Features:
 * - Automatic temp directory creation with unique names
 * - Production path validation to prevent accidents
 * - Automatic cleanup registration with Jest
 * - Safe portfolio structure creation
 * - Environment variable isolation
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { afterEach } from '@jest/globals';
import { UnicodeValidator } from '../../src/security/unicodeValidator.js';
import { SecurityMonitor } from '../../src/security/securityMonitor.js';

/**
 * Configuration for portfolio test utilities
 */
export interface PortfolioTestConfig {
  /** Prefix for temporary directory names */
  prefix?: string;
  /** Whether to create full portfolio structure (all element types) */
  createFullStructure?: boolean;
  /** Custom element types to create (if not using full structure) */
  elementTypes?: string[];
  /** Whether to register automatic cleanup */
  autoCleanup?: boolean;
}

/**
 * Result of creating a test portfolio
 */
export interface TestPortfolioResult {
  /** Path to the temporary portfolio directory */
  portfolioDir: string;
  /** Original environment variables (for restoration) */
  originalEnv: Record<string, string | undefined>;
  /** Cleanup function to call when done */
  cleanup: () => Promise<void>;
}

/**
 * Registry of temporary directories to clean up
 */
const tempDirectoryRegistry = new Set<string>();

/**
 * Check if a path appears to be a production portfolio path
 * @param portfolioPath Path to check
 * @returns true if this looks like a production path
 */
export function isProductionPath(portfolioPath: string): boolean {
  const productionIndicators = [
    // User home directories
    portfolioPath.includes('/Users/') && portfolioPath.includes('/.dollhouse/portfolio'),
    portfolioPath.includes('/home/') && portfolioPath.includes('/.dollhouse/portfolio'),
    portfolioPath.includes('\\Users\\') && portfolioPath.includes('\\.dollhouse\\portfolio'),
    
    // Windows user profile paths
    portfolioPath.includes('AppData') && portfolioPath.includes('.dollhouse'),
    
    // Any path containing the actual production portfolio name
    portfolioPath.includes('.dollhouse/portfolio') && !portfolioPath.includes('/temp'),
    portfolioPath.includes('.dollhouse\\portfolio') && !portfolioPath.includes('\\temp'),
  ];
  
  return productionIndicators.some(indicator => indicator);
}

/**
 * Validate that a path is safe for testing (not production)
 * @param portfolioPath Path to validate
 * @throws Error if path appears to be production
 */
export function validateTestPath(portfolioPath: string): void {
  // SECURITY FIX: Add Unicode normalization to prevent homograph attacks
  const normalized = UnicodeValidator.normalize(portfolioPath);
  if (normalized.hasSecurityRisk) {
    // SECURITY FIX: Add audit logging for security events
    SecurityMonitor.logSecurityEvent({
      type: 'TEST_PATH_SECURITY_RISK',
      severity: 'HIGH',
      source: 'portfolio-test-utils.validateTestPath',
      details: `Security risk detected in test path: ${normalized.securityRisks.join(', ')}`
    });
    throw new Error(
      `SECURITY: Path contains security risks: ${normalized.securityRisks.join(', ')}`
    );
  }
  
  const normalizedPath = normalized.normalizedContent;
  
  if (isProductionPath(normalizedPath)) {
    // SECURITY FIX: Add audit logging for blocked production access
    SecurityMonitor.logSecurityEvent({
      type: 'TEST_PRODUCTION_ACCESS_BLOCKED',
      severity: 'MEDIUM',
      source: 'portfolio-test-utils.validateTestPath',
      details: `Blocked test access to production path: ${normalizedPath}`
    });
    throw new Error(
      `SECURITY: Attempted to use production portfolio path in tests: ${normalizedPath}. ` +
      `Tests must use temporary directories only.`
    );
  }
  
  // Additional safety checks
  if (!normalizedPath.includes('temp') && !normalizedPath.includes('test')) {
    // SECURITY FIX: Add audit logging for invalid test paths
    SecurityMonitor.logSecurityEvent({
      type: 'TEST_PATH_INVALID',
      severity: 'LOW',
      source: 'portfolio-test-utils.validateTestPath',
      details: `Test path must contain 'temp' or 'test': ${normalizedPath}`
    });
    throw new Error(
      `SECURITY: Test portfolio path must contain 'temp' or 'test': ${normalizedPath}`
    );
  }
}

/**
 * Create a safe temporary portfolio directory for testing
 * @param config Configuration options
 * @returns Test portfolio result with cleanup function
 */
export async function createTestPortfolio(config: PortfolioTestConfig = {}): Promise<TestPortfolioResult> {
  const {
    prefix = 'dollhouse-test-portfolio',
    createFullStructure = true,
    elementTypes = ['personas', 'skills', 'templates', 'agents', 'ensembles', 'memories'],
    autoCleanup = true
  } = config;
  
  // Create unique temporary directory
  const tempDir = os.tmpdir();
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const portfolioDir = path.join(tempDir, `${prefix}-${timestamp}-${random}`);
  
  // Validate the path is safe
  validateTestPath(portfolioDir);
  
  // Store original environment variables
  const originalEnv = {
    DOLLHOUSE_PORTFOLIO_DIR: process.env.DOLLHOUSE_PORTFOLIO_DIR,
    DOLLHOUSE_PERSONAS_DIR: process.env.DOLLHOUSE_PERSONAS_DIR, // Legacy, should not be used
    NODE_ENV: process.env.NODE_ENV,
    CI: process.env.CI
  };
  
  try {
    // Create portfolio directory structure
    await fs.mkdir(portfolioDir, { recursive: true });
    
    if (createFullStructure) {
      // Create all standard element type directories
      for (const elementType of elementTypes) {
        await fs.mkdir(path.join(portfolioDir, elementType), { recursive: true });
      }
    }
    
    // Set environment to use test directory
    process.env.DOLLHOUSE_PORTFOLIO_DIR = portfolioDir;
    process.env.NODE_ENV = 'test';
    process.env.CI = 'true'; // Mark as CI environment to prevent production behaviors
    
    // Remove legacy environment variable if present
    delete process.env.DOLLHOUSE_PERSONAS_DIR;
    
    // Register for cleanup
    tempDirectoryRegistry.add(portfolioDir);
    
    // Create cleanup function
    const cleanup = async (): Promise<void> => {
      try {
        // Restore original environment
        for (const [key, value] of Object.entries(originalEnv)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        
        // Remove directory from registry
        tempDirectoryRegistry.delete(portfolioDir);
        
        // Clean up temporary directory
        if (await directoryExists(portfolioDir)) {
          await fs.rm(portfolioDir, { recursive: true, force: true });
        }
      } catch (error) {
        console.warn(`Warning: Failed to clean up test portfolio: ${error}`);
      }
    };
    
    // Register automatic cleanup if requested
    if (autoCleanup) {
      afterEach(async () => {
        if (tempDirectoryRegistry.has(portfolioDir)) {
          await cleanup();
        }
      });
    }
    
    return {
      portfolioDir,
      originalEnv,
      cleanup
    };
    
  } catch (error) {
    // Clean up on error
    try {
      await fs.rm(portfolioDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    
    // Restore environment on error
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    
    throw error;
  }
}

/**
 * Helper to check if a directory exists
 * @param dirPath Path to check
 * @returns true if directory exists
 */
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create a minimal test element file
 * @param elementPath Path where to create the element
 * @param elementType Type of element (persona, skill, etc.)
 * @param name Name of the element
 * @returns Path to created file
 */
export async function createTestElement(
  elementPath: string,
  elementType: string,
  name: string
): Promise<string> {
  const timestamp = new Date().toISOString();
  const content = `---
name: ${name}
description: Test ${elementType} for integration testing
category: test
author: test-suite
version: 1.0.0
created: ${timestamp}
modified: ${timestamp}
---

# ${name}

This is a test ${elementType} created for integration testing purposes.

## Purpose
- Validate ${elementType} functionality
- Test file operations
- Ensure proper handling of test data

## Instructions
This ${elementType} is for testing only and should not be used in production.
`;

  await fs.writeFile(elementPath, content, 'utf8');
  return elementPath;
}

/**
 * Clean up all registered temporary directories
 * Called automatically by Jest, but can be called manually if needed
 */
export async function cleanupAllTestPortfolios(): Promise<void> {
  const cleanupPromises = Array.from(tempDirectoryRegistry).map(async (dir) => {
    try {
      if (await directoryExists(dir)) {
        await fs.rm(dir, { recursive: true, force: true });
      }
      tempDirectoryRegistry.delete(dir);
    } catch (error) {
      console.warn(`Warning: Failed to clean up test directory ${dir}: ${error}`);
    }
  });
  
  await Promise.allSettled(cleanupPromises);
}

/**
 * Emergency cleanup function that removes any temp directories matching test patterns
 * This is a safety net to clean up if tests fail to clean up properly
 */
export async function emergencyCleanup(): Promise<void> {
  const tempDir = os.tmpdir();
  
  try {
    const entries = await fs.readdir(tempDir);
    const testDirPatterns = [
      /dollhouse-test-portfolio-\d+-[a-z0-9]+$/,
      /test-portfolio-\d+$/,
      /dollhouse-.*-test-\d+$/
    ];
    
    const cleanupPromises = entries
      .filter(entry => testDirPatterns.some(pattern => pattern.test(entry)))
      .map(async (entry) => {
        const fullPath = path.join(tempDir, entry);
        try {
          const stats = await fs.stat(fullPath);
          if (stats.isDirectory()) {
            await fs.rm(fullPath, { recursive: true, force: true });
            console.log(`Emergency cleanup: Removed ${fullPath}`);
          }
        } catch (error) {
          console.warn(`Emergency cleanup failed for ${fullPath}: ${error}`);
        }
      });
    
    await Promise.allSettled(cleanupPromises);
  } catch (error) {
    console.warn(`Emergency cleanup failed: ${error}`);
  }
}

// Global cleanup on process exit
process.on('exit', () => {
  // Synchronous cleanup for process exit
  const tempDir = os.tmpdir();
  tempDirectoryRegistry.forEach(dir => {
    try {
      if (require('fs').existsSync(dir)) {
        require('fs').rmSync(dir, { recursive: true, force: true });
      }
    } catch (error) {
      console.warn(`Failed to clean up on exit: ${dir}: ${error}`);
    }
  });
});

// Global cleanup on unhandled errors
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception, cleaning up test portfolios...', error);
  await cleanupAllTestPortfolios();
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection, cleaning up test portfolios...', reason);
  await cleanupAllTestPortfolios();
  process.exit(1);
});