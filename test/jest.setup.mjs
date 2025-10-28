// Jest setup file for global test configuration
import { jest, afterEach } from '@jest/globals';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PERSONAS_DIR = 'test-personas';

// FIX: Global teardown handling to prevent Jest environment teardown errors
// This ensures all pending async operations complete before Jest tears down
afterEach(async () => {
  // Allow event loop to process all pending operations
  await new Promise(resolve => setImmediate(resolve));
});

// Increase global test timeout to prevent premature teardown
// This is especially important for tests with file system operations
jest.setTimeout(30000); // 30 seconds