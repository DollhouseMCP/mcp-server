#!/usr/bin/env node

/**
 * Test script for new configuration and sync tools
 * This tests the dollhouse_config and sync_portfolio MCP tools
 */

import { DollhouseMCPServer } from './dist/index.js';

async function testConfigTool() {
  console.log('\n=== Testing dollhouse_config Tool ===\n');
  
  const server = new DollhouseMCPServer();
  
  try {
    // Test 1: Get all config
    console.log('Test 1: Getting all configuration...');
    const allConfig = await server.handleConfigOperation({
      action: 'get'
    });
    console.log('✅ Get all config:', JSON.stringify(JSON.parse(allConfig), null, 2));
    
    // Test 2: Set a specific value
    console.log('\nTest 2: Setting sync.enabled to true...');
    const setResult = await server.handleConfigOperation({
      action: 'set',
      setting: 'sync.enabled',
      value: true
    });
    console.log('✅ Set result:', setResult);
    
    // Test 3: Get specific section
    console.log('\nTest 3: Getting sync section...');
    const syncConfig = await server.handleConfigOperation({
      action: 'get',
      section: 'sync'
    });
    console.log('✅ Sync config:', syncConfig);
    
    // Test 4: Reset section
    console.log('\nTest 4: Resetting sync section to defaults...');
    const resetResult = await server.handleConfigOperation({
      action: 'reset',
      section: 'sync'
    });
    console.log('✅ Reset result:', resetResult);
    
    // Test 5: Export config
    console.log('\nTest 5: Exporting configuration...');
    const exportResult = await server.handleConfigOperation({
      action: 'export',
      format: 'yaml'
    });
    console.log('✅ Exported config (first 200 chars):', exportResult.substring(0, 200) + '...');
    
  } catch (error) {
    console.error('❌ Config tool test failed:', error);
  }
}

async function testSyncTool() {
  console.log('\n=== Testing sync_portfolio Tool ===\n');
  
  const server = new DollhouseMCPServer();
  
  try {
    // Test 1: List remote (placeholder)
    console.log('Test 1: Listing remote portfolio...');
    const listResult = await server.handleSyncOperation({
      operation: 'list-remote'
    });
    console.log('✅ List remote result:', listResult);
    
    // Test 2: Compare element
    console.log('\nTest 2: Comparing element versions...');
    const compareResult = await server.handleSyncOperation({
      operation: 'compare',
      element_name: 'alex-sterling',
      element_type: 'personas'
    });
    console.log('✅ Compare result:', compareResult);
    
    // Test 3: Test privacy check on bulk upload
    console.log('\nTest 3: Testing bulk upload (should check privacy)...');
    const bulkResult = await server.handleSyncOperation({
      operation: 'bulk-upload',
      filter: { type: 'personas' }
    });
    console.log('✅ Bulk upload result:', bulkResult);
    
  } catch (error) {
    console.error('❌ Sync tool test failed:', error);
  }
}

async function main() {
  console.log('Starting Configuration and Sync Tools Test Suite');
  console.log('================================================\n');
  
  await testConfigTool();
  await testSyncTool();
  
  console.log('\n================================================');
  console.log('Test Suite Complete!');
  process.exit(0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});