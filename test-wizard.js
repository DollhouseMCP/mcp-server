#!/usr/bin/env node

// Test script to run the configuration wizard
const { ConfigManager } = require('./dist/config/ConfigManager.js');
const { ConfigWizard } = require('./dist/config/ConfigWizard.js');

async function main() {
  try {
    // Force reset for testing
    process.env.TEST_CONFIG_DIR = '/tmp/wizard-test-' + Date.now();
    
    const configManager = ConfigManager.getInstance();
    await configManager.initialize();
    
    const wizard = new ConfigWizard(configManager);
    
    // Force run the wizard
    console.log('\n🎯 Running Configuration Wizard (Force Mode)\n');
    await wizard.runWizard();
    
    wizard.close();
    console.log('\n✨ Wizard test complete!\n');
    
  } catch (error) {
    console.error('Error running wizard:', error);
    process.exit(1);
  }
}

main();