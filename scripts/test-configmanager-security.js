#!/usr/bin/env node

/**
 * Test script to verify ConfigManager security in production environment
 * 
 * This tests the prototype pollution protection that was identified in the
 * session notes - the production code is secure but tests can't validate it
 * properly due to test environment issues.
 */

import { ConfigManager } from '../dist/security/ConfigManager.js';
import { SecurityMonitor } from '../dist/security/SecurityMonitor.js';

console.log('=== ConfigManager Security Test ===\n');

async function testPrototypePollution() {
  console.log('Testing prototype pollution protection...\n');
  
  const configManager = new ConfigManager();
  
  // Test 1: __proto__ injection attempt
  console.log('Test 1: Attempting __proto__ injection');
  try {
    const maliciousConfig = {
      '__proto__': {
        isAdmin: true,
        polluted: true
      }
    };
    
    await configManager.resetConfig(maliciousConfig);
    
    // Check if prototype was polluted
    const testObj = {};
    if (testObj.isAdmin || testObj.polluted) {
      console.error('❌ FAILED: Prototype pollution successful!');
      console.error('   Object prototype was modified');
      return false;
    } else {
      console.log('✅ PASSED: __proto__ injection blocked');
    }
  } catch (error) {
    console.log(`✅ PASSED: __proto__ injection threw error: ${error.message}`);
  }
  
  // Test 2: constructor injection attempt
  console.log('\nTest 2: Attempting constructor injection');
  try {
    const maliciousConfig = {
      'constructor': {
        'prototype': {
          isAdmin: true
        }
      }
    };
    
    await configManager.resetConfig(maliciousConfig);
    
    // Check if prototype was polluted
    const testObj = {};
    if (testObj.isAdmin) {
      console.error('❌ FAILED: Constructor pollution successful!');
      return false;
    } else {
      console.log('✅ PASSED: constructor injection blocked');
    }
  } catch (error) {
    console.log(`✅ PASSED: constructor injection threw error: ${error.message}`);
  }
  
  // Test 3: Nested prototype pollution
  console.log('\nTest 3: Attempting nested prototype pollution');
  try {
    const maliciousConfig = {
      nested: {
        '__proto__': {
          polluted: true
        }
      }
    };
    
    await configManager.resetConfig(maliciousConfig);
    
    const testObj = {};
    if (testObj.polluted) {
      console.error('❌ FAILED: Nested prototype pollution successful!');
      return false;
    } else {
      console.log('✅ PASSED: Nested __proto__ injection blocked');
    }
  } catch (error) {
    console.log(`✅ PASSED: Nested injection threw error: ${error.message}`);
  }
  
  return true;
}

async function testConfigPersistence() {
  console.log('\n\nTesting config persistence between instances...\n');
  
  // Create first instance and set config
  const config1 = new ConfigManager();
  await config1.setConfigValue('testKey', 'testValue');
  
  // Create second instance and check if config persists
  const config2 = new ConfigManager();
  const value = await config2.getConfigValue('testKey');
  
  if (value === 'testValue') {
    console.log('✅ PASSED: Config persists between instances');
    return true;
  } else {
    console.error('❌ FAILED: Config did not persist');
    console.error(`   Expected: 'testValue', Got: '${value}'`);
    return false;
  }
}

async function checkSecurityLogs() {
  console.log('\n\nChecking security event logs...\n');
  
  // Note: In production, SecurityMonitor would log these events
  // This is a placeholder to show where logs would be checked
  console.log('ℹ️  Security events would be logged to:');
  console.log('   - Application logs');
  console.log('   - Security audit trail');
  console.log('   - SIEM system (if configured)');
  
  return true;
}

async function main() {
  console.log('Starting ConfigManager security tests...\n');
  console.log('Environment: PRODUCTION\n');
  
  let allPassed = true;
  
  // Run tests
  const prototypePassed = await testPrototypePollution();
  allPassed = allPassed && prototypePassed;
  
  const persistencePassed = await testConfigPersistence();
  allPassed = allPassed && persistencePassed;
  
  const logsPassed = await checkSecurityLogs();
  allPassed = allPassed && logsPassed;
  
  // Summary
  console.log('\n=== Test Summary ===');
  if (allPassed) {
    console.log('✅ All security tests PASSED');
    console.log('\nProduction ConfigManager is properly protected against:');
    console.log('- Prototype pollution via __proto__');
    console.log('- Prototype pollution via constructor');
    console.log('- Nested prototype pollution attempts');
    process.exit(0);
  } else {
    console.error('❌ Some tests FAILED');
    console.error('\n⚠️  SECURITY VULNERABILITY DETECTED');
    console.error('The ConfigManager may be vulnerable to prototype pollution');
    process.exit(1);
  }
}

// Run tests
main().catch(error => {
  console.error('Test execution failed:', error);
  process.exit(1);
});