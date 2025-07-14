/** @type {import('jest').Config} */
module.exports = {
  // Extend the base Jest config
  preset: 'ts-jest',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: 'test/tsconfig.test.json'
    }]
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@modelcontextprotocol)/)'
  ],
  
  // Integration test specific settings
  testMatch: ['<rootDir>/test/__tests__/integration/**/*.test.ts'],
  
  // Longer timeout for integration tests
  testTimeout: 30000,
  
  // Run tests sequentially to avoid conflicts
  maxWorkers: 1,
  
  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,
  
  // Coverage settings for integration tests
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/types/**'
  ],
  
  // Different coverage directory
  coverageDirectory: 'test/coverage-integration',
  
  // Display name in test output
  displayName: 'Integration Tests',
  
  // Setup and teardown
  globalSetup: '<rootDir>/test/__tests__/integration/setup.ts',
  globalTeardown: '<rootDir>/test/__tests__/integration/teardown.ts'
};