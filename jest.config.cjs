/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  rootDir: '.',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { 
      useESM: true,
      tsconfig: {
        allowJs: true,
        rootDir: '.',
        isolatedModules: true
      }
    }]
  },
  testMatch: [
    '<rootDir>/**/__tests__/**/*.test.ts',
    '<rootDir>/**/?(*.)+(spec|test).ts'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/__tests__/integration/'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.mjs'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  roots: ['<rootDir>'],
  testTimeout: 10000,
  transformIgnorePatterns: [
    'node_modules/(?!(@modelcontextprotocol|zod)/)'
  ],
  resolver: 'ts-jest-resolver',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^(\\.\\.?\\/.+)\\.js$': '$1'
  }
};

module.exports = config;