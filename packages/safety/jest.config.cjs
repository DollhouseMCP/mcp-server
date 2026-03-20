/**
 * Jest configuration for @dollhousemcp/safety package
 *
 * Configures ts-jest for ESM TypeScript testing.
 * @see Issue #121 - Add unit tests for safetyTierService
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: 'tsconfig.test.json'
    }]
  },
  moduleNameMapper: {
    // Handle .js extensions in imports (ESM style)
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts'
  ],
  coverageDirectory: 'coverage'
};
