/**
 * Global teardown for integration tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';

const TEST_BASE_DIR = path.join(process.cwd(), '.test-tmp');

export default async function globalTeardown() {
  console.log('\n🧹 Cleaning up integration test environment...\n');
  
  // Clean up test directories
  try {
    await fs.rm(TEST_BASE_DIR, { recursive: true, force: true });
    console.log('✅ Test directories cleaned up\n');
  } catch (error) {
    console.error('⚠️  Failed to clean up test directories:', error);
  }
  
  // Clear test environment variables
  delete process.env.TEST_MODE;
  delete process.env.TEST_BASE_DIR;
  delete process.env.TEST_PERSONAS_DIR;
  delete process.env.TEST_CACHE_DIR;
}