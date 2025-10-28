// Jest setup file for global test configuration
import { jest, afterEach } from '@jest/globals';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PERSONAS_DIR = 'test-personas';

// FIX: Global teardown handling to prevent Jest environment teardown errors
// This ensures all pending async operations complete before Jest tears down
// Using multiple approaches for robustness across platforms (especially Windows)
afterEach(async () => {
  // Multiple event loop flushes to ensure ALL pending operations complete
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  // Add a small delay to ensure file system operations complete (Windows needs this)
  await new Promise(resolve => setTimeout(resolve, 50));

  // Final flush
  await new Promise(resolve => setImmediate(resolve));
});

// Increase global test timeout to prevent premature teardown
// This is especially important for tests with file system operations
jest.setTimeout(30000); // 30 seconds