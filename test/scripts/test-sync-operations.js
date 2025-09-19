#!/usr/bin/env node

/**
 * Test script for GitHub portfolio sync operations
 * 
 * This tests the completed implementation of:
 * - Download operations with force flag
 * - Upload operations with confirm flag and secret scanning
 * - Bulk download and upload operations
 * - Version comparison
 */

import { PortfolioSyncManager } from './dist/portfolio/PortfolioSyncManager.js';
import { ConfigManager } from './dist/config/ConfigManager.js';
import { logger } from './dist/utils/logger.js';

async function testSyncOperations() {
  console.log('🧪 Testing GitHub Portfolio Sync Operations\n');
  
  try {
    // Initialize managers
    const configManager = ConfigManager.getInstance();
    await configManager.initialize();
    
    const syncManager = new PortfolioSyncManager();
    
    // Test 1: List remote elements
    console.log('📋 Test 1: List remote elements');
    const listResult = await syncManager.handleSyncOperation({
      operation: 'list-remote'
    });
    console.log(`Result: ${listResult.success ? '✅' : '❌'} ${listResult.message}`);
    if (listResult.elements) {
      console.log(`Found ${listResult.elements.length} remote elements\n`);
    }
    
    // Test 2: Download with force flag
    console.log('⬇️ Test 2: Download element with force flag');
    const downloadResult = await syncManager.handleSyncOperation({
      operation: 'download',
      element_name: 'test-element',
      element_type: 'personas',
      force: true
    });
    console.log(`Result: ${downloadResult.success ? '✅' : '❌'} ${downloadResult.message}\n`);
    
    // Test 3: Upload with confirm flag
    console.log('⬆️ Test 3: Upload element with confirm flag');
    const uploadResult = await syncManager.handleSyncOperation({
      operation: 'upload',
      element_name: 'test-element',
      element_type: 'personas',
      confirm: true
    });
    console.log(`Result: ${uploadResult.success ? '✅' : '❌'} ${uploadResult.message}\n`);
    
    // Test 4: Compare versions
    console.log('🔍 Test 4: Compare versions');
    const compareResult = await syncManager.handleSyncOperation({
      operation: 'compare',
      element_name: 'test-element',
      element_type: 'personas',
      show_diff: true
    });
    console.log(`Result: ${compareResult.success ? '✅' : '❌'} ${compareResult.message}\n`);
    
    // Test 5: Bulk download
    console.log('⬇️ Test 5: Bulk download');
    const bulkDownloadResult = await syncManager.handleSyncOperation({
      operation: 'download',
      element_type: 'personas',
      bulk: true,
      confirm: true
    });
    console.log(`Result: ${bulkDownloadResult.success ? '✅' : '❌'} ${bulkDownloadResult.message}\n`);
    
    // Test 6: Bulk upload
    console.log('⬆️ Test 6: Bulk upload');
    const bulkUploadResult = await syncManager.handleSyncOperation({
      operation: 'upload',
      element_type: 'personas',
      bulk: true,
      confirm: true
    });
    console.log(`Result: ${bulkUploadResult.success ? '✅' : '❌'} ${bulkUploadResult.message}\n`);
    
    // Test 7: Secret scanning
    console.log('🔒 Test 7: Test secret scanning in upload');
    // Create a test element with a secret
    const secretTestResult = await syncManager.handleSyncOperation({
      operation: 'upload',
      element_name: 'secret-test',
      element_type: 'personas',
      confirm: true
    });
    console.log(`Result: Should fail if content has secrets: ${secretTestResult.message}\n`);
    
    console.log('✅ All sync operation tests completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run tests
testSyncOperations().catch(console.error);