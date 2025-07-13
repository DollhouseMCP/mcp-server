/** @type {import('jest').Config} */
/**
 * Jest configuration for testing compiled JavaScript output
 * This is used as a diagnostic tool to determine if CI failures
 * are related to TypeScript/ESM module resolution issues
 */
const config = {
  testEnvironment: 'node',
  rootDir: '..',
  
  // Look for test files in the compiled output directory
  testMatch: [
    '<rootDir>/dist/**/__tests__/**/*.test.js',
    '<rootDir>/dist/**/?(*.)+(spec|test).js'
  ],
  
  // No transformation needed - we're testing compiled JS
  transform: {},
  
  // No module mapping needed - real JS files exist
  moduleNameMapper: {},
  
  // Ignore node_modules and source directories
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/src/',
    '<rootDir>/__tests__/'  // Ignore source test files, not compiled ones
  ],
  
  // Setup file - use the original .mjs since it's just setting env vars
  setupFilesAfterEnv: ['<rootDir>/jest.setup.mjs'],
  
  // Module paths to ignore
  modulePathIgnorePatterns: ['<rootDir>/src/'],
  
  // Test roots
  roots: ['<rootDir>/dist'],
  
  // Timeout
  testTimeout: 10000,
  
  // Coverage settings (if needed)
  collectCoverageFrom: [
    'dist/**/*.js',
    '!dist/**/*.d.ts',
    '!dist/**/*.test.js',
    '!dist/**/jest.setup.js'
  ],
  
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html']
};

module.exports = config;