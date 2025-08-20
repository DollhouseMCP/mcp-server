/**
 * Jest setup file for global test configuration
 * 
 * This file sets up the testing environment with proper safety guards
 * to prevent test data from contaminating production portfolios.
 */

import { isProductionPath, validateTestPath, emergencyCleanup } from './helpers/portfolio-test-utils.js';
import * as path from 'path';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.CI = 'true'; // Mark as CI environment to prevent production behaviors

// Legacy environment variable (deprecated, but set for compatibility)
process.env.PERSONAS_DIR = 'test-personas';

/**
 * Production path validation - prevent tests from accessing production portfolios
 */
function validateEnvironmentSafety(): void {
  const portfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
  const personasDir = process.env.DOLLHOUSE_PERSONAS_DIR; // Legacy
  
  // Check portfolio directory
  if (portfolioDir && isProductionPath(portfolioDir)) {
    throw new Error(
      `SECURITY ERROR: Test environment is pointing to production portfolio: ${portfolioDir}. ` +
      `Tests must use temporary directories only. ` +
      `Remove DOLLHOUSE_PORTFOLIO_DIR or set it to a test directory.`
    );
  }
  
  // Check legacy personas directory
  if (personasDir && isProductionPath(personasDir)) {
    throw new Error(
      `SECURITY ERROR: Test environment is using deprecated DOLLHOUSE_PERSONAS_DIR pointing to production: ${personasDir}. ` +
      `Update tests to use DOLLHOUSE_PORTFOLIO_DIR with a test directory.`
    );
  }
  
  // Validate any test paths that might be set
  if (portfolioDir) {
    try {
      validateTestPath(portfolioDir);
    } catch (error) {
      throw new Error(
        `SECURITY ERROR: Invalid test portfolio path: ${portfolioDir}. ${error}`
      );
    }
  }
}

/**
 * Check for dangerous environment variables that could affect test safety
 */
function checkDangerousEnvironment(): void {
  const dangerousVars = [
    { name: 'DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION', warning: 'Auto-submission should be disabled in tests' },
    { name: 'DOLLHOUSE_LOAD_TEST_DATA', warning: 'Test data loading may affect test isolation' },
    { name: 'GITHUB_TOKEN', warning: 'Real GitHub token detected - tests should use mocks' }
  ];
  
  dangerousVars.forEach(({ name, warning }) => {
    if (process.env[name] && process.env[name] !== 'false') {
      console.warn(`⚠️  WARNING: ${name} is set in test environment. ${warning}`);
    }
  });
}

/**
 * Initialize test environment with safety checks
 */
function initializeTestEnvironment(): void {
  try {
    // Validate environment safety
    validateEnvironmentSafety();
    
    // Check for potentially dangerous settings
    checkDangerousEnvironment();
    
    // Set safe defaults
    process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION = 'false';
    
    // Ensure clean state
    delete process.env.DOLLHOUSE_PERSONAS_DIR; // Remove deprecated variable
    
    console.log('✅ Test environment initialized safely');
    
  } catch (error) {
    console.error('❌ Test environment initialization failed:', error);
    throw error;
  }
}

/**
 * Global test setup
 */
function setupGlobalTestEnvironment(): void {
  // Initialize safe test environment
  initializeTestEnvironment();
  
  // Set up global error handlers for test safety
  const originalUncaughtException = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  
  process.on('uncaughtException', async (error) => {
    console.error('Uncaught exception in tests, running emergency cleanup...', error);
    await emergencyCleanup();
    
    // Call original handlers
    originalUncaughtException.forEach(handler => {
      if (typeof handler === 'function') {
        handler(error);
      }
    });
  });
  
  const originalUnhandledRejection = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  
  process.on('unhandledRejection', async (reason) => {
    console.error('Unhandled rejection in tests, running emergency cleanup...', reason);
    await emergencyCleanup();
    
    // Call original handlers
    originalUnhandledRejection.forEach(handler => {
      if (typeof handler === 'function') {
        handler(reason, Promise.resolve());
      }
    });
  });
}

// Run setup
setupGlobalTestEnvironment();