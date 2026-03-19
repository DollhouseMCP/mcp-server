import { jest } from '@jest/globals';

// Security test timeouts
jest.setTimeout(30000); // 30 seconds max per test

// Mock dangerous operations during tests
global.console.warn = jest.fn();
global.console.error = jest.fn();

// Ensure tests run in isolated environment
process.env.NODE_ENV = 'test';
process.env.SECURITY_TEST = 'true';

// Mock file system for security tests
jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises') as any;
  return {
    ...actual,
    unlink: jest.fn(),
    rmdir: jest.fn(),
    rm: jest.fn()
  };
});

// Export test utilities
export { SecurityTestFramework } from './framework/SecurityTestFramework.js';
export { RapidSecurityTesting } from './framework/RapidSecurityTesting.js';