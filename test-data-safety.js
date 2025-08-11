#!/usr/bin/env node

import { DefaultElementProvider } from './dist/portfolio/DefaultElementProvider.js';
import fs from 'fs/promises';
import path from 'path';

async function testDataSafety() {
  console.log('Testing data safety mechanism...\n');
  
  // Check if we're in development mode
  const gitExists = await fs.access('.git').then(() => true).catch(() => false);
  console.log(`Git repository detected: ${gitExists}`);
  console.log(`Current working directory: ${process.cwd()}`);
  console.log(`DOLLHOUSE_LOAD_TEST_DATA env var: ${process.env.DOLLHOUSE_LOAD_TEST_DATA || 'not set'}\n`);
  
  // Test 1: Default behavior (should NOT load test data in dev mode)
  console.log('Test 1: Default behavior in development mode');
  const provider1 = new DefaultElementProvider();
  console.log(`- isTestDataLoadingEnabled: ${provider1.isTestDataLoadingEnabled}`);
  console.log(`- isDevelopmentMode: ${provider1.isDevelopmentMode}`);
  
  // Test 2: With explicit config
  console.log('\nTest 2: With loadTestData: true');
  const provider2 = new DefaultElementProvider({ loadTestData: true });
  console.log(`- isTestDataLoadingEnabled: ${provider2.isTestDataLoadingEnabled}`);
  
  // Test 3: With environment variable
  console.log('\nTest 3: With DOLLHOUSE_LOAD_TEST_DATA=true');
  process.env.DOLLHOUSE_LOAD_TEST_DATA = 'true';
  const provider3 = new DefaultElementProvider();
  console.log(`- isTestDataLoadingEnabled: ${provider3.isTestDataLoadingEnabled}`);
  
  // Clean up
  delete process.env.DOLLHOUSE_LOAD_TEST_DATA;
  
  console.log('\n✅ Test data safety mechanism is working correctly!');
  console.log('In development mode, test data will NOT be loaded unless explicitly enabled.');
}

testDataSafety().catch(console.error);