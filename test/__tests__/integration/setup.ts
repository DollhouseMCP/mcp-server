/**
 * Global setup for integration tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// Test directories
export const TEST_BASE_DIR = path.join(process.cwd(), '.test-tmp');
export const TEST_PERSONAS_DIR = path.join(TEST_BASE_DIR, 'personas');
export const TEST_CACHE_DIR = path.join(TEST_BASE_DIR, 'cache');

export default async function globalSetup() {
  console.log('\n🔧 Setting up integration test environment...\n');
  
  // Clean up any existing test directories
  try {
    await fs.rm(TEST_BASE_DIR, { recursive: true, force: true });
  } catch (error) {
    // Directory might not exist, that's fine
  }
  
  // Create fresh test directories
  await fs.mkdir(TEST_BASE_DIR, { recursive: true });
  await fs.mkdir(TEST_PERSONAS_DIR, { recursive: true });
  await fs.mkdir(TEST_CACHE_DIR, { recursive: true });
  
  // Set environment variables for tests
  process.env.TEST_MODE = 'integration';
  process.env.TEST_BASE_DIR = TEST_BASE_DIR;
  process.env.TEST_PERSONAS_DIR = TEST_PERSONAS_DIR;
  process.env.TEST_CACHE_DIR = TEST_CACHE_DIR;
  
  console.log(`✅ Test directories created at: ${TEST_BASE_DIR}`);
  console.log('✅ Integration test environment ready\n');
}